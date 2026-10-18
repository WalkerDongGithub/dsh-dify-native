/** Real installed dsh engine: `http-request.ssl_verify` against a self-signed
 * HTTPS fixture. The fixture certificate is generated with openssl into this
 * test's own temporary directory; nothing in the repo or the system trust store
 * is touched, and no network egress is needed.
 *
 * The expected behaviour is Dify 1.9.1 (commit cd47a47c):
 *   - `ssl_verify: false` disables certificate verification for that node only;
 *   - `ssl_verify: true` and an absent field keep verification on and fail;
 *   - `ssl_verify: null` reaches the executor as a non-boolean and raises, it is
 *     never silently treated as "verify" or "do not verify".
 */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as https from 'node:https'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realHarness } from './helpers/real-harness.mjs'
import { compileGraph, inspectGraph } from '../lib/dsl.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = mkdtempSync(join(ROOT, '.tmp-engine-tls-'))

const keyPath = join(TMP, 'fixture-key.pem')
const certPath = join(TMP, 'fixture-cert.pem')
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore' },
)
let hits = 0
const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  hits += 1
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `https://127.0.0.1:${server.address().port}/ok`

// Proves the fixture is genuinely untrusted: the system curl cannot verify it.
let systemCurlCode = 0
try {
  await promisify(execFile)('curl', ['--silent', '--max-time', '5', '--output', '/dev/null', url])
} catch (error) {
  systemCurlCode = error.code
}
assert.equal(systemCurlCode, 60, 'fixture must be genuinely untrusted by the system curl')
assert.equal(hits, 0, 'the untrusted fixture must not serve the probe request')

function httpData(extra = {}, overrides = {}) {
  return {
    type: 'http-request',
    method: 'post',
    url,
    headers: [],
    params: [],
    body: { type: 'json', data: [{ key: 'probe', value: 'tls' }] },
    authorization: { type: 'no-auth' },
    error_strategy: 'fail-branch',
    timeout: { max_connect_timeout: 5, max_read_timeout: 5, max_write_timeout: 5 },
    ...extra,
    ...overrides,
  }
}

/** Two ends: success-branch reads status/backend/body, fail-branch reads the error. */
function tlsGraph(data) {
  return {
    appName: 'http-tls',
    mode: 'workflow',
    nodes: [
      { id: 's', data: { type: 'start', variables: [] } },
      { id: 'h', data },
      {
        id: 'ok',
        data: {
          type: 'end',
          outputs: [
            { variable: 'status_code', value_selector: ['h', 'status_code'] },
            { variable: 'backend', value_selector: ['h', 'backend'] },
            { variable: 'body', value_selector: ['h', 'body'] },
          ],
        },
      },
      { id: 'bad', data: { type: 'end', outputs: [{ variable: 'error', value_selector: ['h', 'error_message'] }] } },
    ],
    edges: [
      { source: 's', target: 'h', sourceHandle: 'source' },
      { source: 'h', target: 'ok', sourceHandle: 'success-branch' },
      { source: 'h', target: 'bad', sourceHandle: 'fail-branch' },
    ],
  }
}

async function runGraph(h, graph) {
  const c = compileGraph(graph)
  const handle = h.ctx.workflowEngine.start({ meta: c.meta, script: c.script, args: {}, parent: h.parent, subagentProvider: 'dify-node' })
  try {
    return await handle.result
  } finally {
    await handle.dispose()
  }
}

let h
try {
  h = await realHarness(TMP)
  // http-request needs no model; make the seam explicit rather than inherited.
  h.ctx.provide('llm', { listProviders: () => [] })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'none', model: 'none' }) })

  // ssl_verify: false — verification off for this node, real response returned.
  let r = await runGraph(h, tlsGraph(httpData({ ssl_verify: false })))
  assert.equal(r.stopReason, 'completed', r.error)
  assert.equal(r.value.nodes.h.branch, 'success-branch', JSON.stringify(r.value.nodes.h.outputs))
  assert.equal(r.value.nodes.h.outputs.backend, 'sandbox+curl')
  assert.deepEqual(r.value.outputs, { status_code: 200, backend: 'sandbox+curl', body: JSON.stringify({ ok: true, path: '/ok', method: 'POST' }) })
  assert.ok(hits >= 1, 'the fixture must have served the unverified request')

  // Plain GET (no headers/body) would take ctx.web.fetch; false must still
  // execute on curl with verification off instead of failing the fetch.
  r = await runGraph(h, tlsGraph(httpData({ ssl_verify: false }, { method: 'get', body: { type: 'none' } })))
  assert.equal(r.stopReason, 'completed', r.error)
  assert.equal(r.value.nodes.h.branch, 'success-branch', JSON.stringify(r.value.nodes.h.outputs))
  assert.equal(r.value.nodes.h.outputs.backend, 'sandbox+curl')

  // ssl_verify: true — verification stays on; the self-signed fixture fails.
  r = await runGraph(h, tlsGraph(httpData({ ssl_verify: true })))
  assert.equal(r.stopReason, 'completed', r.error)
  assert.equal(r.value.nodes.h.branch, 'fail-branch')
  assert.match(r.value.nodes.h.outputs.error_message, /curl exited 60/, r.value.nodes.h.outputs.error_message)

  // absent ssl_verify — Dify default is verification on.
  r = await runGraph(h, tlsGraph(httpData()))
  assert.equal(r.stopReason, 'completed', r.error)
  assert.equal(r.value.nodes.h.branch, 'fail-branch')
  assert.match(r.value.nodes.h.outputs.error_message, /curl exited 60/, r.value.nodes.h.outputs.error_message)

  // ssl_verify: null — explicit, unambiguous error (never a silent fallback).
  const before = hits
  r = await runGraph(h, tlsGraph(httpData({ ssl_verify: null })))
  assert.equal(r.stopReason, 'error')
  assert.match(r.error, /ssl_verify.*null/)
  assert.equal(hits, before, 'a null ssl_verify must not reach the fixture')

  // Compile layer: the field is consumed, not reported as dropped/simplified.
  const { nodes, edges } = tlsGraph(httpData({ ssl_verify: false }))
  const report = inspectGraph({ appName: 'http-tls', nodes, edges })
  assert.deepEqual(report.diagnostics.filter((row) => row.subject.startsWith('h:') && row.code === 'field-dropped'), [])
  // Code is right, test was stale: lib/provider.js folds timeout.connect/read/write
  // into one curl --max-time deadline instead of independent per-phase budgets, so
  // http-request is honestly reported as 'simplified' (field is consumed, not dropped).
  assert.equal(report.support.find((row) => row.id === 'h').mode, 'simplified')

  console.log('ENGINE HTTP TLS OK: ssl_verify false/true/absent/null on real workflowEngine.start')
} finally {
  if (h) await h.close()
  await new Promise((done) => server.close(done))
  rmSync(TMP, { recursive: true, force: true })
}
