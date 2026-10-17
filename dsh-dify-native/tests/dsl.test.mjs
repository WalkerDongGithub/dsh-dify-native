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

// 5. every Dify node type is parsed: a container compiles, and an unknown
//    future type is a visible generic passthrough (never "unsupported").
{
  const yml = `
app: { name: containers, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [] } }
      - id: i
        type: custom
        data:
          type: iteration
          title: loop
          iterator_selector: [s, items]
          output_selector: [tpl, output]
          start_node_id: i-start
      - { id: i-start, type: custom, parentId: i, data: { type: iteration-start, title: start, isInIteration: true, iteration_id: i } }
      - { id: tpl, type: custom, parentId: i, data: { type: template-transform, title: body, isInIteration: true, iteration_id: i, template: "{{#i-start.item#}}", variables: [] } }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [i, output] }] } }
    edges:
      - { source: s, target: i, sourceHandle: source }
      - { source: i, target: e, sourceHandle: source }
      - { source: i-start, target: tpl, sourceHandle: source }
`
  const parsed = parseDifyDsl(yml)
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  assert.equal(inspection.nodeTypes.iteration, 1)
  assert.equal(inspection.nodeTypes['iteration-start'], 1)
  assert.equal(inspection.containers.length, 1)
  assert.deepEqual(inspection.containers[0].children, ['i-start', 'tpl'])
  const compiled = compileGraph(parsed)
  assert.match(compiled.script, /__out0/)
  assert.match(compiled.script, /__itemIt0/)

  const future = `
app: { name: future, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [] } }
      - { id: x, type: custom, data: { type: brand-new-node, title: future } }
      - { id: e, type: custom, data: { type: end, outputs: [] } }
    edges:
      - { source: s, target: x, sourceHandle: source }
      - { source: x, target: e, sourceHandle: source }
`
  const futureParsed = parseDifyDsl(future)
  const futureInspection = inspectGraph(futureParsed)
  assert.deepEqual(futureInspection.unsupported, [])
  assert.deepEqual(futureInspection.unknownKinds, ['brand-new-node'])
  assert.ok(futureInspection.warnings.some((warning) => /generic passthrough/.test(warning)))
  const futureCompiled = compileGraph(futureParsed)
  assert.match(futureCompiled.script, /kind: 'generic'/)
  console.log('ok 5 — iteration compiles as a container; unknown types are visible generic passthroughs')
}

// 6. non-branch fan-out (two arms off one node) is a legal Dify shape: both
//    arms are compiled behind their own dataflow guards, no edge is guessed.
{
  const yml = `
app: { name: split, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [] } }
      - { id: c1, type: custom, data: { type: code, code: "def main(): return {}", variables: [] } }
      - { id: c2, type: custom, data: { type: code, code: "def main(): return {}", variables: [] } }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: one, value_selector: [c1, result] }, { variable: two, value_selector: [c2, result] }] } }
    edges:
      - { source: s, target: c1, sourceHandle: source }
      - { source: s, target: c2, sourceHandle: source }
      - { source: c1, target: e, sourceHandle: source }
      - { source: c2, target: e, sourceHandle: source }
`
  const parsed = parseDifyDsl(yml)
  assert.deepEqual(inspectGraph(parsed).issues, [])
  const compiled = compileGraph(parsed)
  assert.equal(compiled.order.length, 4)
  assert.match(compiled.script, /__ran\["s"\] === true/)
  console.log('ok 6 — non-branch fan-out compiles as guarded parallel arms')
}

// 7. real form-demo (advanced-chat: answer / assigner / template) compiles.
{
  const parsed = parseDifyDsl(read('form-demo.yml'))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  assert.equal(inspection.answerCount, 3)
  const compiled = compileGraph(parsed)
  assert.equal(compiled.order.length, 10)
  assert.match(compiled.script, /__answers\.push/)
  assert.match(compiled.script, /__vars\["conversation"\]\["user_token"\]/)
  assert.match(compiled.script, /kind: 'assigner'/)
  console.log('ok 7 — form-demo compiles (answers + assigner + advanced-chat, no end)')
}

// 8. real intent-reply (question-classifier / knowledge-retrieval / context)
//    compiles, with class ids used as edge handles.
{
  const parsed = parseDifyDsl(read('intent-reply.yml'))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.unsupported, [])
  const compiled = compileGraph(parsed)
  assert.match(compiled.script, /"kind":"question-classifier"/)
  assert.match(compiled.script, /__branch\["1718246909580"\] = String\(__r1\.outputs\.class_id\)/)
  assert.match(compiled.script, /__branch\["1718246909580"\] === "1715846546749"/)
  assert.match(compiled.script, /"kind":"knowledge-retrieval"/)
  assert.match(compiled.script, /__text\(__r0\?\.outputs\["text"\]\)/)
  assert.match(compiled.script, /__text\(__r3\?\.outputs\["result"\]\)/)
  console.log('ok 8 — intent-reply compiles (classifier edges + knowledge + {{#context#}})')
}

// 9. iteration `flatten_output: true` concatenates per-item arrays into one flat
//    array; without the flag the per-item values stay nested (Dify's behaviour).
{
  const yml = (flatten) => `
app:
  name: flatten-probe
  mode: workflow
kind: app
version: 0.1.0
workflow:
  graph:
    nodes:
      - id: s
        data:
          type: start
          variables:
            - variable: rows
              type: array[string]
              required: true
      - id: it
        data:
          type: iteration
          iterator_selector: [s, rows]
          output_selector: [inner, output]
          output_type: array[array[string]]
          start_node_id: it-start
          ${flatten ? 'flatten_output: true' : ''}
      - id: it-start
        parentId: it
        data:
          type: iteration-start
      - id: inner
        parentId: it
        data:
          type: template-transform
          template: '{{#it.item#}}'
          variables:
            - variable: it
              value_selector: [it, item]
      - id: e
        data:
          type: end
          outputs:
            - variable: out
              value_selector: [it, output]
    edges:
      - { source: s, target: it }
      - { source: it-start, target: inner }
      - { source: it, target: e }
`
  const flat = compileGraph(parseDifyDsl(yml(true)))
  assert.match(flat.script, /\.flat\(\)/, 'flatten_output: true must emit a .flat() over the collected items')
  const nested = compileGraph(parseDifyDsl(yml(false)))
  assert.doesNotMatch(nested.script, /\.flat\(\)/, 'without flatten_output the output must stay nested')
  // The field is consumed, so it must never be reported as a dropped field.
  const inspection = inspectGraph(parseDifyDsl(yml(true)))
  assert.equal(
    (inspection.diagnostics ?? []).filter((row) => row.subject === 'it:flatten_output').length,
    0,
    'flatten_output is implemented, so it must not be reported as a dropped field',
  )
  console.log('ok 9 — iteration flatten_output flattens only when enabled')
}

console.log('DSL TESTS OK')
