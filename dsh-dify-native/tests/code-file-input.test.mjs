/**
 * A code node fed a Dify file variable.
 *
 * Dify passes a file as its own object
 * (`{dify_model_identity: '__dify__file__', filename, url, ...}`, see
 * factories/variable_factory.py:FileSegment). `main(**inputs)` must receive that
 * dict as the parameter value — and must not fail while expanding the call.
 *
 * Regression coverage for the reported file-input failure. The reported
 * "multiple values" error was not reproduced: dict values remain single keyword
 * arguments under main(**inputs). This test does not claim a runtime fix.
 *
 *   node tests/code-file-input.test.mjs
 */
import assert from 'node:assert/strict'
import { createDifyNodeProvider } from '../lib/provider.js'

const FILE = { dify_model_identity: '__dify__file__', filename: 'a.txt', url: 'https://files.example/a.txt', size: 3 }

async function runCode(code, inputs) {
  const ctx = {
    get(key) {
      if (key === 'sandbox') return { confine: async (argv) => ({ argv, enforcement: 'test' }) }
      return undefined
    },
    on() {
      return () => {}
    },
  }
  const provider = createDifyNodeProvider(ctx, { name: 'dify-node' })
  const spec = { kind: 'code', nodeId: 'code1', codeLanguage: 'python3', code, inputs }
  const run = await provider.start({
    prompt: [{ type: 'text', text: JSON.stringify(spec) }],
    parent: { session: { id: 'code-file', header: { cwd: process.cwd() } } },
    signal: new AbortController().signal,
  })
  return JSON.parse((await run.result).output[0].text)
}

// 1. main() receives the file dict intact; no TypeError, no lost value.
{
  const result = await runCode(
    'def main(doc, sys):\n    return {"name": doc["filename"], "identity": doc["dify_model_identity"], "is_dict": isinstance(doc, dict), "sys_is_module": type(sys).__name__ == "module"}\n',
    { doc: FILE, sys: FILE },
  )
  assert.equal(result.ok, true, result.error ?? '')
  assert.deepEqual(result.outputs, { name: 'a.txt', identity: '__dify__file__', is_dict: true, sys_is_module: false })
  assert.equal(result.stderr, undefined)
  console.log('ok 1 — a file input reaches main() as Dify’s dict and does not raise TypeError')
}

// 2. A second file input, plus a plain dict-valued input, all expand once and
//    keep their JSON shape.
{
  const other = { dify_model_identity: '__dify__file__', filename: 'b.pdf', url: 'https://files.example/b.pdf' }
  const result = await runCode(
    "def main(first, second, meta):\n    return {'first': first['filename'], 'second': second['url'], 'meta': meta}\n",
    { first: FILE, second: other, meta: { nested: [1, 2] } },
  )
  assert.equal(result.ok, true, result.error ?? '')
  assert.deepEqual(result.outputs, { first: 'a.txt', second: 'https://files.example/b.pdf', meta: { nested: [1, 2] } })
  console.log('ok 2 — several file/dict inputs expand once each and keep their JSON shape')
}

console.log('CODE FILE INPUT TESTS OK')
