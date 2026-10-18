/**
 * Minimal per-node execution tests for the round-2 node additions.
 *
 * Every case is a real Dify-shaped .yml, compiled by the real compiler, run by
 * the real `dify-node` provider. LLM-backed nodes are exercised against a
 * scripted `ctx.llm` (the same seam the live profile mounts); code nodes run
 * real python3/node processes; document/datasource nodes read real temp files.
 *
 *   node tests/nodes-new.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileGraph, inspectGraph, parseDifyDsl } from '../lib/dsl.js'
import { createDifyNodeProvider, defaultPythonPath } from '../lib/provider.js'

const ROOT = new URL('..', import.meta.url).pathname
const DSL = join(ROOT, 'dsl')
const TMP = mkdtempSync(join(ROOT, '.tmp-new-'))
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/** A ctx with a scripted LLM service; each call consumes the next reply. */
function makeCtx({ replies = [], tools, web } = {}) {
  const queue = [...replies]
  const llm = {
    listProviders: () => [{ id: 'zai' }],
    stream: async function* () {
      const text = queue.length > 0 ? queue.shift() : ''
      yield { type: 'text-delta', text }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return {
    ctx: {
      get(key) {
        if (key === 'llm') return llm
        if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'zai', model: 'glm-4.5-air' }) }
        if (key === 'tools') return tools
        if (key === 'web') return web
        if (key === 'sandbox') return { confine: async (argv) => ({ argv, enforcement: 'test' }) }
        return undefined
      },
      on() {
        return () => {}
      },
    },
    remaining: () => queue.length,
  }
}

function providerFor(ctx) {
  return createDifyNodeProvider(ctx, {
    name: 'dify-node',
    pythonPath: process.env.DIFY_PYTHONPATH ?? defaultPythonPath(join(ROOT, '..')),
    knowledgeRoot: join(TMP, 'knowledge'),
  })
}

async function runSpec(ctx, spec) {
  const provider = providerFor(ctx)
  const run = await provider.start({
    prompt: [{ type: 'text', text: JSON.stringify(spec) }],
    parent: { session: { id: 'nodes-new', header: { cwd: TMP } } },
    signal: new AbortController().signal,
  })
  return JSON.parse((await run.result).output[0].text)
}

/** Compile a real DSL file and run it, dispatching host nodes to the provider. */
async function runFile(file, inputs, { ctx = makeCtx().ctx } = {}) {
  const parsed = parseDifyDsl(requireFile(file))
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.issues, [], `inspect issues for ${file}`)
  const compiled = compileGraph(parsed)
  const agent = async (prompt) => {
    const spec = JSON.parse(prompt)
    return JSON.stringify(await runSpec(ctx, spec))
  }
  const fn = new AsyncFunction('agent', 'phase', 'args', 'parallel', compiled.script)
  const value = await fn(agent, () => {}, inputs, async (thunks) => Promise.all(thunks.map((thunk) => thunk())))
  return { value, compiled, inspection }
}

/** Same as runFile, but from inline yml text. */
async function runText(text, inputs, { ctx = makeCtx().ctx } = {}) {
  const parsed = parseDifyDsl(text)
  const inspection = inspectGraph(parsed)
  assert.deepEqual(inspection.issues, [])
  const compiled = compileGraph(parsed)
  const agent = async (prompt) => JSON.stringify(await runSpec(ctx, JSON.parse(prompt)))
  const fn = new AsyncFunction('agent', 'phase', 'args', 'parallel', compiled.script)
  const value = await fn(agent, () => {}, inputs, async (thunks) => Promise.all(thunks.map((thunk) => thunk())))
  return { value, compiled, inspection }
}

const requireFile = (name) => readFileSync(join(DSL, name), 'utf8')

const header = (extra = '') => `
app: { name: new-nodes, mode: workflow }
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [{ variable: x }, { variable: items }] } }
${extra}
`

// 1. iteration (parallel) executes one body per item, order preserved, and the
//    container's output_selector becomes the end output.
{
  const { value, compiled } = await runFile('nodes-iteration.yml', { items: ['alpha', 'beta', 'gamma'] })
  assert.match(compiled.script, /await parallel\(/)
  assert.deepEqual(value.outputs.result, ['第0项: alpha', '第1项: beta', '第2项: gamma'])
  assert.equal(value.nodes.iter.kind, 'iteration')
  assert.equal(value.nodes.iter.outputs.length, 3)
  console.log('ok 1 — iteration (is_parallel) maps items through its body, order preserved')
}

// 2. iteration with a HOST node inside the body: the inner selector resolves
//    `iteration-start.item`, one provider call per item, sequential mode.
{
  const yml = header(`
      - id: iter
        type: custom
        data:
          type: iteration
          title: 串行
          iterator_selector: [s, items]
          output_selector: [inner, text]
          error_handle_mode: terminated
          start_node_id: iter-start
      - { id: iter-start, type: custom, parentId: iter, data: { type: iteration-start, title: 开始, isInIteration: true, iteration_id: iter } }
      - id: inner
        type: custom
        parentId: iter
        data:
          type: llm
          title: 每项
          isInIteration: true
          iteration_id: iter
          model: { provider: zai, name: glm-4.5-air }
          prompt_template: [{ role: user, text: "echo {{#iter-start.item#}}" }]
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [iter, output] }] } }
    edges:
      - { source: s, target: iter, sourceHandle: source }
      - { source: iter, target: e, sourceHandle: source }
      - { source: iter-start, target: inner, sourceHandle: source }
`)
  const ctx = makeCtx({ replies: ['E-a', 'E-b'] })
  const { value } = await runText(yml, { items: ['a', 'b'] }, { ctx: ctx.ctx })
  assert.deepEqual(value.outputs.out, ['E-a', 'E-b'])
  assert.equal(ctx.remaining(), 0)
  console.log('ok 2 — iteration body runs a host llm node per item (inner scope + dataflow)')
}

// 3. iteration error modes are code: continue keeps null, remove drops it,
//    terminated propagates the failure.
{
  const body = `
      - id: iter
        type: custom
        data:
          type: iteration
          title: 容错
          iterator_selector: [s, items]
          output_selector: [code, out]
          error_handle_mode: MODE
          start_node_id: iter-start
      - { id: iter-start, type: custom, parentId: iter, data: { type: iteration-start, title: 开始, isInIteration: true, iteration_id: iter } }
      - id: code
        type: custom
        parentId: iter
        data:
          type: code
          title: 失败项
          isInIteration: true
          iteration_id: iter
          code_language: python3
          code: |
            def main(x):
                if x == 2:
                    raise ValueError("boom")
                return {"out": x}
          variables: [{ variable: x, value_selector: [iter-start, item] }]
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [iter, output] }] } }
    edges:
      - { source: s, target: iter, sourceHandle: source }
      - { source: iter, target: e, sourceHandle: source }
      - { source: iter-start, target: code, sourceHandle: source }
`
  const cont = await runText(header(body.replace('MODE', 'continue-on-error')), { items: [1, 2, 3] })
  assert.deepEqual(cont.value.outputs.out, [1, null, 3])
  const removed = await runText(header(body.replace('MODE', 'remove-abnormal-output')), { items: [1, 2, 3] })
  assert.deepEqual(removed.value.outputs.out, [1, 3])
  await assert.rejects(
    () => runText(header(body.replace('MODE', 'terminated')), { items: [1, 2, 3] }),
    /item failed|ValueError|boom/,
  )
  console.log('ok 3 — iteration error_handle_mode: continue→null, remove→skip, terminated→throw')
}

// 4. iteration-end marker: no output_selector, the end marker collects declared
//    outputs per item.
{
  const yml = header(`
      - id: iter
        type: custom
        data: { type: iteration, title: 带结束标记, iterator_selector: [s, items], start_node_id: iter-start }
      - { id: iter-start, type: custom, parentId: iter, data: { type: iteration-start, title: 开始, isInIteration: true, iteration_id: iter } }
      - { id: tpl, type: custom, parentId: iter, data: { type: template-transform, title: 项, isInIteration: true, iteration_id: iter, template: "v={{#iter-start.item#}}", variables: [] } }
      - id: iter-end
        type: custom
        parentId: iter
        data:
          type: iteration-end
          title: 迭代结束
          isInIteration: true
          iteration_id: iter
          outputs: [{ variable: value, value_selector: [tpl, output] }]
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [iter, output] }] } }
    edges:
      - { source: s, target: iter, sourceHandle: source }
      - { source: iter, target: e, sourceHandle: source }
      - { source: iter-start, target: tpl, sourceHandle: source }
      - { source: tpl, target: iter-end, sourceHandle: source }
`)
  const { value, inspection } = await runText(yml, { items: ['a', 'b'] })
  assert.equal(inspection.nodeTypes['iteration-end'], 1)
  assert.deepEqual(value.outputs.out, [{ value: 'v=a' }, { value: 'v=b' }])
  console.log('ok 4 — iteration-end marker is parsed, associated, and collects per-item outputs')
}

// 5. loop: loop_count bounds the body, loop-start exposes the index, loop-end
//    collects declared outputs.
{
  const { value, inspection } = await runFile('nodes-loop.yml', { rounds: 3 })
  assert.equal(inspection.nodeTypes.loop, 1)
  assert.equal(inspection.nodeTypes['loop-start'], 1)
  assert.equal(inspection.nodeTypes['loop-end'], 1)
  assert.deepEqual(value.outputs.result, [{ round: 'round-0' }, { round: 'round-1' }, { round: 'round-2' }])
  console.log('ok 5 — loop runs loop_count rounds, loop-start.index + loop-end outputs')
}

// 6. list-operator: deterministic filter → order → limit over a real array.
{
  const { value } = await runFile('nodes-list-operator.yml', {
    rows: [
      { status: 'ok', score: 1, name: 'a' },
      { status: 'bad', score: 9, name: 'b' },
      { status: 'ok', score: 7, name: 'c' },
      { status: 'ok', score: 5, name: 'd' },
    ],
  })
  assert.deepEqual(value.outputs.result.map((row) => row.name), ['c', 'd'])
  assert.equal(value.outputs.count, 2)
  assert.equal(value.nodes.op.kind, 'list-operator')
  console.log('ok 6 — list-operator filter/order/limit is pure deterministic JS')
}

// 7. trigger-webhook as the graph entry (no start node).
{
  const { value, inspection } = await runFile('nodes-trigger.yml', { topic: '退款' })
  assert.equal(inspection.entry.kind, 'trigger-webhook')
  assert.equal(value.outputs.result, '触发主题: 退款')
  console.log('ok 7 — trigger-webhook is parsed as the entry and feeds downstream nodes')
}

// 8. datasource reads a real local JSON file and exposes records + first fields.
{
  writeFileSync(join(TMP, 'records.jsonl'), '{"id":1,"kind":"a"}\n{"id":2,"kind":"b"}\n')
  const { value } = await runFile('nodes-datasource.yml', {})
  assert.equal(value.nodes.ds.kind, 'datasource')
  assert.equal(value.nodes.ds.outputs.count, 2)
  assert.deepEqual(value.nodes.ds.outputs.records, [
    { id: 1, kind: 'a' },
    { id: 2, kind: 'b' },
  ])
  assert.equal(value.outputs.result, '数据源=records 记录={"id":1,"kind":"a"}')
  console.log('ok 8 — datasource reads a real local JSONL file into IR-scheduled outputs')
}

// 9. document-extractor reads a real text file and returns its text.
{
  writeFileSync(join(TMP, 'doc.txt'), 'hello from a real file\nsecond line')
  const { value } = await runFile('nodes-document-extractor.yml', { doc: join(TMP, 'doc.txt') })
  assert.match(value.outputs.text, /hello from a real file/)
  assert.equal(value.nodes.ext.outputs.count, 1)
  console.log('ok 9 — document-extractor extracts real local text')
}

// 10. code node in javascript AND python3, chained through real processes.
{
  const { value } = await runFile('nodes-code-languages.yml', { n: 20 })
  assert.equal(value.outputs.result, 41)
  assert.equal(value.nodes.js.ok, true)
  assert.equal(value.nodes.py.ok, true)
  console.log('ok 10 — code javascript (node) + python3 both execute through the sandbox seam')
}

// 11. agent node: a real one-turn call through ctx.llm, model/strategy metadata,
//     declared outputs exposed when the reply is JSON.
{
  const ctx = makeCtx({ replies: ['{"summary":"short answer"}'] })
  const spec = await runSpec(ctx.ctx, {
    kind: 'agent',
    nodeId: 'a',
    instruction: 'summarize',
    query: 'long text',
    provider: 'zai',
    model: 'glm-4.5-air',
    strategy: 'function_calling',
    tools: ['web_search'],
    declaredOutputs: ['summary'],
  })
  assert.equal(spec.ok, true)
  assert.equal(spec.outputs.text, '{"summary":"short answer"}')
  assert.equal(spec.outputs.summary, 'short answer')
  assert.equal(spec.meta.mode, 'single-turn')
  assert.deepEqual(spec.meta.toolsRequested, ['web_search'])
  assert.deepEqual(spec.meta.toolsExecuted, [])
  assert.equal(spec.meta.provider, 'zai')
  console.log('ok 11 — agent runs one model turn, parses declared outputs, reports parsed tool policy')
}

// 12. parameter-extractor: real structured extraction, coercion, missing-required
//     flag, and a non-JSON reply that fails closed into __is_success=0.
{
  const good = makeCtx({ replies: ['```json\n{"name":"张三","city":"杭州","tags":["vip","refund"]}\n```'] })
  const extracted = await runSpec(good.ctx, {
    kind: 'parameter-extractor',
    nodeId: 'pe',
    instruction: 'extract',
    query: '张三来自杭州，VIP，要退款',
    provider: 'zai',
    model: 'glm-4.5-air',
    parameters: [
      { name: 'name', type: 'string', required: true },
      { name: 'city', type: 'string', required: false },
      { name: 'tags', type: 'array[string]', required: false },
    ],
  })
  assert.equal(extracted.ok, true)
  assert.equal(extracted.outputs.name, '张三')
  assert.equal(extracted.outputs.city, '杭州')
  assert.deepEqual(extracted.outputs.tags, ['vip', 'refund'])
  assert.equal(extracted.outputs.__is_success, 1)

  const bad = makeCtx({ replies: ['not json at all'] })
  const failed = await runSpec(bad.ctx, {
    kind: 'parameter-extractor',
    nodeId: 'pe2',
    instruction: 'extract',
    query: 'x',
    parameters: [{ name: 'name', type: 'string', required: true }],
  })
  assert.equal(failed.ok, true)
  assert.equal(failed.outputs.__is_success, 0)
  assert.match(failed.outputs.__reason, /not a JSON object/)

  const missing = makeCtx({ replies: ['{"city":"杭州"}'] })
  const incomplete = await runSpec(missing.ctx, {
    kind: 'parameter-extractor',
    nodeId: 'pe3',
    instruction: 'extract',
    query: 'x',
    parameters: [{ name: 'name', type: 'string', required: true }],
  })
  assert.equal(incomplete.outputs.__is_success, 0)
  assert.match(incomplete.outputs.__reason, /missing required parameters: name/)
  console.log('ok 12 — parameter-extractor coerces JSON, flags missing required, fails closed on non-JSON')
}

// 13. human-input: a declared action resolves deterministically and its handle
//     selects the pre-declared branch.
{
  const yml = header(`
      - id: human
        type: custom
        data:
          type: human-input
          title: 人工确认
          form_content: "请确认"
          user_actions: [{ id: approve, title: 通过 }, { id: reject, title: 退回 }]
          inputs: [{ type: paragraph, output_variable_name: comment, default: { type: constant, value: ok } }]
      - { id: yes, type: custom, data: { type: template-transform, title: 通过, template: "APPROVED {{#human.comment#}}", variables: [] } }
      - { id: no, type: custom, data: { type: template-transform, title: 退回, template: "REJECTED", variables: [] } }
      - id: agg
        type: custom
        data: { type: variable-aggregator, title: 合并, variables: [[yes, output], [no, output]] }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [agg, output] }] } }
    edges:
      - { source: s, target: human, sourceHandle: source }
      - { source: human, target: yes, sourceHandle: approve }
      - { source: human, target: no, sourceHandle: reject }
      - { source: yes, target: agg, sourceHandle: source }
      - { source: no, target: agg, sourceHandle: source }
      - { source: agg, target: e, sourceHandle: source }
`)
  const approved = await runText(yml, { x: '1', 'human.human.action': 'approve' })
  assert.equal(approved.value.outputs.out, 'APPROVED ok')
  const rejected = await runText(yml, { x: '1', 'human.human.action': 'reject' })
  assert.equal(rejected.value.outputs.out, 'REJECTED')
  console.log('ok 13 — human-input resolves a declared action and routes its edge deterministically')
}

// 14. knowledge-index and generic passthrough are parsed, scheduled, and visible
//     in the node record instead of being rejected.
{
  const yml = header(`
      - id: ki
        type: custom
        data: { type: knowledge-index, title: 写入, dataset_id: ds1, index_chunk_variable_selector: [s, x] }
      - { id: future, type: custom, data: { type: brand-new-node, title: 未来节点 } }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [future, passthrough] }] } }
    edges:
      - { source: s, target: ki, sourceHandle: source }
      - { source: ki, target: future, sourceHandle: source }
      - { source: future, target: e, sourceHandle: source }
`)
  const { value, inspection } = await runText(yml, { x: 'chunk' })
  assert.deepEqual(inspection.unknownKinds, ['brand-new-node'])
  assert.equal(value.nodes.ki.kind, 'knowledge-index')
  assert.equal(value.nodes.ki.outputs.status, 'not_written')
  assert.equal(value.nodes.future.kind, 'generic')
  assert.equal(value.outputs.out, true)
  console.log('ok 14 — knowledge-index records a real placeholder; unknown type is a visible generic passthrough')
}

rmSync(TMP, { recursive: true, force: true })
console.log('NEW NODE TESTS OK')
