/**
 * LLM `structured_output` contract tests.
 *
 * Dify's `structured_output_enabled` promises the node's `text` output is a JSON
 * document matching `structured_output.schema`. The host `GenerateOptions` has
 * no response_format, so the provider enforces the contract itself: prompt
 * constraint + ajv validation + one repair round. These tests drive that path
 * with a scripted LLM stub — no network, no model calls.
 *
 *   node tests/structured-output.test.mjs
 */
import assert from 'node:assert/strict'
import { createDifyNodeProvider } from '../lib/provider.js'

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name', 'age'],
}

/** Build a provider whose `ctx.llm` replays a scripted sequence of answers. */
function providerWith(answers) {
  let index = 0
  const llm = {
    listProviders: () => [{ id: 'zai' }],
    // eslint-disable-next-line require-yield
    stream: async function* () {
      const text = answers[Math.min(index, answers.length - 1)]
      index += 1
      yield { type: 'text-delta', text }
      yield { type: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'zai', model: 'glm-4.5-air' }) }
      return undefined
    },
  }
  return {
    provider: createDifyNodeProvider(ctx, { name: 'dify-node' }),
    calls: () => index,
  }
}

const parent = { session: { id: 'probe', header: { cwd: process.cwd() } } }
const spec = (structuredOutput) => ({
  kind: 'llm',
  nodeId: 'l1',
  title: 'structured',
  provider: 'zai',
  model: 'glm-4.5-air',
  prompt: [{ role: 'user', text: 'give me a person' }],
  ...(structuredOutput === undefined ? {} : { structuredOutput }),
})

async function run(provider, nodeSpec) {
  const handle = await provider.start({ prompt: JSON.stringify(nodeSpec), parent, signal: new AbortController().signal })
  const out = await (handle.result ?? handle)
  return JSON.parse(out.output[0].text)
}

// 1. A reply that already satisfies the schema is accepted on the first try.
{
  const { provider, calls } = providerWith(['{"name":"张三","age":18}'])
  const payload = await run(provider, spec({ enabled: true, schema: SCHEMA }))
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.meta.structuredOutput, { validated: true, repaired: false })
  assert.equal(calls(), 1, 'a valid first answer must not trigger a repair round')
  console.log('ok 1 — a schema-valid answer passes without a repair round')
}

// 2. Prose-wrapped JSON is rejected by ajv and repaired once.
{
  const { provider, calls } = providerWith(['当然！{name: 张三, age: 十八}', '{"name":"张三","age":18}'])
  const payload = await run(provider, spec({ enabled: true, schema: SCHEMA }))
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.meta.structuredOutput, { validated: true, repaired: true })
  assert.equal(calls(), 2, 'an invalid answer must cost exactly one repair round')
  assert.deepEqual(JSON.parse(payload.outputs.text), { name: '张三', age: 18 })
  console.log('ok 2 — an invalid answer is repaired once and the valid JSON is returned')
}

// 3. A schema violation (wrong type) is also repaired, not accepted.
{
  const { provider } = providerWith(['{"name":"张三","age":"十八"}', '{"name":"张三","age":18}'])
  const payload = await run(provider, spec({ enabled: true, schema: SCHEMA }))
  assert.equal(payload.ok, true)
  assert.equal(payload.meta.structuredOutput.repaired, true, 'a type mismatch must not pass validation')
  console.log('ok 3 — a wrong-type field is caught by the schema and repaired')
}

// 4. When the repair cannot satisfy the schema, the node fails — never a silent pass.
{
  const { provider } = providerWith(['抱歉我不知道'])
  const payload = await run(provider, spec({ enabled: true, schema: SCHEMA }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /structured_output/)
  assert.match(payload.error, /after one repair round/)
  console.log('ok 4 — an unrepairable answer fails the node instead of passing through')
}

// 5. Without structured_output the text is returned verbatim, untouched.
{
  const { provider } = providerWith(['随便一句不是 JSON 的话'])
  const payload = await run(provider, spec(undefined))
  assert.equal(payload.ok, true)
  assert.equal(payload.outputs.text, '随便一句不是 JSON 的话')
  assert.equal(payload.meta.structuredOutput, undefined, 'no contract means no validation metadata')
  console.log('ok 5 — without structured_output the answer is passed through verbatim')
}

// 6. A schema that is not valid JSON Schema is reported, not crashed on.
{
  const { provider } = providerWith(['{"a":1}'])
  const payload = await run(provider, spec({ enabled: true, schema: { type: 'not-a-real-type' } }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /declared schema is not valid JSON Schema/)
  console.log('ok 6 — an invalid declared schema is reported as a node error')
}

console.log('STRUCTURED OUTPUT TESTS OK')
