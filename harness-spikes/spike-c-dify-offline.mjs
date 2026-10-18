/**
 * Spike C (offline, harness rc.7 world): real Dify .yml → our compiler →
 * the imported @deepseek-ai/dsh-workflow-worker-thread loop → our `dify-node`
 * provider → ctx.sandbox.confine → real python code node.
 *
 * The only harness departure is the launcher path: this rc.7 workspace is
 * missing its prebuilt landlock binary, so the provider is pointed at the
 * deployed dsh's landlock-run. Nothing about the loop, provider seam, or
 * sandbox code path changes.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { compileGraph, parseDifyDsl } from '../dsh-dify-native/lib/dsl.js'
import { createDifyNodeProvider } from '../dsh-dify-native/lib/provider.js'

const ROOT = new URL('..', import.meta.url).pathname
const LAUNCHER =
  '<dsh>/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'

const ctx = new Context()
await ctx.plugin(LocalSandboxProvider)
ctx.sandbox.internals.landlockLauncher = LAUNCHER
await ctx.plugin(SubagentRuntime)
const provider = createDifyNodeProvider(ctx, {
  name: 'dify-node',
  pythonPath: `${ROOT}/dsh-dify-native/.vendor-code`,
})
ctx.subagents.registerProvider(provider)
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'dify-node' })
console.log('[C] sandbox/sdk ready; sandbox service =', typeof ctx.sandbox.confine)

const parsed = parseDifyDsl(readFileSync(`${ROOT}/dsl/json-repair.yml`, 'utf8'))
const compiled = compileGraph(parsed)
console.log('[C] compiled nodes:', compiled.nodes.map((n) => n.id).join(' -> '))
console.log('[C] script:\n' + compiled.script)

const input = '{"name": "dify", "items": [1,2,], }'
const run = ctx.workflowEngine.start({
  meta: compiled.meta,
  script: compiled.script,
  args: { llm_string: input },
  parent: { session: { id: 'spike-c', header: { cwd: `${ROOT}/runs` } } },
})
const result = await run.result
await run.dispose()
console.log('[C] stopReason =', result.stopReason, '| error =', result.error ?? '')
console.log('[C] value =', JSON.stringify(result.value))

const out = result.value?.outputs?.output
const ok = result.stopReason === 'completed' && out === '{"name": "dify", "items": [1, 2]}'
console.log(ok ? 'SPIKE C OK' : 'SPIKE C FAILED')
process.exit(ok ? 0 : 1)
