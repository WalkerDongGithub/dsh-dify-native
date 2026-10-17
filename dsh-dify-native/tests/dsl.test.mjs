/**
 * Offline compiler checks (no harness, no execution):
 *   node tests/dsl.test.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { compileGraph, inspectGraph, parseDifyDsl } from '../lib/dsl.js'

const ROOT = '/home/walker/dify-test/dsl'
const read = (name) => readFileSync(`${ROOT}/${name}`, 'utf8')

// 1. json-repair: linear start → code → end compiles.
{
  const parsed = parseDifyDsl(read('json-repair.yml'))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  assert.deepEqual(inspection.startInputs, ['llm_string'])
  assert.deepEqual(inspection.endOutputs, ['output'])
  const compiled = compileGraph(parsed)
  assert.match(compiled.script, /agent\(JSON\.stringify\(__req0\)/)
  assert.match(compiled.script, /__r0\?\.outputs\["result"\]/)
  assert.match(compiled.script, /return \{ nodes: __nodes, outputs:/)
  assert.equal(compiled.order.length, 3)
  console.log('ok 1 — json-repair compiles (start → code → end)')
}

// 2. seo-slug: one LLM node compiles; the prompt is a concrete JS expression.
{
  const parsed = parseDifyDsl(read('seo-slug.yml'))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  assert.deepEqual(inspection.nodeTypes, { start: 1, llm: 1, end: 1 })
  const compiled = compileGraph(parsed)
  assert.match(compiled.script, /"kind":"llm"/)
  assert.match(compiled.script, /__req0\.prompt\[0\]\.text = /)
  assert.match(compiled.script, /args\["title"\]/)
  console.log('ok 2 — seo-slug compiles (1 LLM node, prompt inlined)')
}

// 3. translation: LLM + if-else + variable-aggregator + end compile as a guarded DAG.
{
  const parsed = parseDifyDsl(read('translation.yml'))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  assert.deepEqual(inspection.nodeTypes, { start: 1, llm: 4, 'if-else': 1, 'variable-aggregator': 1, end: 1 })
  assert.deepEqual(inspection.requiredInputs, ['target_lang', 'source_text', 'source_lang'])
  const compiled = compileGraph(parsed)
  assert.equal(compiled.order.length, 8)
  const script = compiled.script
  assert.match(script, /__branch\["1721118545228"\] === "true"/)
  assert.match(script, /__branch\["1721118545228"\] === "false"/)
  assert.match(script, /__pick = \[__r2\?\.outputs\["text"\], __r3\?\.outputs\["text"\]\]/)
  assert.match(script, /__req4\.prompt\[1\]\.text = .*__r4\?\.outputs\["output"\]/)
  assert.match(script, /"output": \(__r5\?\.outputs\["text"\] === undefined \? null : __r5\?\.outputs\["text"\]\)/)
  console.log('ok 3 — translation compiles (4 LLM + if-else + aggregator, branch guards)')
}

// 4. synthetic two-code chain: dataflow across code nodes compiles.
{
  const yml = `
app: { name: two-code, mode: workflow }
workflow:
  graph:
    nodes:
      - id: s
        type: custom
        data: { type: start, title: start, variables: [{ variable: x }] }
      - id: c1
        type: custom
        data:
          type: code
          title: first
          code: "def main(x):\\n    return {\\"y\\": x + 1}\\n"
          variables: [{ variable: x, value_selector: [s, x] }]
          outputs: { y: { type: number } }
      - id: c2
        type: custom
        data:
          type: code
          title: second
          code: "def main(y):\\n    return {\\"z\\": y * 2}\\n"
          variables: [{ variable: y, value_selector: [c1, y] }]
          outputs: { z: { type: number } }
      - id: e
        type: custom
        data: { type: end, title: end, outputs: [{ variable: z, value_selector: [c2, z] }] }
    edges:
      - { source: s, target: c1, sourceHandle: source }
      - { source: c1, target: c2, sourceHandle: source }
      - { source: c2, target: e, sourceHandle: source }
`
  const parsed = parseDifyDsl(yml)
  assert.deepEqual(inspectGraph(parsed).unsupported, [])
  const compiled = compileGraph(parsed)
  assert.match(compiled.script, /__r0\?\.outputs\["y"\]/)
  assert.deepEqual(compiled.nodes.map((n) => n.id), ['c1', 'c2'])
  console.log('ok 4 — synthetic two-code chain compiles with cross-node dataflow')
}

// 5. an unsupported node type still fails closed.
{
  const parsed = parseDifyDsl(read('form-demo.yml'))
  const inspection = inspectGraph(parsed)
  assert.ok(inspection.unsupported.some((n) => n.type === 'answer'))
  assert.throws(() => compileGraph(parsed), /unsupported node types/)
  console.log('ok 5 — form-demo rejected (answer/assigner unsupported, fail closed)')
}

// 6. a node with two outgoing edges that is not if-else is rejected.
{
  const yml = `
app: { name: split, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [] } }
      - { id: c1, type: custom, data: { type: code, code: "def main(): return {}", variables: [] } }
      - { id: c2, type: custom, data: { type: code, code: "def main(): return {}", variables: [] } }
      - { id: e, type: custom, data: { type: end, outputs: [] } }
    edges:
      - { source: s, target: c1, sourceHandle: source }
      - { source: s, target: c2, sourceHandle: source }
      - { source: c1, target: e, sourceHandle: source }
      - { source: c2, target: e, sourceHandle: source }
`
  const parsed = parseDifyDsl(yml)
  assert.throws(() => compileGraph(parsed), /outgoing edges/)
  console.log('ok 6 — non-if-else split rejected (no guessed scheduling)')
}

console.log('DSL TESTS OK')
