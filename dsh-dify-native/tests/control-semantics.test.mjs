import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { compileGraph, parseDifyDsl, inspectGraph } from '../lib/dsl.js'
import { createDifyNodeProvider } from '../lib/provider.js'

// Oracle: langgenius/dify 1.9.1 (cd47a47c3b4acc4d4457b73777722602c33bc950).
// variable_aggregator/variable_aggregator_node.py:VariableAggregatorNode._run,
// entities/variable_pool.py:VariablePool.get, factories/variable_factory.py:build_segment.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const node = (id, type, data = {}, parentId) => ({ id, type: 'custom', ...(parentId ? { parentId } : {}), data: { type, ...data } })
const edge = (source, target, sourceHandle = 'source') => ({ source, target, sourceHandle })
const graph = (nodes, edges) => parseDifyDsl(JSON.stringify({ app: { name: 'semantics', mode: 'workflow' }, workflow: { graph: { nodes, edges } } }))
async function execute(parsed, args = {}, agent = async () => { throw Error('unexpected host call') }) {
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.issues, [])
  return new AsyncFunction('args', 'agent', 'phase', 'parallel', compileGraph(parsed).script)(args, agent, () => {}, async tasks => Promise.all(tasks.map(task => task())))
}

// Real sample: actual provider + Python code execution, deterministic LLM replies.
// Both branch directions run; no network or model service is needed.
async function sample() {
  const parsed = parseDifyDsl(readFileSync(new URL('../../dsl/mature-ticket-triage.yml', import.meta.url), 'utf8'))
  const results = {}
  for (const priority of ['high', 'normal']) {
    const replies = [JSON.stringify({ priority, keywords: ['退款', '到账'] }), '立即核查退款并联系客户。']
    const provider = createDifyNodeProvider({
      get(key) {
        if (key === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: replies.shift() }; yield { type: 'finish', reason: { kind: 'stop' } } } }
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'zai', model: 'glm-4.5-air' }) }
        if (key === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'test' }) }
      },
      on() { return () => {} },
    }, { name: 'dify-node' })
    const result = await execute(parsed, { ticket: '退款尚未到账，请跟进。' }, async prompt => {
      const run = await provider.start({ prompt: [{ type: 'text', text: prompt }], parent: { session: { id: 'semantics', header: { cwd: process.cwd() } } }, signal: new AbortController().signal })
      return (await run.result).output[0].text
    })
    assert.equal(result.outputs.advice, priority === 'high' ? '立即核查退款并联系客户。' : '常规工单，按队列处理。')
    assert.deepEqual(result.outputs.keywords, ['退款', '到账'])
    assert.equal(result.nodes[priority === 'high' ? 'normal' : 'high'], undefined)
    results[priority] = result.outputs
  }
  return results
}
if (process.argv.includes('--sample')) {
  const results = await sample()
  if (process.env.SAMPLE_OUTPUT) writeFileSync(process.env.SAMPLE_OUTPUT, JSON.stringify(results, null, 2) + '\n')
  console.log(JSON.stringify(results, null, 2))
} else {
  const aggregate = (data = {}) => graph([
    node('s', 'start', { variables: [{ variable: 'a' }, { variable: 'b' }] }),
    node('agg', 'variable-aggregator', { variables: [['s', 'a'], ['s', 'b']], ...data }),
    node('e', 'end', { outputs: [{ variable: 'out', value_selector: ['agg', 'output'] }] }),
  ], [edge('s', 'agg'), edge('agg', 'e')])
  for (const [output_type, values] of [['string', ['', 'text']], ['array[string]', [[], ['later']]], ['object', [{}, { later: true }]], ['number', [0, 1]], ['boolean', [false, true]], ['string', [null, 'later']]]) {
    const result = await execute(aggregate({ output_type }), { a: values[0], b: values[1] })
    assert.deepEqual(result.nodes.agg.outputs, { output: values[0] }, `first existing value: ${output_type}`)
  }
  for (const output_type of ['string', 'number', 'object', 'array', 'array[string]']) {
    assert.deepEqual((await execute(aggregate({ output_type }))).nodes.agg.outputs, {}, `no fabricated default: ${output_type}`)
  }
  assert.deepEqual((await execute(aggregate(), { b: 'second' })).nodes.agg.outputs, { output: 'second' })
  const grouped = await execute(aggregate({ advanced_settings: { group_enabled: true, groups: [
    { group_name: 'first', variables: [['s', 'a'], ['s', 'b']], output_type: 'string' },
    { group_name: 'second', variables: [['s', 'b']], output_type: 'string' },
    { group_name: 'missing', variables: [['s', 'absent']], output_type: 'string' },
  ] } }), { a: null, b: 'B' })
  assert.deepEqual(grouped.nodes.agg.outputs, { first: { output: null }, second: { output: 'B' } })
  assert.deepEqual((await execute(aggregate({ advanced_settings: { group_enabled: false, groups: [] } }), { a: '' })).nodes.agg.outputs, { output: '' })
  await sample()
  console.log('CONTROL SEMANTICS TESTS OK')
}
