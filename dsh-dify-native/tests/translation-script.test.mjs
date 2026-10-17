/**
 * Offline execution check: run the compiled translation script with a mock
 * `agent()` for both if-else branches. Proves branch activation, join, prompt
 * dataflow, and end binding without a harness or a model call.
 *
 *   node tests/translation-script.test.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const parsed = parseDifyDsl(readFileSync('/home/walker/dify-test/dsl/translation.yml', 'utf8'))
const compiled = compileGraph(parsed)

const isEmpty = (value) => value === undefined || value === null || value === ''

function makeAgent(calls) {
  return async (prompt) => {
    const spec = JSON.parse(prompt)
    calls.push(spec)
    if (spec.kind === 'if-else') {
      const country = spec.inputs['1721117927142.country']
      return JSON.stringify({ ok: true, outputs: { result: isEmpty(country) ? 'true' : 'false' } })
    }
    if (spec.kind === 'llm') {
      const user = spec.prompt.filter((p) => p.role !== 'system').map((p) => p.text).join('\n')
      const all = spec.prompt.map((p) => p.text).join('\n')
      if (spec.title === 'TRANSLATION') {
        return JSON.stringify({ ok: true, outputs: { text: `[translated:${spec.prompt[0].text.includes('Portuguese') ? 'pt' : 'zh'}]` } })
      }
      if (spec.title.startsWith('EXPERT_SUGGESTIONS')) {
        return JSON.stringify({ ok: true, outputs: { text: `[suggestions:${spec.title}:${all.includes('translated') ? 'saw-translation' : 'missing'}]` } })
      }
      return JSON.stringify({ ok: true, outputs: { text: `[improved]<${user.match(/<EXPERT_SUGGESTIONS>\n([^\n]*)/)?.[1] ?? ''}>` } })
    }
    throw new Error(`unexpected node kind ${spec.kind}`)
  }
}

async function run(inputs) {
  const calls = []
  const fn = new AsyncFunction('agent', 'phase', 'args', compiled.script)
  const value = await fn(makeAgent(calls), () => {}, inputs)
  return { value, calls }
}

// Branch true: country empty → EXPERT_SUGGESTIONS (no country), aggregator joins, improve runs.
{
  const { value, calls } = await run({
    source_text: 'The quick brown fox jumps over the lazy dog.',
    source_lang: 'English',
    target_lang: 'Chinese',
    country: '',
  })
  assert.deepEqual(Object.keys(value.nodes), [
    '1721117961155',
    '1721118545228',
    '1721118559807',
    '1721118847307',
    '1721118907775',
  ])
  assert.equal(value.nodes['1721118545228'].outputs.result, 'true')
  assert.match(value.nodes['1721118847307'].outputs.output, /^\[suggestions:EXPERT_SUGGESTIONS:/)
  assert.equal(value.outputs.output, '[improved]<[suggestions:EXPERT_SUGGESTIONS:saw-translation]>')
  assert.equal(calls.filter((c) => c.kind === 'llm').length, 3)
  console.log('ok 1 — country empty → true branch, 3 LLM nodes, join + end correct')
}

// Branch false: country present → EXPERT_SUGGESTIONS_WITH_COUNTRY; omitted country counts as empty.
{
  const { value, calls } = await run({
    source_text: 'Good morning, how are you?',
    source_lang: 'English',
    target_lang: 'Portuguese',
    country: 'Brazil',
  })
  assert.equal(value.nodes['1721118545228'].outputs.result, 'false')
  assert.ok(!('1721118559807' in value.nodes))
  assert.match(value.nodes['1721118847307'].outputs.output, /EXPERT_SUGGESTIONS_WITH_COUNTRY/)
  assert.match(value.outputs.output, /\[improved\]/)
  assert.equal(calls.filter((c) => c.kind === 'llm').length, 3)
  console.log('ok 2 — country set → false branch, 3 LLM nodes, join + end correct')
}

// Omitted optional country behaves like the empty case.
{
  const { value } = await run({
    source_text: 'Hello.',
    source_lang: 'English',
    target_lang: 'French',
  })
  assert.equal(value.nodes['1721118545228'].outputs.result, 'true')
  console.log('ok 3 — omitted optional country → true branch')
}

console.log('TRANSLATION SCRIPT TESTS OK')

// Template-transform compiles to plain JS (no agent call) and renders both
// `{{ name }}` bindings and `{{#node.var#}}` references.
{
  const yml = `
app: { name: template-check, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [{ variable: x }] } }
      - id: t
        type: custom
        data:
          type: template-transform
          title: greet
          template: "Hello {{ name }} / {{#s.x#}}"
          variables: [{ variable: name, value_selector: [s, x] }]
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [t, output] }] } }
    edges:
      - { source: s, target: t, sourceHandle: source }
      - { source: t, target: e, sourceHandle: source }
`
  const compiledTemplate = compileGraph(parseDifyDsl(yml))
  const fn = new AsyncFunction('agent', 'phase', 'args', compiledTemplate.script)
  const value = await fn(async () => {
    throw new Error('template-transform must not call agent()')
  }, () => {}, { x: 'world' })
  assert.equal(value.outputs.out, 'Hello world / world')
  console.log('ok 4 — template-transform renders in-script without an agent call')
}

console.log('TRANSLATION SCRIPT TESTS OK (extended)')
