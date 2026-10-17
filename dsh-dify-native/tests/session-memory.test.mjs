/**
 * Session-backed Dify memory: an LLM node's `memory.window` is fed from the
 * harness session log instead of a Dify Conversation/Message table.
 *
 * The contract:
 *   - only real user turns count (protocol-injected user messages are skipped);
 *   - an assistant message carrying tool calls is agent work, not an answer;
 *   - `memory.window.size` keeps the most recent N messages, disabled keeps none;
 *   - `role_prefix` drives the `Human:` / `Assistant:` render, defaulting to Dify's;
 *   - a run with no session behaves exactly as before (no history, no failure).
 *
 *   node tests/session-memory.test.mjs
 */
import assert from 'node:assert/strict'
import { applyMemoryWindow, deriveChatHistory, memoryOptions, toPromptText } from '../lib/session-history.js'

/** Build a dsh-derived message the way `session.deriveMessages()` shapes it. */
const userMsg = (text, source = { kind: 'user' }) => ({ role: 'user', source, content: [{ type: 'text', text }] })
const assistantMsg = (blocks, source = { kind: 'model' }) => ({ role: 'assistant', source, content: blocks })
const textBlock = (text) => ({ type: 'text', text })
const toolCall = (name) => ({ type: 'tool-call', name, id: `call_${name}` })

// ------------------------------------------------------- real user turns only

{
  const messages = [
    // Protocol injection: a reminder injected as a user message, not the user talking.
    userMsg('The following workspace instructions may be relevant', { kind: 'plugin', form: 'instructions' }),
    userMsg('Current runtime context.', { kind: 'plugin', form: 'snapshot' }),
    userMsg('我想去北京旅游'),
    assistantMsg([textBlock('北京不错，想看什么？')]),
    userMsg('那有什么好吃的'),
    assistantMsg([textBlock('北京烤鸭很有名。')]),
  ]
  const history = deriveChatHistory(messages)
  assert.deepEqual(history, [
    { role: 'user', content: '我想去北京旅游' },
    { role: 'assistant', content: '北京不错，想看什么？' },
    { role: 'user', content: '那有什么好吃的' },
    { role: 'assistant', content: '北京烤鸭很有名。' },
  ])
  console.log('ok 1 — injected user messages are skipped; only real user turns enter history')
}

// ----------------------------------------------- agent work is not an answer

{
  const messages = [
    userMsg('帮我看下项目'),
    // An intermediate assistant message that calls tools is agent work.
    assistantMsg([textBlock('我先看看'), toolCall('bash')]),
    // The turn's final prose is the answer.
    assistantMsg([textBlock('这是个 Dify 运行时。')]),
  ]
  const history = deriveChatHistory(messages)
  assert.deepEqual(history, [
    { role: 'user', content: '帮我看下项目' },
    { role: 'assistant', content: '这是个 Dify 运行时。' },
  ])
  console.log('ok 2 — an assistant message carrying tool calls is excluded from chat history')
}

// ------------------------------------------------------------- memory window

{
  const history = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ]
  // Dify counts messages, not pairs: size 2 keeps the two most recent.
  assert.deepEqual(applyMemoryWindow(history, { enabled: true, size: 2 }), [
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ])
  assert.equal(applyMemoryWindow(history, { enabled: true, size: null }).length, 6, 'no size keeps everything')
  assert.deepEqual(applyMemoryWindow(history, { enabled: false, size: 10 }), [], 'a disabled window keeps nothing')
  console.log('ok 3 — window.size keeps the most recent N messages; disabled keeps none')
}

// --------------------------------------------------------------- role prefix

{
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]
  assert.equal(toPromptText(history), 'Human: hi\nAssistant: hello', 'defaults match Dify')
  assert.equal(
    toPromptText(history, { user: '用户', assistant: '助手' }),
    '用户: hi\n助手: hello',
    'declared prefixes win',
  )
  console.log('ok 4 — role_prefix drives the render and defaults to Dify Human/Assistant')
}

// ------------------------------------------------- memory block normalization

{
  assert.deepEqual(memoryOptions(undefined), { enabled: false, size: null, rolePrefix: {} })
  assert.deepEqual(memoryOptions({ window: { enabled: true, size: 3 }, role_prefix: { user: 'u' } }), {
    enabled: true,
    size: 3,
    rolePrefix: { user: 'u' },
  })
  console.log('ok 5 — a node without memory stays disabled; an enabled block carries size and prefixes')
}

// ------------------------------------------------------ no session, no crash

{
  // The provider falls back to an empty history when the run has no session, so
  // a one-shot call must behave exactly as before.
  const history = deriveChatHistory(undefined)
  assert.deepEqual(history, [])
  assert.deepEqual(deriveChatHistory([]), [])
  console.log('ok 6 — a run without a session yields empty history instead of failing')
}

// ------------------------------------------- the real two-turn chat scenario

{
  // Simulates the second turn: the history from turn one is available, so a
  // follow-up that omits the subject still carries it into the prompt.
  const session1 = [userMsg('我想去北京旅游')]
  const turn1 = deriveChatHistory(session1)
  const session2 = [...session1, assistantMsg([textBlock('北京不错，想看什么？')]), userMsg('那有什么好吃的')]
  const historyForTurn2 = applyMemoryWindow(deriveChatHistory(session2), { enabled: true, size: 5 })
  const rendered = toPromptText(historyForTurn2)
  assert.match(rendered, /北京/)
  assert.match(rendered, /那有什么好吃的/)
  assert.ok(turn1.length === 1, 'first turn saw only its own user message')
  console.log('ok 7 — the follow-up prompt carries the earlier "北京" context')
}

console.log('SESSION MEMORY TESTS OK')
