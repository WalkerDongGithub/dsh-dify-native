/**
 * dsh-dify-runtime — import a Dify workflow .yml and run it on this harness.
 *
 * The plugin is deliberately a thin tool surface.  Parsing, the deterministic
 * DAG scheduler and the node adapters live in the Python runtime under
 * `runtime/dify_runtime`; each tool call spawns that runtime as a child
 * process (untrusted `code` nodes must never execute inside the host plugin
 * process).  No `@deepseek-ai/*` import is used, so an upgrade of the global
 * dsh install cannot break this package.
 *
 * Tools:
 *   dify_inspect   — parse + report node types, variables, unsupported nodes
 *   dify_translate — normalize the DSL into the runtime IR (optionally write it)
 *   dify_run       — execute deterministically and return node status + outputs
 *
 * @module dsh-dify-runtime
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'dsh-dify-runtime'
const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_ROOT = process.env.DSH_DIFY_RUNTIME_ROOT ?? join(HERE, '..', 'runtime')
const PYTHON = process.env.DIFY_RUNTIME_PYTHON ?? 'python3'
const DEFAULT_TIMEOUT_MS = 180_000

const PATH_PARAM = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to a Dify workflow .yml file' }
  },
  required: ['path']
}

const RUN_PARAM = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path to a Dify workflow .yml file' },
    inputs: {
      type: 'object',
      description: 'Start-node inputs, keyed by the DSL variable names',
      additionalProperties: true
    },
    maxTokens: { type: 'integer', description: 'Per-LLM-call output token cap (default 1024)' },
    timeout: { type: 'number', description: 'Per-node timeout in seconds (default 30)' },
    tracePath: { type: 'string', description: 'Optional path for a JSONL execution trace' },
    allowUnsupported: {
      type: 'boolean',
      description: 'Do not reject unsupported nodes up front (they will fail only if reached). Default false.'
    }
  },
  required: ['path']
}

const INSPECT_OUT = {
  type: 'object',
  properties: {
    workflow: { type: 'string' },
    mode: { type: 'string' },
    nodeCount: { type: 'integer' },
    nodeTypes: { type: 'object', additionalProperties: true },
    startInputs: { type: 'array', items: { type: 'string' } },
    unsupported: { type: 'array', items: { type: 'object', additionalProperties: true } },
    issues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'object', additionalProperties: true }
  },
  required: ['workflow', 'nodeCount', 'nodeTypes']
}

const RUN_OUT = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: { type: 'string' },
    outputs: { type: 'object', additionalProperties: true },
    answers: { type: 'array', items: { type: 'string' } },
    nodes: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
    durationMs: { type: 'number' },
    usage: { type: 'object', additionalProperties: true }
  },
  required: ['status']
}

function pythonEnv(extra) {
  const env = { ...process.env, ...extra }
  const vendor = join(RUNTIME_ROOT, 'vendor')
  env.PYTHONPATH = [RUNTIME_ROOT, env.PYTHONPATH].filter(Boolean).join(':')
  if (!env.DIFY_PYLIB && existsSync(vendor)) env.DIFY_PYLIB = vendor
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

/** Resolve the z.ai key from the harness credential store, without logging it. */
async function fillLlmKey(ctx, env) {
  if (env.DIFY_LLM_API_KEY || env.ZAI_API_KEY) return
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve('ZAI_API_KEY')
      if (hit && typeof hit.value === 'string' && hit.value.trim() !== '') {
        env.ZAI_API_KEY = hit.value.trim()
        return
      }
    } catch {
      // fall through: the runtime reads ~/.dsh/.credentials.yaml itself
    }
  }
}

function runCli(args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-m', 'dify_runtime', ...args], {
      cwd: cwd ?? process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dify runtime exceeded ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`cannot start ${PYTHON}: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        reject(new Error(`dify runtime returned non-JSON (exit ${code}): ${stderr.slice(-800) || stdout.slice(-800)}`))
        return
      }
      resolve({ code, parsed, stderr })
    })
  })
}

function inspectRender(_args, value) {
  const types = Object.entries(value.nodeTypes ?? {})
    .map(([type, count]) => `${type}×${count}`)
    .join(', ')
  const lines = [
    `Dify workflow "${value.workflow}" (${value.mode || 'unknown mode'}): ${value.nodeCount} nodes — ${types}`,
    `Start inputs: ${(value.startInputs ?? []).join(', ') || '(none)'}`
  ]
  if ((value.unsupported ?? []).length > 0) {
    lines.push(`Unsupported (run will be rejected): ${value.unsupported.map((n) => `${n.type}/${n.id}`).join(', ')}`)
  }
  if ((value.issues ?? []).length > 0) lines.push(`Graph issues: ${value.issues.join('; ')}`)
  lines.push(JSON.stringify(value.summary ?? value, null, 2).slice(0, 6000))
  return [{ type: 'text', text: lines.join('\n') }]
}

function runRender(_args, value) {
  const nodeLines = Object.values(value.nodes ?? {}).map(
    (n) => `- ${n.type} ${n.node} ${n.title ?? ''}: ${n.status}${n.branch ? ` (branch=${n.branch})` : ''}${n.error ? ` — ${n.error}` : ''}`
  )
  const lines = [
    `dify run ${value.runId ?? '(none)'} -> ${value.status}${value.error ? `: ${value.error}` : ''}`,
    `outputs: ${JSON.stringify(value.outputs ?? {})}`,
    nodeLines.join('\n') || '(no nodes executed)',
    `llmCalls=${value.usage?.llmCalls ?? 0}, durationMs=${value.durationMs ?? '?'}`
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

function createInspectTool(ctx) {
  return {
    name: 'dify_inspect',
    description:
      'Parse a Dify workflow .yml and report node types, start inputs, execution order, graph issues and any unsupported node types. Does not execute anything.',
    timeoutMs: 60_000,
    parameters: PATH_PARAM,
    output: { schema: INSPECT_OUT, render: inspectRender },
    async execute(args, exec) {
      const env = pythonEnv()
      await fillLlmKey(ctx, env)
      const { parsed } = await runCli(['inspect', args.path], {
        cwd: exec?.agent?.session?.header?.cwd,
        timeoutMs: 60_000,
        env
      })
      return { ...parsed, summary: parsed }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Inspect Dify workflow', kind: 'other', rawInput: args })
  }
}

function createTranslateTool(ctx) {
  return {
    name: 'dify_translate',
    description:
      'Normalize a Dify workflow .yml into the runtime IR (nodes, adapters, edges, execution order, unsupported list). Optionally writes the IR JSON to disk.',
    timeoutMs: 60_000,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        output: { type: 'string', description: 'Optional path to write the IR JSON' }
      },
      required: ['path']
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 6000) }]
    },
    async execute(args, exec) {
      const env = pythonEnv()
      await fillLlmKey(ctx, env)
      const cliArgs = ['translate', args.path]
      if (args.output) cliArgs.push('--output', args.output)
      const { parsed } = await runCli(cliArgs, {
        cwd: exec?.agent?.session?.header?.cwd,
        timeoutMs: 60_000,
        env
      })
      return parsed
    }
  }
}

function createRunTool(ctx) {
  return {
    name: 'dify_run',
    description:
      'Execute a Dify workflow .yml deterministically on this harness. Returns per-node status, selected branch, final outputs and LLM usage. Unsupported node types are rejected before any execution unless allowUnsupported is set.',
    timeoutMs: DEFAULT_TIMEOUT_MS + 30_000,
    parameters: RUN_PARAM,
    output: { schema: RUN_OUT, render: runRender },
    async execute(args, exec) {
      const env = pythonEnv()
      await fillLlmKey(ctx, env)
      if (args.maxTokens) env.DIFY_LLM_MAX_TOKENS_CAP = String(args.maxTokens)
      const cliArgs = ['run', args.path, '--input', JSON.stringify(args.inputs ?? {})]
      if (args.timeout) cliArgs.push('--timeout', String(args.timeout))
      if (args.tracePath) cliArgs.push('--trace', args.tracePath)
      if (args.allowUnsupported) cliArgs.push('--allow-unsupported')
      const timeoutMs = Math.max(DEFAULT_TIMEOUT_MS, Number(args.timeout ?? 30) * 1000 * 3)
      const { parsed } = await runCli(cliArgs, {
        cwd: exec?.agent?.session?.header?.cwd,
        timeoutMs,
        env
      })
      return { ...parsed, runId: parsed.runId ?? '', error: parsed.error ?? '' }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Run Dify workflow', kind: 'other', rawInput: args })
  }
}

function apply(ctx) {
  ctx.tools.register(createInspectTool(ctx))
  ctx.tools.register(createTranslateTool(ctx))
  ctx.tools.register(createRunTool(ctx))
}

export { apply, createInspectTool, createRunTool, createTranslateTool, inject, name }
export default { apply, inject, name }
