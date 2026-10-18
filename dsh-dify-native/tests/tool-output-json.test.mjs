/**
 * Tool results must survive the harness's output boundary.
 *
 * `dify_native_inspect` declares `output.schema: { type: 'object',
 * additionalProperties: true }`, so dsh validates the returned value as
 * lossless JSON before the model sees it. The deviation table in `dsl.js`
 * stores its trigger as a live predicate (`when: (d) => ...`); spreading the row
 * into the result used to copy that function into `deviations[].when`, and the
 * whole inspect call failed with
 *
 *   "value is not lossless JSON"
 *
 * on every real export (found through `dsl/research/gpt-researcher.yml`).
 * This test walks every tool's real output for a representative workflow and
 * fails on `undefined`, functions, non-finite numbers, or cycles.
 *
 *   node tests/tool-output-json.test.mjs
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const SAMPLE = fileURLToPath(new URL('../dsl/research/gpt-researcher.yml', import.meta.url))

/** Collect every non-lossless-JSON path in a value. */
function nonLossless(root) {
  const bad = []
  const seen = new Set()
  const walk = (value, path) => {
    if (value === undefined) bad.push(`${path} is undefined`)
    else if (typeof value === 'function') bad.push(`${path} is a function`)
    else if (typeof value === 'bigint') bad.push(`${path} is a bigint`)
    else if (typeof value === 'number' && !Number.isFinite(value)) bad.push(`${path} is ${value}`)
    else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) { bad.push(`${path} is a cycle`); return }
      seen.add(value)
      if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      else for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`)
      seen.delete(value)
    }
  }
  walk(root, '$')
  return bad
}

/** Minimal plugin context: records effects so nothing leaks between calls. */
function mountTools() {
  const tools = new Map()
  // `effect` runs the callback now and keeps its disposer; the registry
  // deliberately does nothing, so tools stay registered for the whole test.
  const ctx = {
    toolAllow: 'web_search,web_fetch',
    toolContracts: [],
    get: () => undefined,
    effect: (fn) => fn(),
    inject: (_deps, callback) => {
      // `apply` also registers the `dify-node` provider when a registry is
      // reachable. The tools themselves never read the provider, so stub the
      // registry out rather than hand the production path a half-built context.
      const child = { ...ctx, subagents: { getProvider: () => undefined, registerProvider: () => () => {} } }
      callback(child)
    },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }
  apply(ctx)
  return tools
}

const tools = mountTools()

// 1. Every tool result is lossless JSON — the exact boundary that used to fail.
{
  const inspect = tools.get('dify_native_inspect')
  assert.ok(inspect !== undefined, 'dify_native_inspect must be registered')
  const value = await inspect.execute({ path: SAMPLE })
  assert.deepEqual(nonLossless(value), [])
  assert.equal(typeof value.appName, 'string')
  assert.ok(value.deviations.length > 0, 'sample must carry deviations, or this test proves nothing')
  assert.equal(value.nodeCount, 22)
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(value))), JSON.stringify(value))
  console.log(`ok 1 — dify_native_inspect returns lossless JSON (${value.deviations.length} deviations, ${value.support.length} support rows)`)
}

// 2. The deviation rows keep what a reader needs and drop the predicate.
{
  const value = await tools.get('dify_native_inspect').execute({ path: SAMPLE })
  for (const row of value.deviations) {
    assert.ok(!Object.hasOwn(row, 'when'), 'the live predicate must not be serialized')
    for (const key of ['nodeId', 'nodeKind', 'severity', 'consequence', 'fix', 'bites']) {
      assert.ok(Object.hasOwn(row, key), `deviation row is missing ${key}`)
    }
  }
  console.log('ok 2 — deviation rows carry node/severity/consequence/fix/bites, no predicate')
}

// 3. An all-green sample still loses nothing: matplotlib has no structural issue.
{
  const value = await tools.get('dify_native_inspect').execute({ path: fileURLToPath(new URL('../dsl/research/matplotlib.yml', import.meta.url)) })
  assert.deepEqual(nonLossless(value), [])
  assert.deepEqual(value.issues, [])
  console.log('ok 3 — a clean sample keeps zero issues and stays lossless')
}

// 4. The other tools that exist without a live engine still answer with JSON.
{
  const services = tools.get('dify_native_services')
  assert.deepEqual(nonLossless(await services.execute({})), [])
  console.log('ok 4 — dify_native_services returns lossless JSON without an engine')
}

console.log('TOOL OUTPUT JSON TESTS OK')
