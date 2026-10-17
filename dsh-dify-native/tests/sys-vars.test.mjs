/**
 * Session identity inside a Dify graph: `{{#sys.conversation_id#}}` and
 * `{{#sys.dialogue_count#}}` are injected from the calling harness session.
 *
 * The contract:
 *   - a compiled graph reads the run's `args['sys.*']`, not a compiler constant;
 *   - the run injects the session id and the count of real user turns;
 *   - a run with no session keeps Dify's empty defaults and still executes.
 *
 *   node tests/sys-vars.test.mjs
 */
import assert from 'node:assert/strict'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'

const YML = `app: { name: sys-vars, mode: workflow }
kind: app
version: 0.1.5
workflow:
  graph:
    nodes:
      - { id: s, type: custom, data: { type: start, variables: [{ variable: q, type: text-input, required: true }] } }
      - { id: l, type: custom, data: { type: llm, title: 模型, model: { provider: zai, name: glm-4.5-air }, prompt_template: [{ role: user, text: "会话={{#sys.conversation_id#}} 第{{#sys.dialogue_count#}}轮 问:{{#s.q#}}" }] } }
      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [l, text] }] } }
    edges:
      - { id: e1, source: s, target: l, sourceHandle: source }
      - { id: e2, source: l, target: e, sourceHandle: source }
`

/** Run the compiled script with a fake `agent` and capture the LLM prompt. */
async function renderPrompt(args) {
  const script = compileGraph(parseDifyDsl(YML)).script
  let captured
  const agent = async (specJson) => {
    captured = JSON.parse(specJson)
    return JSON.stringify({ ok: true, outputs: { text: 'ok', usage: {} } })
  }
  const fn = new Function('agent', 'phase', 'args', `(async () => { ${script} })()`)
  await fn(agent, () => {}, args)
  return captured.prompt[0].text
}

// ------------------------------------------------------------ compiled shape

{
  const script = compileGraph(parseDifyDsl(YML)).script
  assert.match(script, /conversation_id: args\['sys\.conversation_id'\]/, 'reads the session id from run args')
  assert.match(script, /dialogue_count: args\['sys\.dialogue_count'\]/, 'reads the turn count from run args')
  console.log("ok 1 — the compiled script sources sys.conversation_id / dialogue_count from args['sys.*']")
}

// --------------------------------------------------- identity reaches a node

{
  const prompt = await renderPrompt({
    q: '那有什么好吃的',
    'sys.conversation_id': 'session-abc',
    'sys.dialogue_count': 4,
  })
  assert.equal(prompt, '会话=session-abc 第4轮 问:那有什么好吃的')
  console.log('ok 2 — a graph renders the calling session id and turn count into a prompt')
}

// ------------------------------------------------------- no session defaults

{
  const prompt = await renderPrompt({ q: 'hi' })
  assert.equal(prompt, '会话= 第0轮 问:hi', 'Dify defaults: empty id, zero turns')
  console.log('ok 3 — without a session the run keeps Dify defaults and still executes')
}

// ------------------------------------ the same graph, a different conversation

{
  const a = await renderPrompt({ q: 'x', 'sys.conversation_id': 'session-a', 'sys.dialogue_count': 1 })
  const b = await renderPrompt({ q: 'x', 'sys.conversation_id': 'session-b', 'sys.dialogue_count': 7 })
  assert.notEqual(a, b, 'the graph sees the calling session, not a compile-time constant')
  assert.match(a, /session-a/)
  assert.match(b, /session-b/)
  console.log('ok 4 — one compiled graph distinguishes the sessions that call it')
}

console.log('SYS VARS TESTS OK')
