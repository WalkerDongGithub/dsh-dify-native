/**
 * dsh-dify-native — run a Dify workflow .yml on the harness's own pieces.
 *
 * Import map (all existing dsh capabilities, nothing rebuilt here):
 *   orchestration loop → ctx.workflowEngine (the mounted dsh workflow engine)
 *   code nodes         → ctx.sandbox.confine (landlock/bwrap confinement)
 *   node dispatch      → ctx.subagents provider seam (`dify-node`)
 *   LLM nodes          → ctx.llm.stream (harness LLM service, profile routing)
 *
 * This package only parses Dify's DSL, compiles the graph into an orchestration
 * script, and registers the node provider. It imports no dsh source and starts
 * no scheduler, sandbox, or LLM client of its own.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { stateRoot, stateKey, readState, writeState, lockState } from './runtime-state.js'
import { fileURLToPath } from 'node:url'
import { compileGraph, inspectGraph, parseDifyDsl } from './dsl.js'
import { createDifyNodeProvider, defaultPythonPath } from './provider.js'
import { startEventRuntime } from './event-runtime.js'
import { deriveChatHistory } from './session-history.js'

const name = 'dsh-dify-native'
const inject = ['tools']
const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = process.env.DSH_DIFY_RUNTIME_ROOT ?? join(HERE, '..', '..', 'dsh-dify-runtime', 'runtime')

const PATH_PARAM = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to a Dify workflow .yml file' },
  },
  required: ['path'],
}

const RUN_PARAM = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to a Dify workflow .yml file' },
    inputs: {
      type: 'object',
      description: 'Start-node inputs keyed by the DSL variable names',
      additionalProperties: true,
    },
    timeout: { type: 'number', description: 'Per-code-node timeout in seconds (default 120)' },
    tracePath: { type: 'string', description: 'Optional path to write the full run record as JSON' },
  },
  required: ['path'],
}

async function persistTrace(path, record) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(record, null, 2))
}

async function loadAndCompile(path, options = {}) {
  const text = await readFile(path, 'utf8')
  const parsed = parseDifyDsl(text)
  const inspection = inspectGraph(parsed)
  const compiled = inspection.issues.length === 0 ? compileGraph(parsed, options) : undefined
  return { parsed, inspection, compiled }
}

/**
 * Dify system variables derived from the calling harness session.
 *
 * The DSL compiles `{{#sys.conversation_id#}}` etc. into reads from `args`, so
 * the run injects them next to the start-node inputs. When a run has no live
 * session (an offline one-shot call) these stay undefined, which the compiled
 * script already handles (`__vars.sys` falls back to its own defaults).
 *
 * Only the identity Dify promises is provided here. `sys.query` / `sys.files`
 * are NOT synthesized from the session: a run's current input is the caller's
 * `inputs`, not "whatever the agent last said", so inferring them would guess.
 *
 * @param session - the live session from the tool execution context, if any.
 * @returns a record merged into the run's `args`; empty when there is no session.
 */
function systemVariables(session) {
  if (session === null || session === undefined) return {}
  const out = {}
  const id = session.id
  if (typeof id === 'string' && id.length > 0) out['sys.conversation_id'] = id
  // Dify's `dialogue_count` counts the user's turns. A raw count of `role: 'user'`
  // messages would over-count: the loop also appends protocol-injected user
  // messages (instructions, runtime snapshots), which are not the user talking.
  // Reuse the same filter the memory adapter applies so both agree.
  try {
    if (typeof session.deriveMessages === 'function') {
      out['sys.dialogue_count'] = deriveChatHistory(session.deriveMessages()).filter((item) => item.role === 'user').length
    }
  } catch {
    // A log that cannot be read costs the count, never the run.
  }
  return out
}

/**
 * Diagnostics attributable to one node id, plus the node's declared support
 * level. Warnings never fail a run: they record what the graph will *not* do.
 */
function nodeDiagnostics(inspection, nodeId) {
  // Field-drop subjects are `"<nodeId>:<field>"`; node-level subjects are the id.
  const rows = (inspection?.diagnostics ?? []).filter((row) => row.subject === nodeId || row.subject.startsWith(`${nodeId}:`))
  const support = (inspection?.support ?? []).find((row) => row.id === nodeId)
  return {
    ...(support?.mode !== undefined && support.mode !== 'full' ? { mode: support.mode } : {}),
    ...(rows.length > 0 ? { warnings: rows.map((row) => row.message) } : {}),
  }
}

function renderInspect(_args, value) {
  const lines = [
    `Dify "${value.appName}" (${value.mode}): ${value.nodeCount} nodes — ${Object.entries(value.nodeTypes).map(([t, n]) => `${t}×${n}`).join(', ')}`,
    `start inputs: ${(value.startInputs ?? []).join(', ') || '(none)'}`,
    `end outputs: ${(value.endOutputs ?? []).join(', ') || '(none)'}`,
  ]
  if ((value.unsupported ?? []).length > 0) {
    lines.push(`unsupported: ${value.unsupported.map((n) => `${n.type}/${n.id}`).join(', ')}`)
  }
  if ((value.issues ?? []).length > 0) lines.push(`issues: ${value.issues.join('; ')}`)
  if (value.compileError) lines.push(`compile error: ${value.compileError}`)
  // Engineer-facing support report: only nodes that are not fully implemented.
  const partial = (value.support ?? []).filter((row) => row.mode !== 'full')
  if (partial.length > 0) {
    lines.push(
      'support (nodes not fully implemented):',
      ...partial.map((row) => `- ${row.id} ${row.kind}: ${row.mode} — ${row.reason}`),
    )
  }
  if ((value.diagnostics ?? []).length > 0) {
    lines.push(
      `diagnostics (${Object.entries(value.diagnosticCodes ?? {}).map(([code, n]) => `${code}×${n}`).join(', ')}):`,
      ...value.diagnostics.map((row) => `- [${row.code}] ${row.message}`),
    )
  }
  if (value.script) lines.push('', 'generated workflow script:', value.script)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderRun(_args, value) {
  const lines = [
    `dify-native ${value.status}${value.stopReason ? ` (${value.stopReason})` : ''}${value.error ? `: ${value.error}` : ''}`,
    `outputs: ${JSON.stringify(value.outputs ?? {})}`,
    ...((value.answers ?? []).length > 0 ? [`answers: ${JSON.stringify(value.answers)}`] : []),
    ...Object.entries(value.nodes ?? {}).map(
      ([id, node]) => {
        const type = node.kind ?? (node.backendArgv0 ? 'code' : 'node')
        const route = node.meta?.provider ? ` route=${node.meta.provider}/${node.meta.model}` : ''
        const support = node.mode !== undefined && node.mode !== 'full' ? ` [${node.mode}]` : ''
        const branch =
          node.branch ??
          (typeof node.outputs?.result === 'string'
            ? node.outputs.result
            : typeof node.outputs?.class_id === 'string'
              ? `class=${node.outputs.class_id}`
              : '')
        return `- ${id} ${type} ${node.title ?? ''}: ${node.ok === false ? 'failed' : 'ok'}${route}${branch ? ` branch=${branch}` : ''}${support}${node.enforcement ? ` [${node.enforcement}]` : ''}${node.ok === false ? ` — ${node.error}` : ''}`
      },
    ),
    `usage: ${JSON.stringify(value.usage ?? {})}, agentsStarted=${value.agentsStarted ?? 0}, durationMs=${value.durationMs ?? '?'}`,
  ]
  // Engineer-facing report of nodes that ran without their full Dify semantics.
  // Never an error: the run still succeeded.
  const warnings = value.nodes
    ? Object.entries(value.nodes).flatMap(([id, node]) => (node.warnings ?? []).map((text) => `- ${id}: ${text}`))
    : []
  if (warnings.length > 0) lines.push(`node warnings (${warnings.length}):`, ...warnings)
  return [{ type: 'text', text: lines.join('\n') }]
}

function ensureProvider(ctx) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('ctx.subagents is unavailable (cannot register the dify-node provider)')
  if (typeof subagents.getProvider === 'function' && subagents.getProvider('dify-node') !== undefined) return
  const pythonPath = process.env.DIFY_PYTHONPATH ?? defaultPythonPath(RUNTIME_ROOT)
  subagents.registerProvider(
    createDifyNodeProvider(ctx, {
      name: 'dify-node',
      python: process.env.DIFY_RUNTIME_PYTHON ?? 'python3',
      pythonPath,
    }),
  )
}

function createInspectTool(ctx) {
  return {
    name: 'dify_native_inspect',
    description:
      'Parse a real Dify workflow .yml and show what the native (ctx.workflowEngine + ctx.sandbox) compiler can run. Does not execute anything.',
    timeoutMs: 60_000,
    parameters: PATH_PARAM,
    output: { schema: { type: 'object', additionalProperties: true }, render: renderInspect },
    async execute(args) {
      const { parsed, inspection, compiled } = await loadAndCompile(args.path)
      return {
        appName: parsed.appName,
        mode: parsed.mode,
        ...inspection,
        script: compiled?.script ?? '',
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Inspect Dify DSL (native)', kind: 'other', rawInput: args }),
  }
}

function createServicesTool(ctx) {
  return {
    name: 'dify_native_services',
    description: 'Report which dsh-native capabilities this profile exposes to the Dify runtime (workflow engine, sandbox, subagent registry).',
    timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const engine = ctx.get('workflowEngine')
      const sandbox = ctx.get('sandbox')
      const subagents = ctx.get('subagents')
      const llm = ctx.get('llm')
      const web = ctx.get('web')
      let providers = []
      try {
        providers = [...(subagents?.providers?.keys?.() ?? [])]
      } catch {
        providers = []
      }
      let harnessTools = []
      try {
        harnessTools = (ctx.get('tools')?.schemas?.() ?? []).map((tool) => tool.name)
      } catch {
        harnessTools = []
      }
      let llmProviders = []
      let llmModels = {}
      try {
        llmProviders = (llm?.listProviders?.() ?? []).map((provider) => provider.id)
        for (const provider of llmProviders) {
          llmModels[provider] = (await llm.listModels?.(provider) ?? []).map((model) => model.id)
        }
      } catch {
        llmModels = {}
      }
      let defaultModel
      try {
        defaultModel = ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        defaultModel = undefined
      }
      return {
        workflowEngine: engine === undefined ? null : engine.constructor?.name ?? 'unknown',
        workflowEngineStart: typeof engine?.start,
        sandbox: sandbox === undefined ? null : sandbox.constructor?.name ?? 'unknown',
        sandboxConfine: typeof sandbox?.confine,
        subagents: subagents === undefined ? null : subagents.constructor?.name ?? 'unknown',
        providers,
        llm: llm === undefined ? null : llm.constructor?.name ?? 'unknown',
        llmStream: typeof llm?.stream,
        llmProviders,
        llmModels,
        web: web === undefined ? null : web.constructor?.name ?? 'unknown',
        webFetch: typeof web?.fetch,
        harnessTools,
        knowledgeRoot: process.env.DIFY_KNOWLEDGE_ROOT ?? '',
        toolAllow: process.env.DIFY_TOOL_ALLOW ?? 'web_search,web_fetch',
        defaultModel: defaultModel ?? null,
        node: process.version,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Dify native services', kind: 'other', rawInput: {} }),
  }
}

function runProbeChild(argv, { cwd, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) })
    })
  })
}

function createSandboxProbeTool(ctx) {
  return {
    name: 'dify_native_sandbox_probe',
    description:
      'Prove the code-node confinement in this live harness: run python3 under ctx.sandbox.confine in workspace-write and read-only modes and report the backend argv and the denial.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string', description: 'Workspace root to allow writes under (default: session cwd)' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `sandbox backend: ${value.backendArgv?.[0] ?? '?'} (enforcement=${value.enforcement})`,
            `workspace-write: exit=${value.write?.code} wrote=${value.write?.wrote} stdout=${JSON.stringify(value.write?.stdout)}`,
            `read-only: exit=${value.denied?.code} denied=${value.denied?.denied} stderr=${JSON.stringify((value.denied?.stderr ?? '').slice(0, 240))}`,
            value.ok ? 'SANDBOX PROBE OK' : 'SANDBOX PROBE FAILED',
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const workspaceRoot = args.workspaceRoot ?? exec?.agent?.session?.header?.cwd
      if (!workspaceRoot) throw new Error('no workspaceRoot and no session cwd')
      const sandbox = ctx.get('sandbox')
      if (sandbox === undefined) throw new Error('ctx.sandbox is unavailable')
      const dir = mkdtempSync(join(workspaceRoot, '.dify-probe-'))
      const writePath = join(dir, 'write.txt')
      const denyPath = join(dir, 'deny.txt')
      const policy = (mode) => ({ mode, workspaceRoot, ...(exec?.agent?.session?.id ? { sessionId: exec.agent.session.id } : {}) })
      const pyWrite = (target) => ['python3', '-c', `open(${JSON.stringify(target)}, 'w').write('ok'); print('wrote')`]
      const wr = await sandbox.confine(pyWrite(writePath), policy('workspace-write'))
      const write = await runProbeChild(wr.argv, { cwd: workspaceRoot })
      write.wrote = existsSync(writePath)
      const ro = await sandbox.confine(pyWrite(denyPath), policy('read-only'))
      const denied = await runProbeChild(ro.argv, { cwd: workspaceRoot })
      denied.denied = !existsSync(denyPath) && denied.code !== 0
      const ok = write.code === 0 && write.wrote && denied.denied
      return { ok, backendArgv: wr.argv, enforcement: wr.enforcement, workspaceRoot, write, denied }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Dify sandbox probe', kind: 'other', rawInput: args }),
  }
}

function createRunTool(ctx) {
  return {
    name: 'dify_native_run',
    description:
      'Compile a real Dify workflow .yml into an orchestration script and run it on the harness workflow engine. LLM and question-classifier nodes call ctx.llm, code nodes execute under ctx.sandbox.confine, http-request uses ctx.web.fetch (plain GET) or ctx.sandbox.confine + curl, tool nodes dispatch through ctx.tools, knowledge-retrieval searches a local dataset with ctx.tools grep, and if-else/assigner/answer/aggregator/template-transform compile to plain script logic. Supports acyclic start → … → end/answer graphs.',
    timeoutMs: 300_000,
    parameters: RUN_PARAM,
    output: { schema: { type: 'object', additionalProperties: true }, render: renderRun },
    async execute(args, exec) {
      const startedAt = Date.now()
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const { parsed, inspection, compiled } = await loadAndCompile(args.path, {
        nodeTimeoutMs: Math.max(1, Number(args.timeout ?? 120)) * 1000,
      })
      if (compiled === undefined) {
        const rejected = { status: 'rejected', error: inspection.issues.join('; '), appName: parsed.appName, ...inspection, durationMs: Date.now() - startedAt }
        await persistTrace(args.tracePath, rejected)
        return rejected
      }
      const inputs = args.inputs ?? {}
      const missing = compiled.requiredInputs.filter((key) => inputs[key] === undefined)
      if (missing.length > 0) {
        const rejected = { status: 'rejected', error: `missing start inputs: ${missing.join(', ')}`, ...inspection, durationMs: Date.now() - startedAt }
        await persistTrace(args.tracePath, rejected)
        return rejected
      }

      const engine = ctx.get('workflowEngine')
      if (engine === undefined) throw new Error('ctx.workflowEngine is unavailable in this profile')
      ensureProvider(ctx)
      const parent =
        exec?.agent ??
        { session: { id: 'dify-native-offline', header: { cwd } } }

      // Attach concrete runtime values to every node spec before the script runs:
      // the compiler emits placeholders and the script fills `inputs` itself.
      const script = compiled.script
      const events = []
      const offStart = ctx.on('workflow/agent-start', (_info, agent) =>
        events.push({ at: 'start', label: agent.label, phase: agent.phase, seq: agent.seq }),
      )
      const offEnd = ctx.on('workflow/agent-end', (_info, agent) =>
        events.push({ at: 'end', label: agent.label, outcome: agent.outcome, seq: agent.seq }),
      )
      let run, release
      const root = stateRoot(cwd)
      const conversationKey = parent.session?.id && parent.session.id !== 'dify-native-offline' ? stateKey(`conversation:${parent.session.id}:${resolve(args.path)}`) : undefined
      try {
        if (conversationKey) release = await lockState(root, conversationKey)
        const saved = conversationKey ? await readState(root, conversationKey) : undefined
        run = engine.start({
          meta: compiled.meta,
          script,
          // `sys.*` mirrors Dify's system variables. The conversation identity
          // comes from the live harness session: `sys.conversation_id` is its id,
          // and `sys.dialogue_count` is the number of real user turns so far.
          args: { ...inputs, ...systemVariables(parent.session), __dify_conversation: saved?.conversation ?? {} },
          parent,
          subagentProvider: 'dify-node',
        })
        const result = await run.result
        const value = result.value ?? {}
        const nodes = value.nodes ?? {}
        // Annotate each executed node with its declared support level and the
        // compile-time diagnostics attributable to it. Diagnostics never change
        // `status`: a run that completed still reports `succeeded`.
        for (const [id, node] of Object.entries(nodes)) {
          const extra = nodeDiagnostics(inspection, id)
          if (extra.mode !== undefined) node.mode = extra.mode
          if (extra.warnings !== undefined) node.warnings = extra.warnings
        }
        const ok = result.stopReason === 'completed'
        if (ok && conversationKey) await writeState(root, conversationKey, { conversation: value.conversation ?? {}, updatedAt: new Date().toISOString() })
        const record = {
          status: ok ? 'succeeded' : 'failed',
          stopReason: result.stopReason,
          error: result.error ?? '',
          appName: parsed.appName,
          outputs: ok ? (value.outputs ?? {}) : {},
          answers: ok ? (value.answers ?? []) : [],
          nodes,
          // Nodes that never ran still carry their compile-time diagnostics, so
          // a dead branch does not hide an unsupported node.
          unexecuted: (inspection.support ?? [])
            .filter((row) => row.mode !== 'full' && nodes[row.id] === undefined)
            .map((row) => ({ id: row.id, kind: row.kind, mode: row.mode, reason: row.reason })),
          diagnostics: inspection.diagnostics ?? [],
          diagnosticCodes: inspection.diagnosticCodes ?? {},
          support: inspection.support ?? [],
          usage: (() => {
            const total = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
            for (const node of Object.values(nodes)) {
              const usage = node?.outputs?.usage
              if (usage === undefined || usage === null || typeof usage !== 'object') continue
              for (const key of Object.keys(total)) {
                if (typeof usage[key] === 'number') total[key] += usage[key]
              }
            }
            return total
          })(),
          agentsStarted: result.agentsStarted,
          events,
          script,
          durationMs: Date.now() - startedAt,
        }
        await persistTrace(args.tracePath, record)
        return record
      } catch (error) {
        const failed = {
          status: 'failed',
          stopReason: 'error',
          error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
          appName: parsed.appName,
          outputs: {},
          nodes: {},
          diagnostics: inspection.diagnostics ?? [],
          diagnosticCodes: inspection.diagnosticCodes ?? {},
          support: inspection.support ?? [],
          events,
          script,
          durationMs: Date.now() - startedAt,
        }
        await persistTrace(args.tracePath, failed)
        return failed
      } finally {
        await release?.()
        offStart?.()
        offEnd?.()
        if (run !== undefined) {
          try {
            await run.dispose()
          } catch {
            // disposal is best-effort after settlement
          }
        }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Run Dify workflow (native)', kind: 'other', rawInput: args }),
  }
}

function createEventTool(ctx) {
  return { name: 'dify_native_events', output: { schema: { type: 'object', additionalProperties: true }, render: (_args,value) => [{ type: 'text', text: JSON.stringify(value) }] }, description: 'Start an explicitly configured local event listener until this context is disposed', parameters: { type: 'object', properties: { configPath: { type: 'string' } }, required: ['configPath'] },
    async execute(args, exec) {
      const config = JSON.parse(await readFile(args.configPath, 'utf8'))
      const runtime = await startEventRuntime(ctx, config, exec?.agent)
      ctx.effect(() => () => runtime.close(), 'dify-native.event-listener')
      return { url: runtime.url, native_plugin_subscription: false }
    }
  }
}
function apply(ctx) {
  ctx.inject(['subagents'], (childCtx) => {
    const subagents = childCtx.subagents
    if (typeof subagents?.getProvider === 'function' && subagents.getProvider('dify-node') !== undefined) return
    const pythonPath = process.env.DIFY_PYTHONPATH ?? defaultPythonPath(RUNTIME_ROOT)
    const provider = createDifyNodeProvider(childCtx, {
      name: 'dify-node',
      python: process.env.DIFY_RUNTIME_PYTHON ?? 'python3',
      pythonPath,
    })
    const dispose = subagents.registerProvider(provider)
    childCtx.effect(() => () => dispose?.(), 'dify-native.provider')
  })
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(createInspectTool(ctx)),
      ctx.tools.register(createServicesTool(ctx)),
      ctx.tools.register(createSandboxProbeTool(ctx)),
      ctx.tools.register(createRunTool(ctx)),
      ctx.tools.register(createEventTool(ctx)),
    ]
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  }, 'dify-native.tools')
}

export { apply, compileGraph, createDifyNodeProvider, inspectGraph, parseDifyDsl }
export default { apply, inject, name }
