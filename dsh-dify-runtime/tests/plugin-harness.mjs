/**
 * Offline harness for dsh-dify-runtime.  Mirrors the grok-imagine test: build
 * the tools against a stub ctx, then call the real runtime end to end.  This
 * proves the plugin surface (register + execute + render) without booting a
 * full dsh profile.
 *
 *   node tests/plugin-harness.mjs
 */
import { readFileSync } from 'node:fs'

const ROOT = '/home/walker/dify-test'
const CREDS = '/home/walker/.dsh/.credentials.yaml'
const zai = readFileSync(CREDS, 'utf8').match(/^\s*ZAI_API_KEY:\s*(\S+)\s*$/m)?.[1]
if (!zai) throw new Error('no ZAI_API_KEY in credentials')

const mod = await import('../lib/index.js')
console.log('exports:', Object.keys(mod).join(', '), '| name =', mod.name, '| inject =', JSON.stringify(mod.inject))

const registered = []
const fakeCtx = {
  get(key) {
    if (key === 'credentials') return { resolve: async (ref) => (ref === 'ZAI_API_KEY' ? { value: zai, source: 'test' } : undefined) }
    return undefined
  },
  tools: { register: (definition) => { registered.push(definition); return () => {} } }
}

mod.apply(fakeCtx)
console.log('registered tools:', registered.map((t) => t.name).join(', '))
if (registered.length !== 3) throw new Error(`expected 3 tools, got ${registered.length}`)
for (const tool of registered) {
  const blocks = tool.output.render({}, { status: 'succeeded', workflow: 'x', nodeTypes: { start: 1 }, nodes: {}, outputs: {} })
  if (!Array.isArray(blocks) || blocks[0]?.type !== 'text') throw new Error(`${tool.name}: render did not return text blocks`)
}

const inspect = registered.find((t) => t.name === 'dify_inspect')
const run = registered.find((t) => t.name === 'dify_run')

const insp = await inspect.execute({ path: `${ROOT}/dsl/json-repair.yml` }, {})
console.log('inspect:', insp.workflow, insp.nodeTypes, 'unsupported =', insp.unsupported.length)

const result = await run.execute(
  {
    path: `${ROOT}/dsl/json-repair.yml`,
    inputs: { llm_string: '{"a": 1, "b": [1,2,], }' },
    tracePath: `${ROOT}/runs/plugin-json-repair.trace.jsonl`
  },
  { agent: { session: { header: { cwd: ROOT } } } }
)
console.log('run status:', result.status, '| output:', JSON.stringify(result.outputs))
console.log('nodes:', Object.values(result.nodes).map((n) => `${n.type}:${n.status}`).join(' '))
console.log('render:\n' + run.output.render({}, result)[0].text)

if (result.status !== 'succeeded') throw new Error('json-repair did not succeed')
if (result.outputs.output !== '{"a": 1, "b": [1, 2]}') throw new Error('unexpected repaired JSON')

const llmResult = await run.execute(
  {
    path: `${ROOT}/dsl/seo-slug.yml`,
    inputs: { title: 'Build a Dify workflow on a small server' },
    maxTokens: 64
  },
  { agent: { session: { header: { cwd: ROOT } } } }
)
console.log('llm run:', llmResult.status, '| output:', JSON.stringify(llmResult.outputs), '| calls:', llmResult.usage.llmCalls)
if (llmResult.status !== 'succeeded' || !llmResult.outputs.output) throw new Error('seo-slug did not succeed')

console.log('PLUGIN HARNESS OK')
