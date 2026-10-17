/**
 * Spike B1 — 拿来主义：直接 import 现成的编排循环 @deepseek-ai/dsh-workflow-worker-thread，
 * 在一个最小 Cordis 上下文里把它挂成 ctx.workflowEngine，然后跑一个真实编排脚本
 * （phase / log / parallel / pipeline / 纯 JS stage，无 LLM）。
 *
 * 不写自己的调度器，不启子进程跑脚本——worker 线程由包自己创建。
 * 用的 dsh 源码工作区（0.1.0-rc.7）的包；本目录 node_modules 指向 ~/.dsh/profiles/node_modules。
 */
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const ctx = new Context()
await ctx.plugin(SubagentRuntime)
await ctx.plugin(
  { name: spawnProvider.name, inject: spawnProvider.inject, apply: spawnProvider.apply },
  { providerName: 'spawn' },
)
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'spawn' })

console.log('[B1] engine =', ctx.workflowEngine.constructor.name)
console.log('[B1] providers =', [...ctx.subagents['providers'].keys()])

const phases = []
ctx.on('workflow/phase', (_info, title) => phases.push(title))
ctx.on('workflow/log', (_info, message) => console.log('[script log]', message))

const script = `
phase('准备')
log('纯执行编排开始')
const items = args.items
const doubled = await pipeline(items,
  async (x) => x * 2,
  async (x, original, i) => ({ i, original, doubled: x }),
)
phase('并发')
const triples = await parallel(doubled.map((d) => async () => d.doubled * 3))
phase('汇总')
log('完成 ' + triples.length + ' 项')
return { items, doubled, triples, sum: triples.reduce((a, b) => a + b, 0) }
`

const run = ctx.workflowEngine.start({
  meta: { name: 'spike-b1-pure-orchestration', description: 'pure-JS orchestration loop proof' },
  script,
  args: { items: [1, 2, 3, 4] },
  parent: { session: { id: 'spike-parent' } },
})
const result = await run.result
await run.dispose()

console.log('[B1] stopReason =', result.stopReason)
console.log('[B1] value =', JSON.stringify(result.value))
console.log('[B1] agentsStarted =', result.agentsStarted)
console.log('[B1] phases =', JSON.stringify(phases))

const ok =
  result.stopReason === 'completed' &&
  result.value.sum === 60 &&
  result.value.doubled.length === 4 &&
  result.value.triples.join(',') === '6,12,18,24' &&
  phases.join(',') === '准备,并发,汇总'
console.log(ok ? 'SPIKE B1 OK' : 'SPIKE B1 FAILED')
process.exit(ok ? 0 : 1)
