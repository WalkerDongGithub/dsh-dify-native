/**
 * Offline node tests: compile real Dify-shaped graphs, execute the generated
 * orchestration script with a mock `agent()`, and assert the deterministic
 * scheduling/answer/assigner/branch/dataflow behavior.
 *
 *   node tests/nodes.test.mjs
 */
import assert from 'node:assert/strict'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function run(yml, inputs, handler) {
  const compiled = compileGraph(parseDifyDsl(yml))
  const calls = []
  const agent = async (prompt) => {
    const spec = JSON.parse(prompt)
    calls.push(spec)
    return JSON.stringify(await handler(spec))
  }
  const fn = new AsyncFunction('agent', 'phase', 'args', compiled.script)
  const value = await fn(agent, () => {}, inputs)
  return { value, calls, compiled }
}

const start = (extra = '') => `
app: { name: test, mode: ${extra.includes('advanced-chat') ? 'advanced-chat' : 'workflow'} }
workflow:
  conversation_variables: [{ name: user_token, value: "" }, { name: history, value: [] }]
  environment_variables: [{ name: login, value: 0 }]
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [{ variable: q, required: true }] } }
${extra}
`

// 1. advanced-chat with no end: a branch fans out to two terminal answer nodes,
//    and only the selected answer is emitted.
{
  const yml = start(`
      - id: b
        type: custom
        data:
          type: if-else
          title: pick
          cases: [{ case_id: "yes", logical_operator: and, conditions: [{ comparison_operator: "=", value: "1", varType: number, variable_selector: [s, q] }] }]
      - { id: a1, type: custom, data: { type: answer, title: yes, answer: "YES {{#s.q#}}" } }
      - { id: a2, type: custom, data: { type: answer, title: no, answer: "NO" } }
    edges:
      - { source: s, target: b, sourceHandle: source }
      - { source: b, target: a1, sourceHandle: yes }
      - { source: b, target: a2, sourceHandle: false }
`)
  const handler = (spec) => ({ ok: true, outputs: { result: spec.inputs['s.q'] === '1' ? 'yes' : 'false' } })
  const yes = await run(yml, { q: '1' }, handler)
  assert.deepEqual(yes.value.answers, ['YES 1'])
  assert.equal(yes.value.outputs.answer, 'YES 1')
  assert.ok(!('a2' in yes.value.nodes))
  const no = await run(yml, { q: '0' }, handler)
  assert.deepEqual(no.value.answers, ['NO'])
  console.log('ok 1 — advanced-chat answer branch emits exactly the selected answer')
}

// 2. assigner writes conversation/environment scopes and can overwrite a node
//    output; downstream selectors read the new values.
{
  const yml = start(`
      - id: t1
        type: custom
        data: { type: template-transform, title: first, template: "first", variables: [] }
      - id: a1
        type: custom
        data:
          type: assigner
          title: legacy
          assigned_variable_selector: [conversation, user_token]
          input_variable_selector: [s, q]
          write_mode: over-write
      - id: a2
        type: custom
        data:
          type: assigner
          title: append
          items:
            - { variable_selector: [conversation, history], input_type: variable, value: [s, q], operation: append }
            - { variable_selector: [environment, login], input_type: constant, value: 1, operation: over-write }
      - id: a3
        type: custom
        data:
          type: assigner
          title: node-scope
          items:
            - { variable_selector: [t1, output], input_type: constant, value: "second", operation: over-write }
      - id: t2
        type: custom
        data: { type: template-transform, title: read, template: "{{#conversation.user_token#}}|{{#conversation.history#}}|{{#environment.login#}}|{{#t1.output#}}", variables: [] }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [t2, output] }] } }
    edges:
      - { source: s, target: t1, sourceHandle: source }
      - { source: t1, target: a1, sourceHandle: source }
      - { source: a1, target: a2, sourceHandle: source }
      - { source: a2, target: a3, sourceHandle: source }
      - { source: a3, target: t2, sourceHandle: source }
      - { source: t2, target: e, sourceHandle: source }
`)
  const { value } = await run(yml, { q: 'hello' }, () => {
    throw new Error('assigner/template must not call agent()')
  })
  assert.equal(value.outputs.out, 'hello|hello|1|second')
  assert.equal(value.nodes.a1.kind, 'assigner')
  assert.equal(value.nodes.a3.kind, 'assigner')
  console.log('ok 2 — assigner updates conversation/environment/node scopes deterministically')
}

// 3. question-classifier: the provider returns a class, the SCRIPT picks the
//    pre-declared edge. The other class's node never runs.
{
  const yml = start(`
      - id: c
        type: custom
        data:
          type: question-classifier
          title: classify
          query_variable_selector: [s, q]
          classes: [{ id: "health", name: "健康咨询" }, { id: "help", name: "使用帮助" }]
          model: { provider: deepseek, name: deepseek-chat }
      - { id: h, type: custom, data: { type: template-transform, title: health, template: "HEALTH", variables: [] } }
      - { id: u, type: custom, data: { type: template-transform, title: help, template: "HELP", variables: [] } }
      - id: agg
        type: custom
        data: { type: variable-aggregator, title: join, variables: [[h, output], [u, output]] }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [agg, output] }] } }
    edges:
      - { source: s, target: c, sourceHandle: source }
      - { source: c, target: h, sourceHandle: health }
      - { source: c, target: u, sourceHandle: help }
      - { source: h, target: agg, sourceHandle: source }
      - { source: u, target: agg, sourceHandle: source }
      - { source: agg, target: e, sourceHandle: source }
`)
  const { value, calls } = await run(yml, { q: '我睡不着' }, (spec) => {
    assert.equal(spec.kind, 'question-classifier')
    return { ok: true, outputs: { class_id: 'help', class_name: '使用帮助' } }
  })
  assert.equal(value.nodes.c.outputs.class_id, 'help')
  assert.equal(value.outputs.out, 'HELP')
  assert.ok(!('h' in value.nodes))
  assert.equal(calls.length, 1)
  console.log('ok 3 — classifier returns a class; code selects the pre-declared edge')
}

// 4. http-request fail-branch: a failure selects the fail edge, a success the
//    success edge; the model/host never chooses.
{
  const yml = start(`
      - id: h
        type: custom
        data:
          type: http-request
          title: fetch
          method: get
          url: "https://example.test/status"
          error_strategy: fail-branch
          timeout: { max_connect_timeout: 3, max_read_timeout: 3, max_write_timeout: 3 }
      - { id: ok, type: custom, data: { type: template-transform, title: success, template: "OK {{#h.status_code#}}", variables: [] } }
      - { id: bad, type: custom, data: { type: template-transform, title: failure, template: "BAD {{#h.status_code#}}", variables: [] } }
      - id: agg
        type: custom
        data: { type: variable-aggregator, title: join, variables: [[ok, output], [bad, output]] }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [agg, output] }] } }
    edges:
      - { source: s, target: h, sourceHandle: source }
      - { source: h, target: ok, sourceHandle: success-branch }
      - { source: h, target: bad, sourceHandle: fail-branch }
      - { source: ok, target: agg, sourceHandle: source }
      - { source: bad, target: agg, sourceHandle: source }
      - { source: agg, target: e, sourceHandle: source }
`)
  const fail = await run(yml, { q: 'x' }, () => ({
    ok: true,
    branch: 'fail-branch',
    outputs: { status_code: 503, body: 'down' },
  }))
  assert.equal(fail.value.outputs.out, 'BAD 503')
  assert.ok(!('ok' in fail.value.nodes))
  const success = await run(yml, { q: 'x' }, () => ({
    ok: true,
    branch: 'success-branch',
    outputs: { status_code: 200, body: 'up' },
  }))
  assert.equal(success.value.outputs.out, 'OK 200')
  console.log('ok 4 — http-request failure/success selects its pre-declared edge')
}

// 5. tool → knowledge-retrieval dataflow, then a context-injected LLM prompt
//    renders the retrieval segments as text (not `[object Object]`).
{
  const yml = start(`
      - id: tool
        type: custom
        data:
          type: tool
          title: fetch page
          provider_id: jina
          provider_name: jina
          provider_type: builtin
          tool_name: jina_reader
          tool_parameters:
            url: { type: mixed, value: "https://example.test/{{#s.q#}}" }
      - id: kr
        type: custom
        data:
          type: knowledge-retrieval
          title: retrieve
          dataset_ids: [ds1]
          query_variable_selector: [tool, text]
          retrieval_setting: { top_k: 2, score_threshold: 0 }
      - id: llm
        type: custom
        data:
          type: llm
          title: answer
          context: { enabled: true, variable_selector: [kr, result] }
          model: { provider: deepseek, name: deepseek-chat, completion_params: { temperature: 0 } }
          prompt_template:
            - { role: system, text: "KB:{{#context#}}" }
            - { role: user, text: "Q:{{#s.q#}}" }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [llm, text] }] } }
    edges:
      - { source: s, target: tool, sourceHandle: source }
      - { source: tool, target: kr, sourceHandle: source }
      - { source: kr, target: llm, sourceHandle: source }
      - { source: llm, target: e, sourceHandle: source }
`)
  const { value, calls } = await run(yml, { q: 'page' }, (spec) => {
    if (spec.kind === 'tool') {
      assert.equal(spec.toolName, 'jina_reader')
      assert.equal(spec.arguments.url, 'https://example.test/page')
      return { ok: true, outputs: { text: 'wristband pairing', result: 'wristband pairing' } }
    }
    if (spec.kind === 'knowledge-retrieval') {
      assert.equal(spec.query, 'wristband pairing')
      assert.deepEqual(spec.datasetIds, ['ds1'])
      return { ok: true, outputs: { result: [{ content: 'press the button' }, { content: 'open the app' }] } }
    }
    if (spec.kind === 'llm') {
      assert.match(spec.prompt[0].text, /KB:press the button\nopen the app/)
      assert.match(spec.prompt[1].text, /Q:page/)
      return { ok: true, outputs: { text: 'done' } }
    }
    throw new Error(`unexpected ${spec.kind}`)
  })
  assert.equal(value.outputs.out, 'done')
  assert.equal(calls.length, 3)
  console.log('ok 5 — tool → knowledge → context LLM dataflow and segment rendering')
}

console.log('NODE TESTS OK')
