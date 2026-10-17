/**
 * `tool` node dispatch tests.
 *
 * The node resolves in exactly three ways: a declarative contract, an explicit
 * harness-tool passthrough, or a refusal that names what IS available. There is
 * no name-based guessing — mapping `jina_reader` onto `web_fetch` runs a
 * different tool than the workflow asked for.
 *
 *   node tests/tool-node.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDifyNodeProvider } from '../lib/provider.js'
import { createToolRegistry } from '../lib/tool-contracts.js'

const dir = mkdtempSync(join(tmpdir(), 'dify-tool-node-'))
writeFileSync(
  join(dir, 'demo.yaml'),
  `
provider: demo
tool: echo
parameters:
  - { name: q, type: string, form: llm, required: true }
  - { name: token, type: secret-input, form: form, required: true }
request:
  method: GET
  url: "https://api.example.com/echo"
  query: { q: "{{parameters.q}}", token: "{{credentials.token}}" }
response:
  text: "{{response.echo}}"
    `,
  'utf8',
)

const registry = createToolRegistry([dir])
const parent = { session: { id: 'probe', header: { cwd: process.cwd() } } }

/** Build a provider with a contract registry, a fetch stub and optional tools. */
function build({ toolPassthrough = '', harnessTools = {}, body = { echo: 'hi' }, toolAllow = '*' } = {}) {
  const seen = []
  const fetched = []
  const web = {
    fetch: async (url, init) => {
      fetched.push({ url: String(url), ...init })
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  }
  const tools = {
    get: (name) => harnessTools[name],
    execute: async (request) => {
      seen.push(request)
      return harnessTools[request.name].call()
    },
  }
  const ctx = {
    get(name) {
      if (name === 'web') return web
      if (name === 'tools') return tools
      return undefined
    },
  }
  const provider = createDifyNodeProvider(ctx, { name: 'dify-node', toolRegistry: registry, toolAllow, toolPassthrough })
  return { provider, seen, fetched }
}

async function run(provider, spec) {
  const handle = await provider.start({ prompt: JSON.stringify(spec), parent, signal: new AbortController().signal })
  const out = await (handle.result ?? handle)
  return JSON.parse(out.output[0].text)
}

const nodeSpec = (over = {}) => ({
  kind: 'tool',
  nodeId: 't1',
  title: 'tool',
  provider: 'demo',
  providerType: 'builtin',
  toolName: 'echo',
  arguments: { q: 'hello' },
  configurations: { token: 'tok-1' },
  ...over,
})

// 1. A declared contract runs; tool_configurations reach it as credentials.
{
  const { provider, fetched } = build()
  const payload = await run(provider, nodeSpec())
  assert.equal(payload.ok, true)
  assert.equal(payload.outputs.text, 'hi')
  assert.match(fetched[0].url, /q=hello/)
  assert.match(fetched[0].url, /token=tok-1/, 'tool_configurations must reach the contract as credentials')
  assert.equal(payload.meta.engine, 'declarative-contract')
  console.log('ok 1 — a declared contract runs and receives tool_configurations')
}

// 2. An undeclared tool is refused by name, and the error lists what exists.
{
  const { provider, fetched } = build()
  const payload = await run(provider, nodeSpec({ provider: 'jina', toolName: 'jina_reader' }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /jina\/jina_reader" is not declared/)
  assert.match(payload.error, /Declared tools: demo\/echo/)
  assert.equal(fetched.length, 0, 'an undeclared tool must not make any HTTP request')
  console.log('ok 2 — an undeclared tool is refused and the error names the declared ones')
}

// 3. This is the regression the old alias table caused: `jina_reader` must NOT
//    silently become `web_fetch`.
{
  const { provider, fetched } = build()
  const payload = await run(provider, nodeSpec({ provider: 'jina', toolName: 'jina_reader' }))
  assert.notEqual(payload.ok, true, 'an unknown tool must never resolve to a different one')
  assert.equal(fetched.length, 0, 'no substituted request may be sent')
  console.log('ok 3 — an unknown tool never silently resolves to another tool')
}

// 4. A Dify plugin package is refused with an explicit "not supported" reason.
{
  const { provider } = build()
  const payload = await run(provider, nodeSpec({ provider: 'jina', toolName: 'jina_reader', providerType: 'plugin' }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /\.difypkg/)
  assert.match(payload.error, /not supported/)
  console.log('ok 4 — a .difypkg plugin tool is refused as explicitly unsupported')
}

// 5. An exact passthrough name still works, but only when opted in by name.
{
  const { provider, seen } = build({
    toolPassthrough: 'web_fetch',
    harnessTools: { web_fetch: () => ({ content: [{ type: 'text', text: 'fetched' }], value: { text: 'fetched' } }) },
  })
  const payload = await run(provider, nodeSpec({ provider: '', providerType: 'api', toolName: 'web_fetch', arguments: { url: 'https://x' } }))
  assert.equal(payload.ok, true)
  assert.equal(payload.outputs.text, 'fetched')
  assert.equal(seen[0].name, 'web_fetch')
  console.log('ok 5 — an opted-in harness tool is dispatched by its exact name')
}

// 6. The allowlist is checked against `provider/tool`, not a substituted name.
{
  const { provider } = build({ toolAllow: 'demo/echo' })
  const allowed = await run(provider, nodeSpec())
  assert.equal(allowed.ok, true)
  const { provider: p2 } = build({ toolAllow: 'web_fetch' })
  const denied = await run(p2, nodeSpec())
  assert.equal(denied.ok, false)
  assert.match(denied.error, /refuses "demo\/echo"/)
  assert.match(denied.error, /allowlist is web_fetch/)
  console.log('ok 6 — the allowlist matches the requested provider/tool, not a guessed name')
}

// 7. A contract that fails surfaces a failed node, never a false success.
{
  const { provider } = build()
  const payload = await run(provider, nodeSpec({ configurations: {} }))
  assert.equal(payload.ok, false)
  assert.match(payload.error, /required configuration "token" is missing/)
  console.log('ok 7 — a contract missing its configuration fails the node')
}

console.log('TOOL NODE TESTS OK')
