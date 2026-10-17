/**
 * `dify-node` subagent provider — the extension that gives the existing
 * workflow orchestration loop Dify's node capabilities.
 *
 * The workflow engine calls every node as `agent(prompt, opts)`; the engine's
 * subagent provider is fixed per run, so this provider receives one JSON node
 * request per call and dispatches by `kind`:
 *
 *   code                 → ctx.sandbox.confine (landlock/bwrap); Python trampoline child
 *   llm                  → ctx.llm.stream (the harness's own provider-neutral LLM service)
 *   if-else              → local condition evaluation, no host capability needed
 *   question-classifier  → ctx.llm.stream; the answer maps back to a declared class id
 *   http-request         → ctx.web.fetch for plain GET; otherwise ctx.sandbox.confine + curl
 *   tool                 → ctx.tools.execute on an allowlisted harness tool
 *   knowledge-retrieval  → ctx.tools.execute('grep') over a local dataset directory
 *
 * No process isolation, no LLM adapter, no HTTP client, and no scheduler live
 * here: this is a capability provider for the documented subagent seam. Model
 * routing never invents an HTTP client; it picks a route the mounted `llm`
 * service actually exposes (falling back to the profile's default model when
 * the DSL names a provider this deployment does not have).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import Ajv from 'ajv'
import { basename, extname, isAbsolute, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMemoryWindow, deriveChatHistory, memoryOptions, toPromptText } from './session-history.js'
import { renderJinja } from './jinja.js'
import { createToolRegistry, executeContract } from './tool-contracts.js'

/**
 * Read the conversation history from a live harness session.
 *
 * A session is the harness's conversation store, so a Dify `memory.window` node
 * can be fed from it directly instead of from a Dify-style Message table. When
 * the run has no session (an offline/one-shot caller) there is no history and
 * the LLM node behaves exactly as before.
 *
 * @param session - `request.parent.session`, if the caller supplied one.
 * @returns ordered `[{ role, content }]`, or `[]` when unavailable.
 */
function readSessionHistory(session) {
  try {
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return []
    return deriveChatHistory(session.deriveMessages())
  } catch {
    // History is an enrichment: a log that cannot be read must not fail the node.
    return []
  }
}

/** The Python trampoline: define Dify's `main`, feed it the node inputs, emit JSON. */
const PY_WRAPPER = `
import json, sys, traceback
payload = json.load(sys.stdin)
scope = {'__name__': '__dify_node__'}
result = {'ok': False}
try:
    exec(compile(payload['code'], '<dify-code>', 'exec'), scope, scope)
    fn = scope.get('main')
    if not callable(fn):
        raise TypeError('code node does not define main(...)')
    outputs = fn(**payload.get('inputs', {}))
    if outputs is None:
        outputs = {}
    if not isinstance(outputs, dict):
        raise TypeError('main() must return a dict, got ' + type(outputs).__name__)
    result = {'ok': True, 'outputs': outputs}
except Exception as exc:
    result = {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc), 'traceback': traceback.format_exc()[-4000:]}
print(json.dumps(result, ensure_ascii=False, default=str))
`

function promptText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    return prompt
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
  }
  return ''
}

function killTree(child) {
  try {
    child.kill('SIGKILL')
  } catch {
    // already gone
  }
}

/**
 * Make the Python packages a code node declares in `dependencies` importable.
 *
 * Dify ships a curated set of packages inside its own sandbox image; this
 * runtime has no image to curate, so it installs on demand into the plugin's
 * vendor directory — the same mechanism the shipped `json_repair` already uses.
 * `pip --target` does the resolution and download; nothing here reinvents it.
 *
 * Idempotent: a package already importable from the vendor directory is skipped,
 * so a repeated run costs one interpreter start, not a download.
 *
 * @param env - provider options carrying `python`, `pythonPath`, `vendorDir`.
 * @param dependencies - package specs exactly as the DSL wrote them.
 * @param signal - cancellation signal from the node request.
 * @returns `{ ok: true }` once every package imports, else `{ ok: false, error }`.
 */
async function ensurePythonDependencies(env, dependencies, signal) {
  const vendorDir = env.vendorDir
  if (vendorDir === undefined || vendorDir.length === 0) {
    return {
      ok: false,
      error: `no vendor directory to install into (set DSH_DIFY_RUNTIME_ROOT or DIFY_VENDOR_DIR)`,
    }
  }
  const specs = dependencies.map((item) => String(item).trim()).filter((item) => item.length > 0)
  if (specs.length === 0) return { ok: true }
  // A declared spec may carry a version pin (`pandas==2.2.0`); the import name is
  // the part before any of pip's requirement operators.
  const importName = (spec) => String(spec).split(/[<>=!~[;\s]/)[0].replace(/-/g, '_')
  const probe = ['-c', `import ${specs.map(importName).join(', ')}`]
  const probeEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  if (vendorDir.length > 0) probeEnv.PYTHONPATH = [vendorDir, env.pythonPath].filter(Boolean).join(':')
  const already = await runChild([env.python, ...probe], {
    cwd: vendorDir,
    env: probeEnv,
    input: '',
    timeoutMs: 20_000,
    signal,
  })
  if (already.code === 0) return { ok: true }

  const proc = await runChild(
    [env.python, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', vendorDir, ...specs],
    { cwd: vendorDir, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, input: '', timeoutMs: 180_000, signal },
  )
  if (proc.spawnError) return { ok: false, error: `cannot start pip: ${proc.spawnError}` }
  if (proc.timedOut) return { ok: false, error: `pip install timed out for ${specs.join(', ')}` }
  if (proc.aborted) return { ok: false, error: `pip install cancelled for ${specs.join(', ')}` }
  if (proc.code !== 0) {
    return { ok: false, error: `pip install failed for ${specs.join(', ')}: ${(proc.stderr || proc.stdout).slice(-1500)}` }
  }
  const after = await runChild([env.python, ...probe], {
    cwd: vendorDir,
    env: probeEnv,
    input: '',
    timeoutMs: 20_000,
    signal,
  })
  if (after.code !== 0) {
    return { ok: false, error: `installed ${specs.join(', ')} but they still do not import: ${after.stderr.slice(-800)}` }
  }
  return { ok: true }
}

/** Run one confined child, capture stdio, and settle with its result. */function runChild(argv, { cwd, env, input, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', spawnError: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ code: -1, stdout, stderr, timedOut: true })
    }, timeoutMs)
    const onAbort = () => {
      killTree(child)
      finish({ code: -1, stdout, stderr, aborted: true })
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 4 * 1024 * 1024) killTree(child)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr, spawnError: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * Build the `dify-node` provider bound to one harness context.
 * @param ctx - Cordis context carrying `sandbox`, `llm`, and `agentDefaultModel`.
 * @param options - runtime paths and an optional explicit LLM route.
 * @returns the provider object accepted by `ctx.subagents.registerProvider`.
 */
export function createDifyNodeProvider(ctx, options = {}) {
  const python = options.python ?? process.env.DIFY_RUNTIME_PYTHON ?? 'python3'
  const pythonPath = options.pythonPath ?? process.env.DIFY_PYTHONPATH ?? ''
  // Where `dependencies` are installed. Defaults to the vendor directory the
  // shipped Python packages already live in, so there is one import root.
  const vendorDir = options.vendorDir ?? process.env.DIFY_VENDOR_DIR ?? pythonPath
  const llmProvider = options.llmProvider ?? process.env.DIFY_LLM_PROVIDER ?? ''
  const llmModel = options.llmModel ?? process.env.DIFY_LLM_MODEL ?? ''
  const knowledgeRoot = options.knowledgeRoot ?? process.env.DIFY_KNOWLEDGE_ROOT ?? ''
  const documentRoot = options.documentRoot ?? process.env.DIFY_DOCUMENT_ROOT ?? ''
  const toolAllow = options.toolAllow ?? process.env.DIFY_TOOL_ALLOW ?? ''
  // Declarative tool contracts: directories scanned for provider/tool YAML.
  const toolRoots = options.toolRoots ?? (process.env.DIFY_TOOLS_ROOT ?? '').split(':').filter((item) => item.length > 0)
  const toolRegistry = options.toolRegistry ?? createToolRegistry(toolRoots)
  // Exact harness-tool names a workflow may call directly (opt-in passthrough).
  const toolPassthrough = options.toolPassthrough ?? process.env.DIFY_TOOL_PASSTHROUGH ?? ''

  return {
    name: options.name ?? 'dify-node',
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    /**
     * Execute one node request. Node-level failures resolve as a completed run
     * whose JSON payload carries `ok: false`, so the compiled script can report
     * the failing Dify node instead of a generic engine error.
     * @param request - the subagent start request; `prompt` carries the JSON node spec.
     * @returns a published one-shot run handle.
     */
    async start(request) {
      const runId = `dify-node-${randomUUID()}`
      const settled = (async () => {
        const startedAt = Date.now()
        let spec
        try {
          spec = JSON.parse(promptText(request.prompt))
        } catch (error) {
          return {
            output: [{ type: 'text', text: JSON.stringify({ ok: false, error: `bad node request: ${error.message}` }) }],
            stopReason: 'completed',
          }
        }
        let payload
        try {
          payload = await executeSpec(ctx, spec, request, {
            python,
            pythonPath,
            vendorDir,
            llmProvider,
            llmModel,
            knowledgeRoot,
            documentRoot,
            toolAllow,
            toolRegistry,
            toolPassthrough,
          })
        } catch (error) {
          payload = { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` }
        }
        payload.kind = spec.kind
        payload.title = spec.title ?? ''
        payload.durationMs = Date.now() - startedAt
        return {
          output: [{ type: 'text', text: JSON.stringify(payload) }],
          stopReason: 'completed',
        }
      })()
      return {
        id: runId,
        localAgent: undefined,
        result: settled,
        async dispose() {
          await settled.catch(() => {})
        },
      }
    },
  }
}

/** Dispatch one node spec to its capability. */
async function executeSpec(ctx, spec, request, env) {
  if (spec.kind === 'code') return executeCode(ctx, spec, request, env)
  if (spec.kind === 'llm') return executeLlm(ctx, spec, request, env)
  if (spec.kind === 'if-else') return executeIfElse(spec)
  if (spec.kind === 'question-classifier') return executeClassifier(ctx, spec, request, env)
  if (spec.kind === 'http-request') return executeHttp(ctx, spec, request, env)
  if (spec.kind === 'tool') return executeTool(ctx, spec, request, env)
  if (spec.kind === 'knowledge-retrieval') return executeKnowledge(ctx, spec, request, env)
  if (spec.kind === 'agent') return executeAgent(ctx, spec, request, env)
  if (spec.kind === 'parameter-extractor') return executeParameterExtractor(ctx, spec, request, env)
  if (spec.kind === 'document-extractor') return executeDocumentExtractor(ctx, spec, request, env)
  if (spec.kind === 'datasource') return executeDatasource(ctx, spec, request, env)
  if (spec.kind === 'knowledge-index') return executeKnowledgeIndex(ctx, spec, request, env)
  if (spec.kind === 'human-input') return executeHumanInput(spec)
  if (spec.kind === 'template-transform') return executeTemplateJinja(spec)
  return { ok: false, error: `unsupported node kind "${spec.kind}"` }
}

/**
 * Dify `template-transform` with Jinja2.
 *
 * The compiler has already resolved `{{#node.var#}}` selectors and passed the
 * resulting values as `spec.context`; what remains is Jinja2, rendered here by
 * nunjucks. An unrenderable template is the author's mistake, so the node fails
 * with the construct and its line — never a silent pass-through of raw text.
 */
function executeTemplateJinja(spec) {
  const result = renderJinja(spec.template ?? '', spec.context ?? {})
  if (!result.ok) {
    return { ok: false, error: `template-transform ${spec.nodeId}: invalid Jinja2 template — ${result.error}` }
  }
  return { ok: true, outputs: { output: result.text, text: result.text }, meta: { engine: 'nunjucks' } }
}

/** Run a Dify code node under the harness's own confinement. */
async function executeCode(ctx, spec, request, env) {
  const sandbox = typeof ctx.get === 'function' ? ctx.get('sandbox') : undefined
  if (sandbox === undefined || typeof sandbox.confine !== 'function') {
    return { ok: false, error: 'ctx.sandbox is unavailable; refusing to run the code node unconfined' }
  }
  const language = String(spec.codeLanguage ?? 'python3').toLowerCase()
  const isPython = language === 'python3' || language === 'python'
  const isJavaScript = language === 'javascript' || language === 'nodejs' || language === 'js'
  if (!isPython && !isJavaScript) {
    // Parse-level support is unconditional; this is the honest execution limit.
    return {
      ok: false,
      error: `code_language "${language}" is parsed and scheduled, but this runtime executes only python3 and javascript`,
    }
  }
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  if (!existsSync(workspaceRoot)) return { ok: false, error: `workspace root does not exist: ${workspaceRoot}` }
  const policy = {
    mode: spec.mode ?? 'workspace-write',
    workspaceRoot,
    ...(request.parent?.session?.id !== undefined ? { sessionId: request.parent.session.id } : {}),
  }
  const argv = isPython
    ? [env.python, '-c', PY_WRAPPER]
    : ['node', '-e', jsProgram(String(spec.code ?? ''))]
  let confined
  try {
    confined = await sandbox.confine(argv, policy)
  } catch (error) {
    return { ok: false, error: `sandbox refused the code node (${error?.code ?? error?.name ?? 'error'}): ${error?.message ?? String(error)}` }
  }
  const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  if (env.pythonPath) childEnv.PYTHONPATH = [env.pythonPath, childEnv.PYTHONPATH].filter(Boolean).join(':')
  for (const [key, value] of Object.entries(spec.env ?? {})) childEnv[key] = String(value)
  // Dify's `dependencies`: packages the node declares it imports. They are
  // installed into the plugin's own vendor directory (the same place the
  // shipped `json_repair` lives), so the confined child finds them through
  // PYTHONPATH without touching the system interpreter.
  if (isPython && Array.isArray(spec.dependencies) && spec.dependencies.length > 0) {
    const resolved = await ensurePythonDependencies(env, spec.dependencies, request.signal)
    if (!resolved.ok) {
      return { ok: false, error: `code node ${spec.nodeId} dependencies: ${resolved.error}` }
    }
    if (env.pythonPath) childEnv.PYTHONPATH = [env.pythonPath, childEnv.PYTHONPATH].filter(Boolean).join(':')
  }
  const proc = await runChild(confined.argv, {
    cwd: workspaceRoot,
    env: childEnv,
    input: JSON.stringify({ code: spec.code, inputs: spec.inputs ?? {} }),
    timeoutMs: Number(spec.timeoutMs ?? 120_000),
    signal: request.signal,
  })
  if (proc.spawnError) return { ok: false, error: `cannot start confined ${isPython ? 'python' : 'node'}: ${proc.spawnError}` }
  if (proc.timedOut) return { ok: false, error: `code node timed out after ${spec.timeoutMs}ms` }
  if (proc.aborted) return { ok: false, error: 'code node cancelled' }
  let parsed
  try {
    parsed = JSON.parse(proc.stdout)
  } catch {
    return {
      ok: false,
      error: `code node exited ${proc.code} without a JSON result`,
      stderr: proc.stderr.slice(-2000),
      stdout: proc.stdout.slice(-2000),
    }
  }
  parsed.exitCode = proc.code
  parsed.enforcement = confined.enforcement
  parsed.backendArgv0 = confined.argv[0]
  if (proc.code !== 0 && parsed.ok) parsed.ok = false
  if (proc.stderr) parsed.stderr = proc.stderr.slice(-2000)
  return parsed
}

/**
 * Choose a route the mounted `llm` service can actually serve.
 * Priority: an explicit plugin route, the DSL route when this deployment has
 * that provider, then the profile's default model.
 */
function resolveRoute(ctx, spec, env) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('ctx.llm is unavailable in this profile')
  }
  let registered = []
  try {
    registered = (llm.listProviders?.() ?? []).map((provider) => provider.id)
  } catch {
    registered = []
  }
  const available = (provider) => registered.length === 0 || registered.includes(provider)
  const explicit =
    env.llmProvider && env.llmModel ? { provider: env.llmProvider, model: env.llmModel, source: 'plugin-config' } : undefined
  const declared = spec.provider && spec.model ? { provider: spec.provider, model: spec.model } : undefined
  if (explicit && available(explicit.provider)) return explicit
  if (declared && available(declared.provider)) return { ...declared, source: 'dsl' }
  let fallback
  try {
    fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  } catch {
    fallback = undefined
  }
  if (fallback?.provider && fallback?.model && available(fallback.provider)) {
    return { provider: fallback.provider, model: fallback.model, source: 'profile-default' }
  }
  if (declared) return { ...declared, source: 'dsl-unverified' }
  throw new Error('no usable LLM route: the DSL names no model and the profile exposes no default')
}

/**
 * Run one model call through the harness LLM service and collect its text.
 * Shared by the `llm` and `question-classifier` nodes so routing, usage, and
 * failure handling have one implementation.
 */
async function streamLlm(ctx, request, route, { messages, system, temperature, maxTokens, note }) {
  const llm = ctx.get('llm')
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    ...(typeof system === 'string' && system.length > 0 ? { system } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
    ...(request.parent?.session?.id !== undefined ? { sessionId: request.parent.session.id } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  }
  let text = ''
  let reasoning = ''
  let usage
  let finish
  for await (const chunk of llm.stream(options)) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    return { ok: false, error: `model call ${finish.kind}: ${finish.failure?.message ?? 'model call failed'}` }
  }
  return { ok: true, text, reasoning, usage: usage ?? {}, finish: finish?.kind ?? 'stop', note }
}

/** Call one Dify LLM node through the harness LLM service. */
async function executeLlm(ctx, spec, request, env) {
  const route = resolveRoute(ctx, spec, env)
  const prompt = Array.isArray(spec.prompt) ? spec.prompt : []
  const system = prompt
    .filter((item) => item.role === 'system')
    .map((item) => String(item.text ?? ''))
    .filter((text) => text.length > 0)
    .join('\n\n')
  const messages = prompt
    .filter((item) => item.role !== 'system')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: String(item.text ?? '') }],
    }))
  // Dify memory: prepend the conversation history from the harness session log
  // when the node enables `memory.window`. The history is agent-context, not a
  // conversation store: a run without a session simply gets no history.
  const memory = memoryOptions(spec.memory)
  let memoryMeta
  if (memory.enabled) {
    const history = applyMemoryWindow(readSessionHistory(request.parent?.session), memory)
    if (history.length > 0) {
      const rendered = toPromptText(history, memory.rolePrefix)
      messages.unshift({ role: 'user', content: [{ type: 'text', text: `Conversation history:\n${rendered}` }] })
    }
    memoryMeta = { enabled: true, size: memory.size, historyMessages: history.length }
  }
  let note
  if (messages.length === 0) {
    // Dify allows a system-only prompt; some OpenAI-compatible gateways reject
    // a request whose only turn is `system`, so add a neutral user turn.
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'Follow the system instruction and produce the requested output.' }],
    })
    note = 'added neutral user turn for system-only prompt'
  }
  const call = await streamLlm(ctx, request, route, {
    messages,
    system,
    temperature: spec.temperature,
    maxTokens: spec.maxTokens,
    note,
  })
  if (!call.ok) return { ok: false, error: `llm node ${spec.nodeId} ${call.error}` }
  if (call.text.length === 0 && call.reasoning.length === 0) {
    return { ok: false, error: `llm node ${spec.nodeId} produced no text (route ${route.provider}/${route.model})` }
  }
  // Dify `structured_output`: the node's `text` output is a JSON document that
  // must satisfy the declared schema. A violation is retried once with the
  // validator's complaint appended, then reported — never silently passed on.
  let structuredMeta
  let finalText = call.text
  if (spec.structuredOutput?.enabled === true && spec.structuredOutput.schema !== undefined) {
    const checked = await enforceStructuredOutput(ctx, request, route, spec, {
      messages,
      system,
      temperature: spec.temperature,
      maxTokens: spec.maxTokens,
      note,
      text: call.text,
    })
    if (!checked.ok) return { ok: false, error: `llm node ${spec.nodeId} structured_output: ${checked.error}` }
    finalText = checked.text
    structuredMeta = checked.meta
  }
  return {
    ok: true,
    outputs: { text: finalText, usage: call.usage, reasoning_content: call.reasoning },
    meta: {
      provider: route.provider,
      model: route.model,
      requested: spec.provider && spec.model ? `${spec.provider}/${spec.model}` : '',
      routeSource: route.source,
      finish: call.finish,
      ...(memoryMeta !== undefined ? { memory: memoryMeta } : {}),
      ...(call.note !== undefined ? { adapterNote: call.note } : {}),
      ...(structuredMeta !== undefined ? { structuredOutput: structuredMeta } : {}),
    },
  }
}

/**
 * Enforce Dify's `structured_output` contract around one LLM answer.
 *
 * The host `GenerateOptions` has no response_format / json_schema field, so the
 * constraint is expressed in the conversation (an instruction plus the schema)
 * and verified with `ajv` — the validator dsh already ships, so no new
 * dependency. One repair round is attempted; a second failure is reported.
 *
 * @returns `{ ok: true, text, meta }` with the validated JSON text, or
 *          `{ ok: false, error }` describing why the contract could not be met.
 */
async function enforceStructuredOutput(ctx, request, route, spec, initial) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  let validate
  try {
    validate = ajv.compile(spec.structuredOutput.schema)
  } catch (error) {
    return { ok: false, error: `declared schema is not valid JSON Schema: ${error?.message ?? String(error)}` }
  }
  const describe = (errors) =>
    (errors ?? []).slice(0, 5).map((item) => `${item.instancePath || '/'} ${item.message}`).join('; ')
  const instruction = {
    role: 'system',
    content: [
      {
        type: 'text',
        text:
          'Reply with a single JSON document and nothing else — no prose, no markdown fences.\n' +
          `The document MUST validate against this JSON Schema:\n${JSON.stringify(spec.structuredOutput.schema)}`,
      },
    ],
  }
  const attempt = async (text) => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { ok: false, reason: `answer is not valid JSON: ${error?.message ?? String(error)}` }
    }
    if (!validate(parsed)) return { ok: false, reason: `answer does not match the schema: ${describe(validate.errors)}` }
    return { ok: true, text: JSON.stringify(parsed) }
  }
  const first = await attempt(initial.text)
  if (first.ok) return { ok: true, text: first.text, meta: { validated: true, repaired: false } }

  const repairMessages = [
    instruction,
    ...initial.messages,
    { role: 'assistant', content: [{ type: 'text', text: initial.text }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `That reply broke the required schema (${first.reason}). Reply again with only the corrected JSON document.`,
        },
      ],
    },
  ]
  const retry = await streamLlm(ctx, request, route, {
    messages: repairMessages,
    system: initial.system,
    temperature: initial.temperature,
    maxTokens: initial.maxTokens,
    note: initial.note,
  })
  if (!retry.ok) return { ok: false, error: `repair round failed: ${retry.error}` }
  const second = await attempt(retry.text)
  if (second.ok) return { ok: true, text: second.text, meta: { validated: true, repaired: true } }
  return { ok: false, error: `no schema-valid JSON after one repair round (${first.reason}; then ${second.reason})` }
}

/**
 * Dify question-classifier: ask the model for one declared class name, then let
 * THIS code map the answer back to the class id that names the outgoing edge.
 * The model never picks an edge; an unknown or ambiguous answer fails closed.
 */
async function executeClassifier(ctx, spec, request, env) {
  // `id` is optional in Dify exports: keep it missing instead of substituting the
  // name (or the index). class_id is then '', and the compiled script routes on
  // class_name — the value the DSL's edges were actually drawn with.
  const classes = (Array.isArray(spec.classes) ? spec.classes : [])
    .map((item) => ({
      id: item?.id !== undefined && item?.id !== null ? String(item.id) : '',
      name: String(item?.name ?? ''),
    }))
    .filter((item) => item.name.length > 0)
  if (classes.length === 0) return { ok: false, error: `question-classifier ${spec.nodeId} has no classes` }
  const route = resolveRoute(ctx, spec, env)
  const query = stringify(spec.query)
  const instruction = String(spec.instruction ?? '').trim() || 'Classify the input into exactly one class.'
  const prompt = [
    instruction,
    '',
    'Classes:',
    ...classes.map((item, index) => `${index + 1}. ${item.name}`),
    '',
    'Input:',
    query,
    '',
    'Reply with exactly one class name from the list, copied verbatim. No explanation, no quotes, no extra text.',
  ].join('\n')
  const call = await streamLlm(ctx, request, route, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: typeof spec.temperature === 'number' ? spec.temperature : 0,
    maxTokens: typeof spec.maxTokens === 'number' ? spec.maxTokens : 128,
  })
  if (!call.ok) return { ok: false, error: `question-classifier ${spec.nodeId} ${call.error}` }
  const raw = call.text.trim()
  if (raw.length === 0) return { ok: false, error: `question-classifier ${spec.nodeId} produced no text` }
  let cleaned = raw.replace(/^```(?:json|text)?\s*/i, '').replace(/```$/i, '').trim()
  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  let fromJson
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed != null && typeof parsed === 'object') {
      fromJson = parsed.class ?? parsed.class_name ?? parsed.label ?? parsed.name ?? parsed.id
    }
  } catch {
    fromJson = undefined
  }
  const candidates = [cleaned, fromJson == null ? undefined : String(fromJson).trim()].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  let matches = []
  for (const candidate of candidates) {
    const exact = classes.filter(
      (item) =>
        item.name.toLowerCase() === candidate.toLowerCase() ||
        (item.id.length > 0 && item.id.toLowerCase() === candidate.toLowerCase()),
    )
    if (exact.length > 0) {
      matches = exact
      break
    }
  }
  if (matches.length === 0) {
    for (const candidate of candidates) {
      const numeric = /^(?:class\s*)?(\d+)(?:[.、)]|\s|$)/i.exec(candidate)
      if (numeric !== null) {
        const index = Number(numeric[1]) - 1
        if (index >= 0 && index < classes.length) {
          matches = [classes[index]]
          break
        }
      }
    }
  }
  if (matches.length === 0) {
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase()
      const contained = classes.filter((item) => lower.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(lower))
      if (contained.length === 1) {
        matches = contained
        break
      }
      if (contained.length > 1) {
        return {
          ok: false,
          error: `question-classifier ${spec.nodeId} answer "${raw}" is ambiguous (${contained.map((c) => c.name).join(', ')})`,
        }
      }
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error: `question-classifier ${spec.nodeId} answer "${raw}" matches no declared class (${classes.map((c) => c.name).join(', ')})`,
    }
  }
  const match = matches[0]
  return {
    ok: true,
    outputs: { class_name: match.name, class_id: match.id, raw },
    meta: {
      provider: route.provider,
      model: route.model,
      requested: spec.provider && spec.model ? `${spec.provider}/${spec.model}` : '',
      routeSource: route.source,
      classes: classes.map((c) => c.name),
    },
  }
}

function isEmptyValue(value) {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function asNumber(value) {
  if (typeof value === 'boolean') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringify(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Evaluate one Dify if-else condition. */
function evaluateCondition(condition, inputs) {
  const selector = condition?.variable_selector ?? []
  const key = `${selector[0]}.${selector[1]}`
  const left = inputs[key] ?? inputs[selector[1]]
  const op = String(condition?.comparison_operator ?? '=').trim()
  const right = condition?.value
  const varType = condition?.varType
  if (op === 'empty') return isEmptyValue(left)
  if (op === 'not empty') return !isEmptyValue(left)
  if (op === 'null') return left === undefined || left === null
  if (op === 'not null') return left !== undefined && left !== null

  const numericOps = new Set(['>', '<', '≥', '≤', '>=', '<=', '=', '==', 'is', '≠', '!='])
  if (numericOps.has(op) || varType === 'number') {
    const a = asNumber(left)
    const b = asNumber(right)
    if (a !== undefined && b !== undefined) {
      if (op === '=' || op === '==' || op === 'is') return a === b
      if (op === '≠' || op === '!=' || op === 'is not') return a !== b
      if (op === '>') return a > b
      if (op === '<') return a < b
      if (op === '≥' || op === '>=') return a >= b
      if (op === '≤' || op === '<=') return a <= b
    }
  }
  const ls = stringify(left)
  const rs = stringify(right)
  switch (op) {
    case '=':
    case '==':
    case 'is':
      return ls === rs
    case '≠':
    case '!=':
    case 'is not':
      return ls !== rs
    case 'contains':
      return ls.includes(rs)
    case 'not contains':
      return !ls.includes(rs)
    case 'start with':
      return ls.startsWith(rs)
    case 'end with':
      return ls.endsWith(rs)
    case 'in':
      return (Array.isArray(right) ? right : [right]).map(stringify).includes(ls)
    case 'not in':
      return !(Array.isArray(right) ? right : [right]).map(stringify).includes(ls)
    default:
      throw new Error(`unsupported comparison operator "${op}"`)
  }
}

/** Evaluate a Dify if-else node and return the chosen branch id. */
function executeIfElse(spec) {
  const inputs = spec.inputs ?? {}
  try {
    for (const item of spec.cases ?? []) {
      const logical = String(item.logical_operator ?? spec.logical_operator ?? 'and').toLowerCase()
      const results = (item.conditions ?? []).map((condition) => evaluateCondition(condition, inputs))
      const matched = logical === 'or' ? results.some(Boolean) : results.every(Boolean)
      if (matched) {
        return { ok: true, outputs: { result: String(item.case_id ?? 'true') } }
      }
    }
    return { ok: true, outputs: { result: 'false' } }
  } catch (error) {
    return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` }
  }
}

/** Build the request URL and append Dify's query parameters. */
function httpRequestUrl(spec) {
  let url
  try {
    url = new URL(String(spec.url ?? ''))
  } catch {
    throw new Error(`invalid http-request url ${JSON.stringify(spec.url ?? '')}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`http-request only allows http(s), got ${url.protocol}`)
  }
  for (const pair of spec.params ?? []) {
    if (Array.isArray(pair) && pair.length >= 1) url.searchParams.append(String(pair[0]), stringify(pair[1]))
  }
  return url
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return [...headers.keys()].some((key) => key.toLowerCase() === lower)
}

/** Apply Dify's auth block to the outgoing header map. */
function applyHttpAuth(spec, headers) {
  const auth = spec.authorization ?? { type: 'no-auth' }
  const type = String(auth.type ?? 'no-auth')
  if (type === 'api-key') {
    const cfg = auth.config ?? {}
    const key = stringify(cfg.api_key)
    if (key.length === 0) return
    const header = String(cfg.header ?? 'Authorization')
    const bearer = String(cfg.type ?? 'bearer') === 'bearer'
    headers.set(header, bearer && !/^Bearer\s/i.test(key) ? `Bearer ${key}` : key)
  } else if (type === 'bearer') {
    const token = stringify(auth.config?.token)
    if (token.length > 0) headers.set('Authorization', /^Bearer\s/i.test(token) ? token : `Bearer ${token}`)
  }
}

/** Dify HTTP body block → the exact bytes curl should send. */
function httpPayload(spec, headers) {
  const body = spec.body ?? { type: 'none' }
  if (body.type === 'none') return undefined
  if (body.type === 'json') {
    let value
    if (Array.isArray(body.data)) {
      value = {}
      for (const item of body.data) value[String(item.key)] = item.value
    } else if (typeof body.raw === 'string') {
      try {
        value = JSON.parse(body.raw)
      } catch {
        throw new Error('http-request json body is not valid JSON after reference rendering')
      }
    } else {
      value = body.value ?? {}
    }
    if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', 'application/json')
    return JSON.stringify(value)
  }
  if (body.type === 'raw-text') {
    if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', 'text/plain; charset=utf-8')
    return stringify(body.data)
  }
  if (body.type === 'x-www-form-urlencoded') {
    const form = new URLSearchParams()
    for (const item of body.data ?? []) form.append(String(item.key), stringify(item.value))
    if (!hasHeader(headers, 'content-type')) headers.set('Content-Type', 'application/x-www-form-urlencoded')
    return form.toString()
  }
  throw new Error(`unsupported http-request body type "${body.type}"`)
}

/** Parse the last response block curl wrote with --dump-header. */
function parseCurlHeaders(text) {
  const blocks = String(text ?? '')
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim().length > 0)
  const block = blocks.at(-1) ?? ''
  const headers = {}
  for (const line of block.split(/\r?\n/)) {
    if (/^HTTP\//i.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return headers
}

function parseJsonBody(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One HTTP outcome, honoring Dify's error strategy and branch handle. */
function httpOutcome(spec, { status, headers, text, backend, url }) {
  const strategy = String(spec.errorStrategy ?? 'none')
  const json = parseJsonBody(text)
  const outputs = {
    body: text,
    json,
    status_code: status,
    headers,
    text,
    url,
    backend,
  }
  if (status >= 400) {
    const error = `http node ${spec.nodeId} got HTTP ${status}: ${text.slice(0, 300)}`
    const errorOutputs = { ...outputs, error, error_type: 'http_error', error_message: error }
    if (strategy === 'fail-branch') return { ok: true, branch: 'fail-branch', outputs: errorOutputs }
    if (strategy === 'default-value') {
      return {
        ok: true,
        outputs: { ...(spec.defaultValue ?? {}), error, error_type: 'http_error', error_message: error },
        meta: { defaulted: true, actualStatus: status },
      }
    }
    return { ok: false, error, outputs: errorOutputs }
  }
  return { ok: true, ...(strategy === 'fail-branch' ? { branch: 'success-branch' } : {}), outputs }
}

/** One HTTP failure (network, timeout, sandbox refusal), honoring the strategy. */
function httpFailure(spec, message, errorType = 'network_error') {
  const strategy = String(spec.errorStrategy ?? 'none')
  if (strategy === 'fail-branch') {
    return {
      ok: true,
      branch: 'fail-branch',
      outputs: {
        body: '',
        json: undefined,
        status_code: 0,
        headers: {},
        text: '',
        error: message,
        error_type: errorType,
        error_message: message,
      },
    }
  }
  if (strategy === 'default-value') {
    return {
      ok: true,
      outputs: { ...(spec.defaultValue ?? {}), error: message, error_type: errorType, error_message: message },
      meta: { defaulted: true },
    }
  }
  return { ok: false, error: message }
}

/**
 * Dify's HTTP request node.
 *
 * A plain GET with no custom headers is delegated to `ctx.web.fetch` — the
 * harness's existing web seam. Everything else (POST/PUT/PATCH/DELETE, custom
 * headers, bodies, auth) is delegated to `ctx.sandbox.confine` + the system
 * `curl`, so this plugin still owns no HTTP client.
 */
async function executeHttp(ctx, spec, request, env) {
  // Dify's `ssl_verify` is `bool | None` and ssrf_proxy rejects anything but a
  // boolean. An absent key means the deployment default (verification on); an
  // explicit non-boolean — notably `null` — is an authoring error, never a
  // silent fallback to either policy.
  const sslVerify = spec.sslVerify === undefined ? true : spec.sslVerify
  if (typeof sslVerify !== 'boolean') {
    return {
      ok: false,
      error: `http node ${spec.nodeId}: ssl_verify must be a boolean, got ${spec.sslVerify === null ? 'null' : JSON.stringify(sslVerify)} (omit the field to use the deployment default)`,
    }
  }
  let url
  try {
    url = httpRequestUrl(spec)
  } catch (error) {
    return httpFailure(spec, String(error?.message ?? error))
  }
  const method = String(spec.method ?? 'GET').toUpperCase()
  const headers = new Map()
  for (const pair of spec.headers ?? []) {
    if (!Array.isArray(pair) || pair.length < 1) continue
    const name = String(pair[0])
    const value = stringify(pair[1])
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) return httpFailure(spec, `http-request header "${name}" contains a newline`)
    headers.set(name, value)
  }
  try {
    applyHttpAuth(spec, headers)
  } catch (error) {
    return httpFailure(spec, String(error?.message ?? error))
  }
  const body = spec.body ?? { type: 'none' }
  const hasBody = body.type !== 'none'
  const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
  // `ctx.web.fetch` exposes no certificate policy, so verification-off requests
  // take the curl path (with `--insecure`) instead of failing on that seam.
  if (
    sslVerify &&
    (method === 'GET' || method === 'HEAD') &&
    !hasBody &&
    headers.size === 0 &&
    web !== undefined &&
    typeof web.fetch === 'function'
  ) {
    try {
      const result = await web.fetch({ url: url.toString() }, request.signal)
      const text = String(result.body?.content ?? '')
      return httpOutcome(spec, {
        status: Number(result.statusCode ?? 0),
        headers: {},
        text,
        backend: 'ctx.web.fetch',
        url: result.url ?? url.toString(),
      })
    } catch (error) {
      return httpFailure(spec, `http node ${spec.nodeId} ctx.web.fetch failed: ${error?.message ?? String(error)}`)
    }
  }
  return executeHttpCurl(ctx, spec, request, { method, url, headers, sslVerify })
}

/** Run one HTTP request through the harness sandbox and the system curl. */
async function executeHttpCurl(ctx, spec, request, { method, url, headers, sslVerify = true }) {
  const sandbox = typeof ctx.get === 'function' ? ctx.get('sandbox') : undefined
  if (sandbox === undefined || typeof sandbox.confine !== 'function') {
    return httpFailure(spec, 'ctx.sandbox is unavailable; refusing to run http-request unconfined')
  }
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  if (!existsSync(workspaceRoot)) return httpFailure(spec, `http-request workspace root does not exist: ${workspaceRoot}`)
  let payload
  try {
    payload = httpPayload(spec, headers)
  } catch (error) {
    return httpFailure(spec, String(error?.message ?? error))
  }
  let dir
  try {
    dir = mkdtempSync(join(workspaceRoot, '.dify-http-'))
  } catch (error) {
    return httpFailure(spec, `http-request cannot create a temporary directory: ${error?.message ?? String(error)}`)
  }
  const bodyPath = join(dir, 'body')
  const headerPath = join(dir, 'headers')
  try {
    const timeoutMs = Number(spec.timeoutMs ?? 30_000)
    const argv = [
      'curl',
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs',
      '5',
      '--max-time',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '--proto',
      '=http,https',
      '--request',
      method,
      '--dump-header',
      headerPath,
      '--output',
      bodyPath,
      '--write-out',
      '%{http_code}',
    ]
    // `ssl_verify: false` disables verification for this one curl invocation;
    // process-wide TLS switches (NODE_TLS_REJECT_UNAUTHORIZED) are never touched.
    if (!sslVerify) argv.push('--insecure')
    for (const [name, value] of headers) argv.push('--header', `${name}: ${value}`)
    if (payload !== undefined) argv.push('--data-binary', '@-')
    argv.push(url.toString())
    let confined
    try {
      confined = await sandbox.confine(argv, {
        mode: 'workspace-write',
        workspaceRoot,
        ...(request.parent?.session?.id !== undefined ? { sessionId: request.parent.session.id } : {}),
      })
    } catch (error) {
      return httpFailure(spec, `sandbox refused http-request (${error?.code ?? error?.name ?? 'error'}): ${error?.message ?? String(error)}`)
    }
    const proc = await runChild(confined.argv, {
      cwd: workspaceRoot,
      env: { ...process.env },
      input: payload ?? '',
      timeoutMs,
      signal: request.signal,
    })
    if (proc.spawnError) return httpFailure(spec, `cannot start confined curl: ${proc.spawnError}`)
    if (proc.timedOut) return httpFailure(spec, `http node ${spec.nodeId} timed out after ${timeoutMs}ms`, 'timeout')
    if (proc.aborted) return httpFailure(spec, `http node ${spec.nodeId} cancelled`)
    if (proc.code !== 0) {
      return httpFailure(spec, `http node ${spec.nodeId} curl exited ${proc.code}: ${proc.stderr.slice(-500)}`)
    }
    const status = Number(String(proc.stdout).trim())
    if (!Number.isFinite(status) || status <= 0) {
      return httpFailure(spec, `http node ${spec.nodeId} produced no HTTP status: ${proc.stderr.slice(-500)}`)
    }
    const text = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : ''
    const rawHeaders = existsSync(headerPath) ? readFileSync(headerPath, 'utf8') : ''
    return httpOutcome(spec, {
      status,
      headers: parseCurlHeaders(rawHeaders),
      text,
      backend: 'sandbox+curl',
      url: url.toString(),
    })
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Dify tool node.
 *
 * Resolution order, and nothing else:
 *   1. a declarative contract matching `provider/provider_name + tool/tool_name`
 *   2. an explicit harness-tool passthrough (`DIFY_TOOL_PASSTHROUGH`)
 *   3. refuse, naming what IS available
 *
 * There is deliberately no name-based guessing table: mapping `jina_reader` onto
 * `web_fetch` calls a different tool than the workflow asked for, which is the
 * silent-semantic-drift the contract exists to remove.
 *
 * `tool_configurations` (user-configured, e.g. API keys) and `tool_parameters`
 * (per-call inputs) are now both forwarded — previously `tool_configurations`
 * was dropped and `provider_name` ignored.
 */
async function executeTool(ctx, spec, request, env) {
  const provider = String(spec.provider ?? '')
  const tool = String(spec.toolName ?? '')
  const requested = provider.length > 0 ? `${provider}/${tool}` : tool
  const allow = toolAllowSet(env)
  if (!allow.has('*') && !allow.has(requested) && !allow.has(tool)) {
    return {
      ok: false,
      error: `tool node ${spec.nodeId} refuses "${requested}": allowlist is ${[...allow].join(', ') || '(empty)'}. Set DIFY_TOOL_ALLOW to opt in.`,
    }
  }
  const registry = env.toolRegistry
  const contract = registry?.get?.(provider, tool)
  if (contract !== undefined) {
    const fetchImpl = (() => {
      const web = typeof ctx.get === 'function' ? ctx.get('web') : undefined
      if (typeof web?.fetch === 'function') return web.fetch.bind(web)
      return globalThis.fetch
    })()
    const executed = await executeContract(
      contract,
      { parameters: spec.arguments ?? {}, configurations: spec.configurations ?? {} },
      { fetch: fetchImpl, signal: request.signal },
    )
    if (!executed.ok) return { ok: false, error: `tool node ${spec.nodeId} "${requested}" ${executed.error}`.replace(`"${requested}" tool `, `"${requested}" `) }
    return { ok: true, outputs: executed.outputs, meta: { ...executed.meta, requestedTool: requested } }
  }

  // A Dify plugin package cannot run here: it needs the plugin daemon, which
  // this harness does not carry. Say so instead of pretending.
  const pluginShaped = String(spec.providerType ?? '') !== '' && String(spec.providerType ?? '') !== 'builtin' && String(spec.providerType ?? '') !== 'api'
  if (pluginShaped) {
    return {
      ok: false,
      error:
        `tool node ${spec.nodeId} "${requested}": Dify plugin packages (.difypkg, provider_type="${spec.providerType}") ` +
        'require the Dify plugin daemon and are not supported by this runtime. ' +
        'Reproduce the tool with a declarative YAML contract (see docs/dify-tool-contract.md).',
    }
  }

  // Explicit opt-in passthrough to a harness tool, by exact name only.
  const passthrough = String(env.toolPassthrough ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (passthrough.includes(tool)) {
    return runHarnessTool(ctx, spec, request, tool)
  }

  const available = registry?.list?.() ?? []
  return {
    ok: false,
    error:
      `tool node ${spec.nodeId} "${requested}" is not declared in this deployment. ` +
      `Declared tools: ${available.length > 0 ? available.join(', ') : '(none)'}. ` +
      'Add a declarative contract for it, or list an exact harness tool name in DIFY_TOOL_PASSTHROUGH.',
  }
}

/** Dispatch to a harness tool by its exact registered name. */
async function runHarnessTool(ctx, spec, request, mapped) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.execute !== 'function') {
    return { ok: false, error: 'ctx.tools is unavailable; refusing to run the tool node' }
  }
  if (typeof tools.get === 'function' && tools.get(mapped) === undefined) {
    return { ok: false, error: `tool node ${spec.nodeId}: harness tool "${mapped}" is not registered in this profile` }
  }
  const args = { ...(spec.arguments ?? {}) }
  for (const [key, value] of Object.entries(args)) if (value === undefined) delete args[key]
  let result
  try {
    result = await tools.execute({
      callId: randomUUID(),
      name: mapped,
      arguments: args,
      agent: request.parent,
      signal: request.signal ?? new AbortController().signal,
    })
  } catch (error) {
    return { ok: false, error: `tool node ${spec.nodeId} "${mapped}" failed: ${error?.message ?? String(error)}` }
  }
  const text = (result.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (result.isError) {
    return { ok: false, error: `tool node ${spec.nodeId} "${mapped}" failed: ${text || result.error?.message || 'tool error'}` }
  }
  const value = result.value
  const outputs = { text, result: text, json: value }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) if (outputs[key] === undefined) outputs[key] = item
    if (value.body?.content !== undefined && outputs.body === undefined) outputs.body = value.body.content
  }
  return {
    ok: true,
    outputs,
    meta: { tool: mapped, requestedTool: mapped, provider: spec.provider ?? '', engine: 'harness-tool' },
  }
}

function toolAllowSet(env) {
  return new Set(
    String(env.toolAllow ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
}



/** Query terms for lexical retrieval; CJK runs also contribute bigrams. */
function knowledgeTerms(query) {
  const text = String(query ?? '')
  const terms = new Set()
  for (const token of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (token.length >= 2) terms.add(token)
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length >= 2) terms.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  return [...terms]
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Dify knowledge-retrieval, minimally and honestly: a local dataset directory
 * per `dataset_ids` entry, candidate lines found by the harness's existing
 * `grep` tool, and deterministic lexical scoring in this adapter. This is not a
 * vector/embedding RAG and does not read Dify's hosted datasets; a dataset id
 * must resolve under `DIFY_KNOWLEDGE_ROOT`.
 */
async function executeKnowledge(ctx, spec, request, env) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.execute !== 'function') {
    return { ok: false, error: 'ctx.tools is unavailable; refusing to run knowledge-retrieval' }
  }
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  const root = env.knowledgeRoot || process.env.DIFY_KNOWLEDGE_ROOT || join(workspaceRoot, 'knowledge')
  const ids = Array.isArray(spec.datasetIds) ? spec.datasetIds.map(String) : []
  const datasets = []
  const missing = []
  for (const id of ids) {
    const candidate = isAbsolute(id) ? id : join(root, id)
    if (existsSync(candidate)) datasets.push({ id, path: candidate })
    else missing.push(id)
  }
  if (datasets.length === 0) {
    return {
      ok: false,
      error: `knowledge-retrieval ${spec.nodeId}: dataset(s) ${missing.join(', ') || '(none)'} not found under ${root}. Set DIFY_KNOWLEDGE_ROOT or map dataset_ids to local directories.`,
    }
  }
  const query = stringify(spec.query)
  const terms = knowledgeTerms(query)
  if (terms.length === 0) {
    return { ok: true, outputs: { result: [], records: [], query, datasets: datasets.map((item) => item.id) }, meta: { note: 'empty query' } }
  }
  const pattern = `(?i)(${terms.map(escapeRegex).join('|')})`
  const matches = []
  for (const dataset of datasets) {
    let result
    try {
      result = await tools.execute({
        callId: randomUUID(),
        name: 'grep',
        arguments: { pattern, path: dataset.path },
        agent: request.parent,
        signal: request.signal ?? new AbortController().signal,
      })
    } catch (error) {
      return { ok: false, error: `knowledge-retrieval ${spec.nodeId} grep failed: ${error?.message ?? String(error)}` }
    }
    if (result.isError) {
      return { ok: false, error: `knowledge-retrieval ${spec.nodeId} grep failed: ${result.error?.message ?? 'tool error'}` }
    }
    for (const match of result.value?.matches ?? []) {
      const content = String(match.line ?? '').slice(0, 2000)
      const lower = content.toLowerCase()
      let hits = 0
      for (const term of terms) if (lower.includes(term.toLowerCase())) hits += 1
      matches.push({
        content,
        score: terms.length > 0 ? hits / terms.length : 0,
        dataset: dataset.id,
        path: String(match.path ?? ''),
        lineNumber: Number(match.lineNumber ?? 0),
      })
    }
  }
  const threshold = Number(spec.scoreThreshold ?? 0)
  const topK = Math.max(1, Math.min(50, Number(spec.topK ?? 4) || 4))
  const seen = new Set()
  const records = matches
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber)
    .filter((item) => {
      const key = `${item.path}:${item.lineNumber}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, topK)
    .map((item) => ({
      content: item.content,
      score: Math.round(item.score * 10_000) / 10_000,
      title: basename(item.path),
      metadata: { path: item.path, line: item.lineNumber, dataset: item.dataset },
    }))
  return {
    ok: true,
    outputs: { result: records, records, query, datasets: datasets.map((item) => item.id) },
    meta: { engine: 'grep+lexical', datasetRoot: root, terms, candidates: matches.length },
  }
}

/** A JS code node's `main({...})` trampoline, executed by `node -e` in the sandbox. */
function jsProgram(code) {
  return `
const __payload = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
;(async () => {
  let __result = { ok: false }
  try {
    ${code}
    if (typeof main !== 'function') throw new TypeError('code node does not define main(...)')
    const __outputs = await main(__payload.inputs || {})
    if (__outputs !== undefined && __outputs !== null && (typeof __outputs !== 'object' || Array.isArray(__outputs))) {
      throw new TypeError('main() must return an object, got ' + (Array.isArray(__outputs) ? 'array' : typeof __outputs))
    }
    __result = { ok: true, outputs: __outputs === undefined || __outputs === null ? {} : __outputs }
  } catch (__e) {
    __result = { ok: false, error: (__e && __e.name ? __e.name + ': ' : '') + String((__e && __e.message) || __e), traceback: String((__e && __e.stack) || '').slice(-4000) }
  }
  process.stdout.write(JSON.stringify(__result))
})()
`
}

/** First JSON object in a model reply (plain, fenced, or surrounded by prose). */
function extractJsonObject(text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return undefined
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const candidates = [cleaned]
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** Coerce one extracted value to its declared Dify parameter type. */
function coerceParameter(type, value) {
  const declared = String(type ?? 'string').toLowerCase()
  if (declared.startsWith('array')) {
    const inner = declared.slice('array'.length).replace(/^\[|\]$/g, '')
    const list = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean)
        : value === undefined || value === null
          ? []
          : [value]
    return list
      .map((item) => {
        if (inner === 'number') return asNumber(item)
        if (inner === 'boolean') return typeof item === 'boolean' ? item : String(item).toLowerCase() === 'true'
        if (inner === 'object') return item !== null && typeof item === 'object' ? item : { value: item }
        return stringify(item)
      })
      .filter((item) => item !== undefined && item !== '')
  }
  if (value === undefined || value === null) {
    if (declared === 'number') return null
    if (declared === 'boolean') return false
    if (declared === 'object') return null
    return ''
  }
  if (declared === 'number') return asNumber(value) ?? null
  if (declared === 'boolean') return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true'
  if (declared === 'object') return typeof value === 'object' ? value : { value }
  return stringify(value)
}

/**
 * Dify `agent` node, executed as ONE model turn.
 *
 * The node's strategy and tool policy are parsed and reported, but this runtime
 * deliberately does not run an autonomous tool loop: a tool loop is a
 * model-chosen control flow, and this runtime keeps orchestration
 * deterministic. The instruction/query are still real model input, so the
 * node's wiring (dataflow in, text out) is exercised end to end.
 */
async function executeAgent(ctx, spec, request, env) {
  const route = resolveRoute(ctx, spec, env)
  const instruction = String(spec.instruction ?? '').trim()
  const query = String(spec.query ?? '').trim()
  const schemaKeys = [
    ...(Array.isArray(spec.declaredOutputs) ? spec.declaredOutputs : []),
  ].filter(Boolean)
  let prompt = query.length > 0 ? query : instruction
  if (instruction.length > 0 && query.length > 0) prompt = `${instruction}\n\n${query}`
  if (schemaKeys.length > 0) {
    prompt += `\n\nReturn only a JSON object with these keys: ${schemaKeys.join(', ')}.`
  }
  if (prompt.length === 0) return { ok: false, error: `agent node ${spec.nodeId} has neither an instruction nor a query` }
  const system = instruction.length > 0 && query.length > 0 ? instruction : undefined
  const call = await streamLlm(ctx, request, route, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    ...(system !== undefined ? { system } : {}),
    temperature: typeof spec.temperature === 'number' ? spec.temperature : 0.3,
    maxTokens: typeof spec.maxTokens === 'number' ? spec.maxTokens : undefined,
  })
  if (!call.ok) return { ok: false, error: `agent node ${spec.nodeId} ${call.error}` }
  const outputs = { text: call.text, output: call.text, reasoning_content: call.reasoning, files: [], json: null }
  const json = extractJsonObject(call.text)
  if (json !== undefined) {
    outputs.json = json
    for (const key of schemaKeys) if (json[key] !== undefined) outputs[key] = json[key]
  }
  return {
    ok: true,
    outputs,
    meta: {
      provider: route.provider,
      model: route.model,
      requested: spec.provider && spec.model ? `${spec.provider}/${spec.model}` : '',
      routeSource: route.source,
      strategy: spec.strategy ?? '',
      mode: 'single-turn',
      toolsRequested: Array.isArray(spec.tools) ? spec.tools : [],
      toolsExecuted: [],
      note: 'tool policy parsed; no autonomous tool loop in this runtime',
      ...(schemaKeys.length > 0 ? { declaredOutputs: schemaKeys } : {}),
    },
  }
}

/**
 * Dify `parameter-extractor` node: one structured model turn, then THIS code
 * parses/coerces the declared parameters. The model never decides what the
 * downstream graph reads; the declared parameter list does.
 */
async function executeParameterExtractor(ctx, spec, request, env) {
  const route = resolveRoute(ctx, spec, env)
  const parameters = (Array.isArray(spec.parameters) ? spec.parameters : []).filter((item) => item?.name)
  if (parameters.length === 0) return { ok: false, error: `parameter-extractor ${spec.nodeId} declares no parameters` }
  const instruction = String(spec.instruction ?? '').trim() || 'Extract the declared parameters from the input.'
  const query = stringify(spec.query)
  const schema = parameters.map((item) => {
    const options = Array.isArray(item.options) && item.options.length > 0 ? `, one of: ${item.options.join(' | ')}` : ''
    return `- ${item.name} (${item.type}${item.required ? ', required' : ', optional'}${options}): ${item.description || item.name}`
  })
  const prompt = [
    instruction,
    '',
    'Return exactly one JSON object with these keys:',
    ...schema,
    '',
    'Input:',
    query,
    '',
    'Reply with only the JSON object. Use null for a parameter you cannot find.',
  ].join('\n')
  const call = await streamLlm(ctx, request, route, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: typeof spec.temperature === 'number' ? spec.temperature : 0.1,
    maxTokens: typeof spec.maxTokens === 'number' ? spec.maxTokens : 2048,
  })
  if (!call.ok) return { ok: false, error: `parameter-extractor ${spec.nodeId} ${call.error}` }
  // A reasoning model may put its JSON in the reasoning channel and leave the
  // final text empty (e.g. max_tokens consumed by thinking); accept either.
  let json = extractJsonObject(call.text)
  let parsedFrom = 'text'
  if (json === undefined && typeof call.reasoning === 'string' && call.reasoning.length > 0) {
    json = extractJsonObject(call.reasoning)
    if (json !== undefined) parsedFrom = 'reasoning'
  }
  const outputs = {}
  const missing = []
  for (const item of parameters) {
    const raw = json?.[item.name]
    const coerced = coerceParameter(item.type, raw)
    outputs[item.name] = coerced
    const isMissing = raw === undefined || raw === null || raw === '' || (Array.isArray(coerced) && coerced.length === 0)
    if (isMissing && item.required) missing.push(item.name)
  }
  const success = json !== undefined && missing.length === 0
  outputs.__is_success = success ? 1 : 0
  outputs.__reason = json === undefined
    ? 'model reply was not a JSON object'
    : missing.length > 0
      ? `missing required parameters: ${missing.join(', ')}`
      : 'ok'
  return {
    ok: true,
    outputs,
    meta: {
      provider: route.provider,
      model: route.model,
      routeSource: route.source,
      reasoningMode: spec.reasoningMode ?? 'prompt',
      parameters: parameters.map((item) => item.name),
      missing,
      finish: call.finish,
      textChars: call.text.length,
      reasoningChars: typeof call.reasoning === 'string' ? call.reasoning.length : 0,
      ...(json !== undefined ? { parsedFrom } : { parsedFrom: 'none' }),
      raw: json === undefined ? `${call.text}\n${call.reasoning ?? ''}`.trim().slice(0, 800) : undefined,
    },
  }
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html?|log|ini|cfg|toml|py|js|mjs|cjs|ts|css|sql)$/i

/** Resolve a document path, refusing anything outside the workspace/document root. */
function resolveDocumentPath(value, workspaceRoot, env) {
  const raw = String(value ?? '')
  if (raw.length === 0) return undefined
  const resolved = resolve(workspaceRoot, raw)
  const roots = [workspaceRoot, env.documentRoot].filter((root) => typeof root === 'string' && root.length > 0)
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) return undefined
  return resolved
}

/**
 * Dify `document-extractor`, minimal and honest: text-like local files under
 * the workspace (or a configured document root) and text-like remote URLs via
 * `ctx.web.fetch`. PDFs/office formats are reported per file, never faked.
 */
async function executeDocumentExtractor(ctx, spec, request, env) {
  const files = spec.files
  const list = Array.isArray(files) ? files : files == null ? [] : [files]
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  const extracted = []
  try {
    if (files == null) throw new Error('file variable is missing')
    for (const item of list) {
      const name = stringify(item?.filename ?? item?.name ?? item?.url ?? item)
      if (item?.text !== undefined || item?.content !== undefined) {
        extracted.push({ name, text: stringify(item.text ?? item.content), engine: 'inline-text-extension' })
        continue
      }
      const remote = item?.remote_url ?? item?.url
      let bytes
      let extension = item?.extension
      if (typeof remote === 'string' && /^https?:/i.test(remote)) {
        const response = await fetch(remote, { signal: request.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${remote}`)
        bytes = Buffer.from(await response.arrayBuffer())
        extension ||= extname(new URL(remote).pathname)
        if (!extension) extension = ({ 'application/pdf': '.pdf', 'text/plain': '.txt', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx' })[item?.mime_type ?? response.headers.get('content-type')?.split(';')[0]]
      } else {
        const value = typeof item === 'string' ? item : item?.file_path ?? item?.path ?? item?.local_path
        const path = resolveDocumentPath(value, workspaceRoot, env)
        if (!path) throw new Error(`file path missing or outside workspace: ${stringify(value)}`)
        bytes = readFileSync(path)
        extension ||= extname(path)
      }
      const proc = await runChild([env.python, join(dirname(fileURLToPath(import.meta.url)), 'extract-document.py')], {
        cwd: workspaceRoot, env: { ...process.env, ...({ PYTHONPATH: [process.env.DIFY_EXTRACTION_VENDOR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.vendor-extraction'), env.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(':') }) },
        input: JSON.stringify({ bytes: bytes.toString('base64'), extension: extension ?? '' }), timeoutMs: 120_000, signal: request.signal,
      })
      if (proc.code !== 0 || proc.aborted || proc.timedOut || proc.spawnError) throw new Error(`extraction process failed (output limit 4 MiB, timeout 120s): ${proc.spawnError ?? proc.stderr ?? proc.code}`)
      const result = JSON.parse(proc.stdout)
      if (!result.ok) throw new Error(`${name}: ${result.error}`)
      extracted.push({ name, text: result.text, engine: result.engine })
    }
    return { ok: true, outputs: { text: Array.isArray(files) ? extracted.map(x => x.text) : extracted[0].text, files: extracted, count: extracted.length }, meta: { extracted: extracted.length, failed: 0, engine: 'fixed-official-extractors', ocr: false } }
  } catch (error) {
    return { ok: false, error: `document-extractor ${spec.nodeId}: ${error.message}` }
  }
}

/**
 * Dify `datasource` (plugin-backed in Dify). Minimal local implementation:
 * read `parameters.path` as JSON/JSONL/text under the workspace; expose the
 * records plus each field of the first record for downstream selectors.
 */
async function executeDatasource(ctx, spec, request, env) {
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  const parameters = spec.parameters ?? {}
  const configured = parameters.path ?? parameters.file ?? parameters.url ?? spec.datasourceName
  if (configured === undefined || configured === null || stringify(configured).length === 0) {
    return { ok: false, error: `datasource ${spec.nodeId} has no local path configured (parameters.path)` }
  }
  const path = resolveDocumentPath(configured, workspaceRoot, env)
  if (path === undefined) return { ok: false, error: `datasource ${spec.nodeId} path is outside the workspace: ${stringify(configured)}` }
  if (!existsSync(path)) return { ok: false, error: `datasource ${spec.nodeId} file not found: ${path}` }
  let records = []
  try {
    const content = readFileSync(path, 'utf8').slice(0, 4_000_000)
    if (/\.jsonl?$/i.test(path) || /^\s*[[{]/.test(content)) {
      try {
        const parsed = JSON.parse(content)
        records = Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        records = content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { line }
          }
        })
      }
    } else {
      records = content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => ({ line }))
    }
  } catch (error) {
    return { ok: false, error: `datasource ${spec.nodeId} cannot read ${path}: ${error?.message ?? String(error)}` }
  }
  const first = records[0]
  const outputs = { output: records, records, result: records, count: records.length, datasource: spec.datasourceName ?? '', record: first ?? null }
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    for (const [key, value] of Object.entries(first)) if (outputs[key] === undefined) outputs[key] = value
  }
  return {
    ok: true,
    outputs,
    meta: { provider: spec.provider ?? '', datasource: spec.datasourceName ?? '', path, count: records.length, engine: 'local-file' },
  }
}

/**
 * Dify `knowledge-index`: parsed and scheduled, but this runtime has no vector
 * store to write to. It reports what it *would* index instead of pretending a
 * write happened.
 */
async function executeKnowledgeIndex(ctx, spec, request, env) {
  const chunk = spec.chunk
  const chunks = Array.isArray(chunk) ? chunk : chunk === undefined || chunk === null ? [] : [chunk]
  return {
    ok: true,
    outputs: {
      dataset_id: spec.datasetId ?? '',
      indexed: 0,
      chunks: chunks.length,
      status: 'not_written',
    },
    meta: {
      engine: 'placeholder',
      note: 'knowledge-index parsed and scheduled; no vector store is mounted in this runtime',
      keywordNumber: spec.keywordNumber ?? 10,
    },
  }
}

/**
 * Dify `human-input`, resolved deterministically for a non-interactive run: the
 * run args (`human.<nodeId>.action`, then `action`) pick a declared action,
 * otherwise the first declared action is used. Form inputs come from their
 * declared constants; the resolved action names the outgoing edge.
 */
function executeHumanInput(spec) {
  const actions = (Array.isArray(spec.actions) ? spec.actions : []).filter((action) => stringify(action?.id).length > 0)
  const ids = actions.map((action) => stringify(action.id))
  let chosen = spec.autoAction === undefined || spec.autoAction === null || spec.autoAction === '' ? '' : stringify(spec.autoAction)
  if (chosen.length === 0) chosen = ids[0] ?? '__timeout'
  if (chosen !== '__timeout' && !ids.includes(chosen)) {
    return { ok: false, error: `human-input ${spec.nodeId} action "${chosen}" is not declared (declared: ${ids.join(', ') || '(none)'})` }
  }
  const outputs = { __action_id: chosen, __action_value: chosen, __rendered_content: spec.formContent ?? '' }
  for (const input of spec.formInputs ?? []) {
    const name = stringify(input?.name)
    if (name.length === 0) continue
    const fallback = input?.default
    outputs[name] = fallback !== null && typeof fallback === 'object' && 'value' in fallback ? fallback.value : fallback ?? ''
  }
  return {
    ok: true,
    branch: chosen,
    outputs,
    meta: { autoResolved: true, actions: ids, note: 'human step resolved from run args / first declared action' },
  }
}

/** Locate the vendored Python libraries shipped with the plugin. */
export function defaultPythonPath(runtimeRoot) {
  const vendor = join(runtimeRoot, 'vendor')
  return existsSync(vendor) ? vendor : ''
}
