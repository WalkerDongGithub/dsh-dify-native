/**
 * `dify-node` subagent provider — the extension that gives the existing
 * workflow orchestration loop Dify's node capabilities.
 *
 * The workflow engine calls every node as `agent(prompt, opts)`; the engine's
 * subagent provider is fixed per run, so this provider receives one JSON node
 * request per call and dispatches by `kind`:
 *
 *   code     → ctx.sandbox.confine (landlock/bwrap); Python trampoline child
 *   llm      → ctx.llm.stream (the harness's own provider-neutral LLM service)
 *   if-else  → local condition evaluation, no host capability needed
 *
 * No process isolation, no LLM adapter, and no scheduler live here: this is a
 * capability provider for the documented subagent seam. Model routing never
 * invents an HTTP client; it picks a route the mounted `llm` service actually
 * exposes (falling back to the profile's default model when the DSL names a
 * provider this deployment does not have, e.g. `deepseek/deepseek-chat`).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

/** Run one confined child, capture stdio, and settle with its result. */
function runChild(argv, { cwd, env, input, timeoutMs, signal }) {
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
  const llmProvider = options.llmProvider ?? process.env.DIFY_LLM_PROVIDER ?? ''
  const llmModel = options.llmModel ?? process.env.DIFY_LLM_MODEL ?? ''

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
          payload = await executeSpec(ctx, spec, request, { python, pythonPath, llmProvider, llmModel })
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
  return { ok: false, error: `unsupported node kind "${spec.kind}"` }
}

/** Run a Dify code node under the harness's own confinement. */
async function executeCode(ctx, spec, request, env) {
  const sandbox = typeof ctx.get === 'function' ? ctx.get('sandbox') : undefined
  if (sandbox === undefined || typeof sandbox.confine !== 'function') {
    return { ok: false, error: 'ctx.sandbox is unavailable; refusing to run the code node unconfined' }
  }
  const language = spec.codeLanguage ?? 'python3'
  if (language !== 'python3' && language !== 'python') {
    return { ok: false, error: `unsupported code_language "${language}" (v1 supports python3)` }
  }
  const workspaceRoot = spec.workspaceRoot ?? request.parent?.session?.header?.cwd ?? process.cwd()
  if (!existsSync(workspaceRoot)) return { ok: false, error: `workspace root does not exist: ${workspaceRoot}` }
  const policy = {
    mode: spec.mode ?? 'workspace-write',
    workspaceRoot,
    ...(request.parent?.session?.id !== undefined ? { sessionId: request.parent.session.id } : {}),
  }
  let confined
  try {
    confined = await sandbox.confine([env.python, '-c', PY_WRAPPER], policy)
  } catch (error) {
    return { ok: false, error: `sandbox refused the code node (${error?.code ?? error?.name ?? 'error'}): ${error?.message ?? String(error)}` }
  }
  const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  if (env.pythonPath) childEnv.PYTHONPATH = [env.pythonPath, childEnv.PYTHONPATH].filter(Boolean).join(':')
  for (const [key, value] of Object.entries(spec.env ?? {})) childEnv[key] = String(value)
  const proc = await runChild(confined.argv, {
    cwd: workspaceRoot,
    env: childEnv,
    input: JSON.stringify({ code: spec.code, inputs: spec.inputs ?? {} }),
    timeoutMs: Number(spec.timeoutMs ?? 120_000),
    signal: request.signal,
  })
  if (proc.spawnError) return { ok: false, error: `cannot start confined python: ${proc.spawnError}` }
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

/** Call one Dify LLM node through the harness LLM service. */
async function executeLlm(ctx, spec, request, env) {
  const llm = ctx.get('llm')
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
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(typeof spec.temperature === 'number' ? { temperature: spec.temperature } : {}),
    ...(typeof spec.maxTokens === 'number' ? { maxTokens: spec.maxTokens } : {}),
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
    return { ok: false, error: `llm node ${spec.nodeId} ${finish.kind}: ${finish.failure?.message ?? 'model call failed'}` }
  }
  if (text.length === 0 && reasoning.length === 0) {
    return { ok: false, error: `llm node ${spec.nodeId} produced no text (route ${route.provider}/${route.model})` }
  }
  return {
    ok: true,
    outputs: { text, usage: usage ?? {}, reasoning_content: reasoning },
    meta: {
      provider: route.provider,
      model: route.model,
      requested: spec.provider && spec.model ? `${spec.provider}/${spec.model}` : '',
      routeSource: route.source,
      finish: finish?.kind ?? 'stop',
      ...(note !== undefined ? { adapterNote: note } : {}),
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

/** Locate the vendored Python libraries shipped with the plugin. */
export function defaultPythonPath(runtimeRoot) {
  const vendor = join(runtimeRoot, 'vendor')
  return existsSync(vendor) ? vendor : ''
}
