/**
 * Container scoping: iteration / loop body results must stay per-item.
 *
 * The compiled script runs inside `vm.Script` (see the dsh workflow engine),
 * which is NOT strict mode. A body-node result written to an undeclared
 * variable therefore lands on the realm's global object — shared by every
 * concurrent item of a parallel iteration. That is a data race: one item can
 * overwrite another's intermediate result between two `await`s.
 *
 * These tests execute the compiled script in a real `vm.Script` realm, the same
 * way the engine does, so a regression in scoping shows up here rather than in
 * production as a wrong answer.
 *
 *   node tests/container-scope.test.mjs
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'

/** Run a compiled script inside a fresh vm realm, like the workflow engine. */
async function runInRealm(script, args, agentImpl) {
  const context = vm.createContext({})
  const parallel = (thunks) =>
    Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk()
        } catch {
          return null
        }
      }),
    )
  Object.assign(context, { agent: agentImpl, parallel, phase: () => {}, log: () => {}, args })
  const value = await new vm.Script(`(async () => {\n${script}\n})()`).runInContext(context)
  return { value, context }
}

/** A parallel iteration whose body has two chained code nodes. */
function parallelIteration(isParallel = true) {
  return `
app: { name: iter, mode: workflow }
kind: app
workflow:
  graph:
    nodes:
      - id: s
        type: custom
        data: { type: start, title: start, variables: [{ variable: items, label: i, type: array, required: true }] }
      - id: iter
        type: custom
        data:
          { type: iteration, title: iter, iterator_selector: [s, items], output_selector: [p2, output],
            is_parallel: ${isParallel}, start_node_id: istart }
      - id: istart
        type: custom
        parentId: iter
        data: { type: iteration-start, title: iteration-start }
      - id: p1
        type: custom
        parentId: iter
        data: { type: code, title: first, code_language: python3, code: "x",
                variables: [{ variable: n, value_selector: [istart, item] }] }
      - id: p2
        type: custom
        parentId: iter
        data: { type: code, title: second, code_language: python3, code: "y",
                variables: [{ variable: prev, value_selector: [p1, output] }] }
      - id: e
        type: custom
        data: { type: end, title: end, outputs: [{ variable: out, value_selector: [iter, output] }] }
    edges:
      - { id: e1, source: s, target: iter }
      - { id: e2, source: istart, target: p1 }
      - { id: e3, source: p1, target: p2 }
      - { id: e4, source: iter, target: e }
`
}

/**
 * An agent that makes the race deterministic: `first` is slow, `second` fast,
 * so item N+1's `first` finishes while item N waits between its two nodes.
 */
function racyAgent(seen) {
  return async (prompt) => {
    const request = JSON.parse(prompt)
    const value = request.inputs?.n ?? request.inputs?.prev
    seen.push({ title: request.title, value })
    await new Promise((resolve) => setTimeout(resolve, request.title === 'first' ? 25 : 1))
    const output = request.title === 'first' ? value * 10 : value + 100
    return JSON.stringify({ ok: true, outputs: { output } })
  }
}

// 1. Sequential iteration stays correct.
{
  const script = compileGraph(parseDifyDsl(parallelIteration(false))).script
  const seen = []
  const { value } = await runInRealm(script, { items: [1, 2, 3] }, racyAgent(seen))
  assert.deepEqual(Array.from(value.outputs.out), [110, 120, 130])
  console.log('ok 1 — sequential iteration keeps per-item results')
}

// 2. Parallel iteration keeps per-item results under interleaving.
{
  const script = compileGraph(parseDifyDsl(parallelIteration(true))).script
  const seen = []
  const { value } = await runInRealm(script, { items: [1, 2, 3, 4] }, racyAgent(seen))
  assert.deepEqual(Array.from(value.outputs.out), [110, 120, 130, 140], 'parallel items must not share body state')
  console.log('ok 2 — parallel iteration keeps per-item results (no shared body state)')
}

// 3. Body results must not leak onto the realm's global object.
{
  const script = compileGraph(parseDifyDsl(parallelIteration(true))).script
  const { context } = await runInRealm(script, { items: [1, 2] }, racyAgent([]))
  const leaked = Object.keys(context).filter((key) => /__i\d+_\d+/.test(key))
  assert.deepEqual(leaked, [], `body result variables leaked to the global scope: ${leaked.join(', ')}`)
  console.log('ok 3 — no body result variable leaks to the global scope')
}

// 4. A nested container (iteration inside iteration) also scopes correctly.
{
  const yaml = `
app: { name: nested, mode: workflow }
kind: app
workflow:
  graph:
    nodes:
      - id: s
        type: custom
        data: { type: start, title: start, variables: [{ variable: rows, label: r, type: array, required: true }] }
      - id: outer
        type: custom
        data:
          { type: iteration, title: outer, iterator_selector: [s, rows], output_selector: [inner, output],
            is_parallel: false, start_node_id: ostart }
      - id: ostart
        type: custom
        parentId: outer
        data: { type: iteration-start, title: o-start }
      - id: inner
        type: custom
        data:
          { type: iteration, title: inner, iterator_selector: [ostart, item], output_selector: [ic, output],
            is_parallel: true, start_node_id: istart }
      - id: istart
        type: custom
        parentId: inner
        data: { type: iteration-start, title: i-start }
      - id: ic
        type: custom
        parentId: inner
        data: { type: code, title: cell, code_language: python3, code: "c",
                variables: [{ variable: v, value_selector: [istart, item] }] }
      - id: e
        type: custom
        data: { type: end, title: end, outputs: [{ variable: out, value_selector: [outer, output] }] }
    edges:
      - { id: e1, source: s, target: outer }
      - { id: e2, source: ostart, target: inner }
      - { id: e3, source: istart, target: ic }
      - { id: e4, source: outer, target: e }
`
  const script = compileGraph(parseDifyDsl(yaml)).script
  const { value } = await runInRealm(script, { rows: [[1, 2], [3, 4]] }, async (prompt) => {
    const request = JSON.parse(prompt)
    await new Promise((resolve) => setTimeout(resolve, 1))
    return JSON.stringify({ ok: true, outputs: { output: request.inputs.v * 2 } })
  })
  const outer = value.outputs.out
  assert.ok(Array.isArray(outer), 'outer iteration must produce an array')
  console.log('ok 4 — nested iteration compiles and runs')
}

console.log('CONTAINER SCOPE TESTS OK')
