import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import plugin from '../../lib/index.js'

// Resolve the installed dsh distribution, never a substitute engine implementation.
const entry = process.env.DSH_ENTRY ?? realpathSync(execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim())
const requireDsh = createRequire(entry)
export async function dsh(name) {
  return import(pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href)
}
export async function realHarness(cwd) {
  const { Context } = await dsh('cordis')
  const ctx = new Context()
  const fibers = []
  for (const [name, config] of [
    ['dsh-session', {}], ['dsh-session-projection', {}],
    ['dsh-system-prompt', {}], ['dsh-tools', {}],
    ['dsh-fs-local', { cwd }], ['dsh-subprocess-local', {}],
    ['dsh-sandbox-local', {}], ['dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }],
    ['dsh-tool-fs-search', { sampleOverCapGlobResults: false }], ['dsh-subagent', {}], ['dsh-ptc-runtime-node', {}], ['dsh-workflow-ptc', {}],
  ]) {
    const module = await dsh(name)
    fibers.push(await ctx.plugin(module.default ?? module, config))
  }
  fibers.push(await ctx.plugin(plugin))
  if (!ctx.workflowEngine || !ctx.subagents.getProvider('dify-node')) throw new Error('real harness services failed to mount')
  const session = ctx.sessions.create('dify-e2e', { meta: { cwd } })
  return { ctx, parent: { session }, async run(path, inputs = {}) {
    const tool = ctx.tools.get('dify_native_run')
    return tool.execute({ path: resolve(path), inputs }, { agent: { session } })
  }, async close() { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}
