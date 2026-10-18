/**
 * Research samples: the real, third-party workflows under `dsl/research/` (kept
 * verbatim from `dzh-gitcode/dify-workflows`) parse, classify, and — where the
 * export is structurally sound — compile.
 *
 * These are deliberately NOT part of `coverage.test.mjs`: that test asserts
 * "zero issues" for every `dsl/*.yml` and enumerates its own samples. Real
 * exports also carry canvas comments (`custom-note`), which this test pins
 * because they used to be misclassified as `generic` (fixed in `nodeType`).
 *
 *   node tests/research-samples.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compileGraph, inspectGraph, parseDifyDsl } from '../lib/dsl.js'

// Tests live in `dsh-dify-native/tests/`; the samples live in the parent repo's `dsl/research/`.
const RESEARCH = new URL('../../dsl/research/', import.meta.url).pathname

/**
 * Per file: expected profile. `compiles: false` means the export itself is
 * structurally broken (dangling assigner nodes and/or one branch handle wired
 * to several targets) and is kept as-is on purpose — `inspectGraph` flags it
 * and `compileGraph` refuses, which is the correct behaviour to pin.
 */
const EXPECTED = {
  'chatpaper.yml': { mode: 'advanced-chat', nodes: 42, full: 26, simplified: 4, passthrough: 0, notes: 11, issues: 2, compiles: false },
  'notebooklm.yml': { mode: 'advanced-chat', nodes: 16, full: 7, simplified: 3, passthrough: 0, notes: 5, issues: 0, compiles: true },
  'deepresearch.yml': { mode: 'advanced-chat', nodes: 23, full: 14, simplified: 1, passthrough: 0, notes: 6, issues: 0, compiles: true },
  'gpt-researcher.yml': { mode: 'workflow', nodes: 22, full: 10, simplified: 2, passthrough: 0, notes: 7, issues: 0, compiles: true },
  'deep-researcher-on-dify.yml': { mode: 'advanced-chat', nodes: 71, full: 42, simplified: 10, passthrough: 0, notes: 14, issues: 8, compiles: false },
  'matplotlib.yml': { mode: 'advanced-chat', nodes: 3, full: 2, simplified: 0, passthrough: 0, notes: 0, issues: 0, compiles: true },
}

const LEGACY = 'lit-review-writing.legacy-completion.yml'

// 1. Every research sample is listed here, and every listed file exists.
{
  const onDisk = readdirSync(RESEARCH).filter((file) => file.endsWith('.yml')).sort()
  assert.deepEqual(onDisk, [...Object.keys(EXPECTED), LEGACY].sort())
  console.log(`ok 1 — ${onDisk.length} research samples on disk, all accounted for`)
}

// 2. Each graph sample parses with the documented mode, node count, and support
//    profile, and compiles exactly when the export is structurally sound.
{
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const parsed = parseDifyDsl(readFileSync(join(RESEARCH, file), 'utf8'))
    assert.equal(parsed.mode, expected.mode, `${file} mode`)
    const inspection = inspectGraph(parsed)
    assert.equal(inspection.nodeCount, expected.nodes, `${file} node count`)
    const levels = { full: 0, simplified: 0, placeholder: 0, passthrough: 0 }
    for (const row of inspection.support) levels[row.mode] = (levels[row.mode] ?? 0) + 1
    assert.deepEqual(
      levels,
      { full: expected.full, simplified: expected.simplified, placeholder: 0, passthrough: expected.passthrough },
      `${file} support profile`,
    )
    assert.equal(inspection.issues.length, expected.issues, `${file} structural issues`)
    if (expected.compiles) {
      const compiled = compileGraph(parsed)
      assert.match(compiled.script, /return \{ nodes: __nodes, outputs:/, `${file} did not compile`)
    } else {
      assert.throws(() => compileGraph(parsed), /has no outgoing edge|duplicate branch edges/, `${file} should be refused`)
    }
  }
  console.log(`ok 2 — ${Object.keys(EXPECTED).length} research graphs: profile + compile/refuse as documented`)
}

// 3. Canvas comments are recognized as `note`, not `generic` (regression: Dify
//    exports them as `type: custom-note` with an empty `data.type`, which the
//    `data.type ?? type` fallback used to lose).
{
  for (const file of Object.keys(EXPECTED)) {
    const parsed = parseDifyDsl(readFileSync(join(RESEARCH, file), 'utf8'))
    const inspection = inspectGraph(parsed)
    assert.deepEqual(inspection.unknownKinds, [], `${file} has an unknown node type`)
    assert.equal(inspection.support.filter((row) => row.kind === 'generic').length, 0, `${file} has generic passthrough nodes`)
    const notes = parsed.nodes.filter((node) => node.type === 'custom-note')
    assert.equal(notes.length, EXPECTED[file].notes, `${file} note count`)
    assert.equal(inspection.nodeTypes.note ?? 0, notes.length, `${file} notes classified as note`)
  }
  console.log('ok 3 — custom-note canvas comments classify as note; no generic passthrough')
}

// 4. matplotlib is the one sample that is clean end to end: it is the first
//    workflow to run when checking whether the harness can run research samples.
{
  const inspection = inspectGraph(parseDifyDsl(readFileSync(join(RESEARCH, 'matplotlib.yml'), 'utf8')))
  assert.deepEqual(inspection.issues, [])
  assert.deepEqual(inspection.unknownKinds, [])
  assert.deepEqual(inspection.nodeTypes, { start: 1, code: 1, answer: 1 })
  console.log('ok 4 — matplotlib.yml: zero issues, start/code/answer only')
}

// 5. The legacy app is not a graph, and says so with the parse error a user
//    would see, rather than failing somewhere later.
{
  assert.throws(() => parseDifyDsl(readFileSync(join(RESEARCH, LEGACY), 'utf8')), /DSL has no workflow block/)
  console.log('ok 5 — legacy completion app is rejected at parse with a clear error')
}

console.log('RESEARCH SAMPLE TESTS OK')
