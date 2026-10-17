/**
 * Declarative tool contract tests.
 *
 * A third-party tool is declared in YAML — provider/tool identity, parameter
 * forms, one HTTP request, response mapping — and executed with no per-tool
 * adapter and no plugin daemon. These tests cover registry loading, placeholder
 * resolution, empty-value omission, response mapping and the refusal paths.
 *
 *   node tests/tool-contracts.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolRegistry, executeContract } from '../lib/tool-contracts.js'

const dir = mkdtempSync(join(tmpdir(), 'dify-tool-contracts-'))
mkdirSync(join(dir, 'nested'))

writeFileSync(
  join(dir, 'jina.yaml'),
  `
provider: jina
tool: jina_reader
label: { zh_Hans: 获取单页面 }
parameters:
  - { name: url, type: string, form: llm, required: true }
  - { name: api_key, type: secret-input, form: form, required: false }
  - { name: target_selector, type: string, form: form, required: false }
request:
  method: GET
  url: "https://r.jina.ai/{{parameters.url}}"
  headers:
    Accept: application/json
    Authorization: "Bearer {{credentials.api_key}}"
    X-Target-Selector: "{{credentials.target_selector}}"
response:
  text: "{{response.data}}"
  variables:
    title: "{{response.title}}"
`,
  'utf8',
)

writeFileSync(
  join(dir, 'nested', 'post.yaml'),
  `
provider: my_company
tool: search
parameters:
  - { name: q, type: string, form: llm, required: true }
  - { name: token, type: secret-input, form: form, required: true }
request:
  method: POST
  url: "https://api.example.com/search"
  headers: { Authorization: "Bearer {{credentials.token}}" }
  body:
    query: "{{parameters.q}}"
response:
  text: "{{response.result}}"
`,
  'utf8',
)

// A file that is not a contract (no request.url) must be skipped, not crash.
writeFileSync(join(dir, 'not-a-contract.yaml'), 'provider: x\ntool: y\n', 'utf8')

const registry = createToolRegistry([dir])

// 1. Every usable contract is indexed by `provider/tool`, recursively.
{
  assert.equal(registry.size(), 2)
  assert.ok(registry.has('jina', 'jina_reader'))
  assert.ok(registry.has('my_company', 'search'))
  assert.ok(!registry.has('x', 'y'), 'a file without request.url is not a contract')
  assert.deepEqual(registry.list().sort(), ['jina/jina_reader', 'my_company/search'])
  console.log('ok 1 — contracts load recursively and malformed files are skipped')
}

/** A fetch stub that records the request and returns a canned JSON body. */
function fetchStub(body, status = 200) {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }
  return { fetch, seen }
}

// 2. A contract call builds URL/headers from parameters and credentials, and maps
//    the response through `response.text` / `response.variables`.
{
  const { fetch, seen } = fetchStub({ data: '# Page', title: 'Page title' })
  const result = await executeContract(
    registry.get('jina', 'jina_reader'),
    { parameters: { url: 'https://example.com/a' }, configurations: { api_key: 'sk-1' } },
    { fetch },
  )
  assert.equal(result.ok, true)
  assert.equal(seen[0].url, 'https://r.jina.ai/https://example.com/a')
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-1')
  assert.equal(result.outputs.text, '# Page')
  assert.equal(result.outputs.title, 'Page title')
  console.log('ok 2 — url, credentials and response mapping resolve as declared')
}

// 3. An empty credential omits its header entirely (Dify's `if api_key:` pattern)
//    instead of sending "Bearer " or "undefined".
{
  const { fetch, seen } = fetchStub({ data: 'x' })
  await executeContract(
    registry.get('jina', 'jina_reader'),
    { parameters: { url: 'https://example.com' }, configurations: {} },
    { fetch },
  )
  assert.equal('Authorization' in seen[0].headers, false, 'an absent api key must not produce an Authorization header')
  assert.equal('X-Target-Selector' in seen[0].headers, false, 'a null configuration must be omitted')
  console.log('ok 3 — empty values omit the field instead of sending a placeholder')
}

// 4. A POST contract sends a JSON body and URL-parameterised request.
{
  const { fetch, seen } = fetchStub({ result: 'found it' })
  const result = await executeContract(
    registry.get('my_company', 'search'),
    { parameters: { q: 'hello' }, configurations: { token: 'tok' } },
    { fetch },
  )
  assert.equal(result.ok, true)
  assert.equal(seen[0].method, 'POST')
  assert.deepEqual(JSON.parse(seen[0].body), { query: 'hello' })
  assert.equal(seen[0].headers['Content-Type'], 'application/json')
  assert.equal(result.outputs.text, 'found it')
  console.log('ok 4 — a POST contract sends the declared JSON body')
}

// 5. A missing required parameter fails with its name — never a silent empty call.
{
  const { fetch } = fetchStub({})
  const result = await executeContract(registry.get('jina', 'jina_reader'), { parameters: {}, configurations: {} }, { fetch })
  assert.equal(result.ok, false)
  assert.match(result.error, /required parameter "url" is missing/)
  console.log('ok 5 — a missing required parameter is reported by name')
}

// 6. A missing required configuration fails and says it is a configuration.
{
  const { fetch } = fetchStub({})
  const result = await executeContract(registry.get('my_company', 'search'), { parameters: { q: 'x' }, configurations: {} }, { fetch })
  assert.equal(result.ok, false)
  assert.match(result.error, /required configuration "token" is missing/)
  console.log('ok 6 — a missing required configuration is reported as such')
}

// 7. A non-2xx response is an error carrying the status, not a "successful" body.
{
  const { fetch } = fetchStub('rate limited', 429)
  const result = await executeContract(
    registry.get('jina', 'jina_reader'),
    { parameters: { url: 'https://example.com' }, configurations: {} },
    { fetch },
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 429/)
  console.log('ok 7 — a non-2xx response fails with its status')
}

// 8. A non-JSON response still yields text (the contract may target an API that
//    returns plain text).
{
  const { fetch } = fetchStub('plain text body')
  const result = await executeContract(
    { ...registry.get('jina', 'jina_reader'), response: {} },
    { parameters: { url: 'https://example.com' }, configurations: {} },
    { fetch },
  )
  assert.equal(result.ok, true)
  assert.equal(result.outputs.text, 'plain text body')
  console.log('ok 8 — a non-JSON response passes through as text')
}

// 9. A DSL-shaped `{type, value}` parameter is unwrapped before use.
{
  const { fetch, seen } = fetchStub({ data: 'ok' })
  await executeContract(
    registry.get('jina', 'jina_reader'),
    { parameters: { url: { type: 'mixed', value: 'https://example.com/x' } }, configurations: {} },
    { fetch },
  )
  assert.equal(seen[0].url, 'https://r.jina.ai/https://example.com/x')
  console.log('ok 9 — DSL {type,value} parameters are unwrapped')
}

// 10. A bare `{{response}}` (no path) means the whole response body — the
//     common single-value shape.
{
  const dir2 = mkdtempSync(join(tmpdir(), 'dify-tool-whole-'))
  writeFileSync(
    join(dir2, 'raw.yaml'),
    `
provider: probe
tool: raw
parameters:
  - { name: url, type: string, form: llm, required: true }
request:
  method: GET
  url: "{{parameters.url}}"
response:
  text: "{{response}}"
`,
    'utf8',
  )
  const reg = createToolRegistry([dir2])
  const { fetch } = fetchStub('whole body text')
  const result = await executeContract(reg.get('probe', 'raw'), { parameters: { url: 'https://x' }, configurations: {} }, { fetch })
  assert.equal(result.ok, true)
  assert.equal(result.outputs.text, 'whole body text', '{{response}} must resolve to the body, not the literal')
  console.log('ok 10 — a bare {{response}} resolves to the whole body')
}

console.log('TOOL CONTRACT TESTS OK')
