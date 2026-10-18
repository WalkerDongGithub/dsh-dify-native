/**
 * Session-history adapter: feed a Dify LLM node's `memory` block from the
 * harness's own session log.
 *
 * Dify's memory is a `TokenBufferMemory` over the `Message` table of a
 * conversation. The harness has the equivalent already: a session is an
 * event-sourced log whose derived message history is `session.deriveMessages()`.
 * This module turns that log into the shape Dify's memory window expects,
 * without introducing a conversation store of its own.
 *
 * Two filters keep agent work out of the chat history:
 *   1. only user messages with `source.kind === 'user'` count as user turns
 *      (the loop also appends protocol-injected user messages, which are not the
 *      user talking);
 *   2. an assistant message that carries a tool call is agent work, not an
 *      answer, so it is skipped — the turn's final prose is the answer.
 *
 * `memory.window.size` is Dify's most recent-N-messages window; `role_prefix`
 * controls the text form produced by `toPromptText` (Dify's default is
 * `Human:` / `Assistant:`).
 */

/** Dify's defaults, used when the DSL omits a prefix. */
const DEFAULT_USER_PREFIX = 'Human'
const DEFAULT_ASSISTANT_PREFIX = 'Assistant'

function textOf(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Whether a user message is the user actually talking.
 *
 * The loop also appends protocol-injected user messages (workspace instructions,
 * runtime snapshots, reminders). Those carry a producer `source.kind` other than
 * `user` and usually a semantic `source.form`; either signal is enough to skip
 * them. A message with no source at all is treated as user input (legacy logs).
 */
function isRealUserMessage(message) {
  const source = message?.source
  if (source === null || source === undefined) return true
  if (source.kind !== 'user') return false
  if (source.form === 'instructions' || source.form === 'catalog' || source.form === 'snapshot') return false
  return true
}

/**
 * Derive Dify-shaped chat history from a derived dsh message list.
 *
 * @param messages - `session.deriveMessages()` output (`Message[]`).
 * @returns ordered `[{ role: 'user'|'assistant', content: string }]`.
 */
export function deriveChatHistory(messages) {
  const history = []
  for (const message of messages ?? []) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = message.content
    if (role === 'user') {
      if (!isRealUserMessage(message)) continue
      const text = textOf(content)
      if (text.length > 0) history.push({ role: 'user', content: text })
      continue
    }
    // An assistant message carrying tool calls is agent work, not an answer.
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool-call' || block?.type === 'tool-use')) continue
    const text = textOf(content)
    if (text.length > 0) history.push({ role: 'assistant', content: text })
  }
  return history
}

/**
 * Apply Dify's memory window to a history list.
 *
 * `window.size` counts Dify messages, so the window keeps the most recent
 * `size` entries (not pairs). A disabled or absent window keeps everything —
 * callers decide whether to pass history at all.
 *
 * @param history - from {@link deriveChatHistory}.
 * @param options - `{ enabled, size }` from the DSL's `memory.window`.
 */
export function applyMemoryWindow(history, { enabled = true, size = null } = {}) {
  if (!enabled) return []
  const limit = typeof size === 'number' && Number.isFinite(size) && size > 0 ? Math.floor(size) : history.length
  return history.slice(-limit)
}

/**
 * Render history into the text form Dify's `role_prefix` describes.
 * @param history - windowed history.
 * @param rolePrefix - `{ user, assistant }` from the DSL (empty → Dify defaults).
 */
export function toPromptText(history, rolePrefix = {}) {
  const userPrefix = rolePrefix?.user && String(rolePrefix.user).length > 0 ? String(rolePrefix.user) : DEFAULT_USER_PREFIX
  const assistantPrefix =
    rolePrefix?.assistant && String(rolePrefix.assistant).length > 0 ? String(rolePrefix.assistant) : DEFAULT_ASSISTANT_PREFIX
  return history.map((item) => `${item.role === 'user' ? userPrefix : assistantPrefix}: ${item.content}`).join('\n')
}

/**
 * Resolve the memory options a node declares, normalizing Dify's shapes.
 * @param memory - a node's `data.memory` block.
 * @returns `{ enabled, size, rolePrefix }`; `enabled: false` when absent.
 */
export function memoryOptions(memory) {
  if (memory === null || typeof memory !== 'object') return { enabled: false, size: null, rolePrefix: {} }
  const window = memory.window ?? {}
  return {
    enabled: window.enabled === true,
    size: typeof window.size === 'number' ? window.size : null,
    rolePrefix: memory.role_prefix ?? {},
  }
}
