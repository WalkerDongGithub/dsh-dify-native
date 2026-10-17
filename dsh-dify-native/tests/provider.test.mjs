/**
 * Provider-level tests with real inputs and real outputs:
 *   - question-classifier → a stubbed harness LLM service
 *   - http-request       → a real local HTTP server, ctx.web.fetch for GET and
 *                          sandbox+curl for POST/error strategies
 *   - tool               → a stubbed ctx.tools registry, allowlist enforced
 *   - knowledge-retrieval→ a real temp corpus, grep tool stub, deterministic scoring
 *
 *   node tests/provider.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDifyNodeProvider } from '../lib/provider.js'

const ROOT = new URL('..', import.meta.url).pathname
const TMP = mkdtempSync(join(ROOT, '.tmp-provider-'))

function llmCtx(text) {
  return {
    listProviders: () => [{ id: 'zai' }],
    stream: async function* () {
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function makeCtx({ llmText = '健康咨询', tools, web, sandbox } = {}) {
  return {
    get(key) {
      if (key === 'llm') return llmCtx(llmText)
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'zai', model: 'glm-4.5-air' }) }
      if (key === 'tools') return tools
      if (key === 'web') return web
      if (key === 'sandbox') return sandbox ?? { confine: async (argv) => ({ argv, enforcement: 'test' }) }
      return undefined
    },
    on() {
      return () => {}
    },
  }
}

async function runSpec(ctx, spec, options = {}) {
  const provider = createDifyNodeProvider(ctx, { name: 'dify-node', ...options })
  const run = await provider.start({
    prompt: [{ type: 'text', text: JSON.stringify(spec) }],
    parent: { session: { id: 'test-session', header: { cwd: TMP } } },
    signal: new AbortController().signal,
  })
  const result = await run.result
  return JSON.parse(result.output[0].text)
}

const classifierSpec = (text) => ({
  kind: 'question-classifier',
  nodeId: 'c1',
  classes: [
    { id: 'health', name: '健康咨询' },
    { id: 'help', name: '使用帮助' },
  ],
  instruction: '分类',
  query: text,
  provider: 'deepseek',
  model: 'deepseek-chat',
})

// 1. classifier maps the model answer back to a declared class id.
{
  const exact = await runSpec(makeCtx({ llmText: '使用帮助' }), classifierSpec('怎么配对腕带'))
  assert.equal(exact.ok, true)
  assert.equal(exact.outputs.class_id, 'help')
  assert.equal(exact.outputs.class_name, '使用帮助')
  const json = await runSpec(makeCtx({ llmText: '```json\n{"class":"健康咨询"}\n```' }), classifierSpec('我失眠'))
  assert.equal(json.outputs.class_id, 'health')
  const numbered = await runSpec(makeCtx({ llmText: '2' }), classifierSpec('怎么配对'))
  assert.equal(numbered.outputs.class_id, 'help')
  const unknown = await runSpec(makeCtx({ llmText: '我也不知道' }), classifierSpec('???')
  )
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /matches no declared class/)
  const ambiguous = await runSpec(makeCtx({ llmText: '健康咨询或使用帮助' }), classifierSpec('???'))
  assert.equal(ambiguous.ok, false)
  assert.match(ambiguous.error, /ambiguous/)
  console.log('ok 1 — classifier: name/JSON/number map to class ids; unknown/ambiguous fail closed')
}

// 2. http-request: real local server, plain GET through ctx.web.fetch, then
//    POST/error strategies through sandbox+curl.
{
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.url.startsWith('/post')) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' })
        res.end(
          JSON.stringify({
            method: req.method,
            body,
            auth: req.headers.authorization ?? '',
            custom: req.headers['x-test'] ?? '',
            contentType: req.headers['content-type'] ?? '',
          }),
        )
      } else if (req.url.startsWith('/fail')) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('down')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const web = {
    fetch: async ({ url }) => {
      const response = await fetch(url)
      return { url, statusCode: response.status, body: { kind: 'text', content: await response.text() }, truncated: false }
    },
  }
  const ctx = makeCtx({ web })

  const get = await runSpec(ctx, {
    kind: 'http-request',
    nodeId: 'g',
    method: 'GET',
    url: `${base}/get`,
    params: [['x', '1']],
    headers: [],
    body: { type: 'none' },
    errorStrategy: 'none',
    timeoutMs: 5000,
  })
  assert.equal(get.ok, true)
  assert.equal(get.outputs.backend, 'ctx.web.fetch')
  assert.equal(get.outputs.status_code, 200)
  assert.deepEqual(get.outputs.json, { ok: true, url: '/get?x=1', method: 'GET' })
  assert.equal(typeof get.outputs.body, 'string')

  const post = await runSpec(ctx, {
    kind: 'http-request',
    nodeId: 'p',
    method: 'POST',
    url: `${base}/post`,
    headers: [['X-Test', 'abc']],
    params: [],
    body: { type: 'json', data: [{ key: 'hello', value: 'world' }] },
    authorization: { type: 'api-key', config: { type: 'bearer', api_key: 'KEY', header: 'Authorization' } },
    errorStrategy: 'none',
    timeoutMs: 5000,
  })
  assert.equal(post.ok, true)
  assert.equal(post.outputs.backend, 'sandbox+curl')
  assert.equal(post.outputs.status_code, 200)
  assert.deepEqual(post.outputs.json, {
    method: 'POST',
    body: '{"hello":"world"}',
    auth: 'Bearer KEY',
    custom: 'abc',
    contentType: 'application/json',
  })

  const failSpec = (errorStrategy, defaultValue) => ({
    kind: 'http-request',
    nodeId: 'f',
    method: 'GET',
    url: `${base}/fail`,
    params: [],
    headers: [],
    body: { type: 'none' },
    errorStrategy,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    timeoutMs: 5000,
  })
  const failed = await runSpec(ctx, failSpec('none'))
  assert.equal(failed.ok, false)
  assert.match(failed.error, /HTTP 503/)
  const branch = await runSpec(ctx, failSpec('fail-branch'))
  assert.equal(branch.ok, true)
  assert.equal(branch.branch, 'fail-branch')
  assert.equal(branch.outputs.status_code, 503)
  const defaults = await runSpec(ctx, failSpec('default-value', { body: 'fallback', status_code: 200 }))
  assert.equal(defaults.ok, true)
  assert.equal(defaults.outputs.body, 'fallback')
  assert.equal(defaults.outputs.status_code, 200)
  assert.equal(defaults.meta.actualStatus, 503)

  server.close()
  console.log('ok 2 — http-request: GET via ctx.web.fetch, POST via sandbox+curl, 503 strategies')
}

// 3. tool: dispatch is explicit only. A harness tool is reachable when it is
//    named exactly AND opted into DIFY_TOOL_PASSTHROUGH; `jina_reader` is never
//    silently rewritten into a different tool, and the allowlist is checked
//    against the requested name before any dispatch.
{
  let calls = 0
  const tools = {
    get: (name) => (name === 'web_fetch' ? {} : undefined),
    execute: async ({ name, arguments: args }) => {
      calls += 1
      assert.equal(name, 'web_fetch')
      assert.equal(args.url, 'https://example.test/page')
      return {
        isError: false,
        value: { url: args.url, statusCode: 200, body: { kind: 'text', content: 'page body' } },
        content: [{ type: 'text', text: 'page body' }],
      }
    },
  }
  const ok = await runSpec(makeCtx({ tools }), {
    kind: 'tool',
    nodeId: 't',
    toolName: 'web_fetch',
    provider: '',
    providerType: 'api',
    arguments: { url: 'https://example.test/page' },
  }, { toolAllow: 'web_fetch', toolPassthrough: 'web_fetch' })
  assert.equal(ok.ok, true)
  assert.equal(ok.outputs.text, 'page body')
  assert.equal(ok.outputs.result, 'page body')
  assert.equal(ok.outputs.statusCode, 200)
  assert.equal(ok.meta.tool, 'web_fetch')
  assert.equal(calls, 1)

  // The old alias table turned this into web_fetch. It must not any more.
  const unaliased = await runSpec(makeCtx({ tools }), {
    kind: 'tool',
    nodeId: 't-unknown',
    toolName: 'jina_reader',
    provider: 'jina',
    arguments: { url: 'https://example.test/page' },
  }, { toolAllow: 'jina/jina_reader', toolPassthrough: 'web_fetch' })
  assert.equal(unaliased.ok, false)
  assert.match(unaliased.error, /is not declared/)
  assert.equal(calls, 1, 'an undeclared tool must not be substituted or dispatched')

  const refused = await runSpec(makeCtx({ tools }), {
    kind: 'tool',
    nodeId: 't2',
    toolName: 'bash',
    arguments: { command: 'id' },
  }, { toolAllow: 'web_fetch' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /refuses "bash"/)
  assert.equal(calls, 1)
  console.log('ok 3 — tool dispatch is explicit only; unknown tools are refused, never aliased')
}

// 4. knowledge-retrieval: local dataset, deterministic lexical ranking, top_k,
//    and an explicit failure for an unknown dataset id.
{
  const knowledgeRoot = join(TMP, 'knowledge')
  mkdirSync(join(knowledgeRoot, 'ds1'), { recursive: true })
  writeFileSync(join(knowledgeRoot, 'ds1', 'pair.md'), 'wristband pairing: press the button for three seconds\n')
  writeFileSync(join(knowledgeRoot, 'ds1', 'charge.md'), 'wristband charging: use the magnetic cable\n')
  writeFileSync(join(knowledgeRoot, 'ds1', 'food.md'), 'eat more vegetables\n')
  const tools = {
    get: (name) => (name === 'grep' ? {} : undefined),
    execute: async ({ name, arguments: args }) => {
      assert.equal(name, 'grep')
      const terms = args.pattern
        .replace(/^\(\?i\)\(/, '')
        .replace(/\)$/, '')
        .split('|')
      const matches = []
      for (const file of readdirSync(args.path)) {
        const lines = readFileSync(join(args.path, file), 'utf8').split('\n')
        lines.forEach((line, index) => {
          if (terms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
            matches.push({ path: join(args.path, file), lineNumber: index + 1, line })
          }
        })
      }
      return { isError: false, value: { matches }, content: [] }
    },
  }
  const ctx = makeCtx({ tools })
  const top1 = await runSpec(ctx, {
    kind: 'knowledge-retrieval',
    nodeId: 'k',
    datasetIds: ['ds1'],
    query: 'wristband pairing',
    topK: 1,
    scoreThreshold: 0,
  }, { knowledgeRoot })
  assert.equal(top1.ok, true)
  assert.equal(top1.outputs.result.length, 1)
  assert.match(top1.outputs.result[0].content, /pairing/)
  assert.equal(top1.outputs.result[0].score, 1)
  assert.equal(top1.meta.engine, 'grep+lexical')

  const missing = await runSpec(ctx, {
    kind: 'knowledge-retrieval',
    nodeId: 'k2',
    datasetIds: ['nope'],
    query: 'x',
    topK: 1,
  }, { knowledgeRoot })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /not found under/)
  console.log('ok 4 — knowledge-retrieval ranks local corpus lines, honors top_k, fails on missing dataset')
}

rmSync(TMP, { recursive: true, force: true })
console.log('PROVIDER TESTS OK')
