/**
 * Parsing-layer coverage: prove there is no Dify node type this runtime cannot
 * recognize. Every `BlockEnum` value from Dify's frontend types.ts is parsed
 * into a canonical IR kind — none falls through to `generic`, and no DSL sample
 * in `dsl/` reports an unknown type or a structural parse error.
 *
 *   node tests/coverage.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_KINDS, NODE_KINDS, buildIR, compileGraph, inspectGraph, normalizeKind, parseDifyDsl } from '../lib/dsl.js'

/**
 * Dify `BlockEnum` (web/app/components/workflow/types.ts), 31 values, plus the
 * Dify-exported `custom-note` canvas annotation and this compiler's
 * `iteration-end` marker (Dify closes iterations with `output_selector`; the
 * marker is accepted for exports that include one).
 */
const BLOCK_ENUM = [
  'start',
  'end',
  'answer',
  'llm',
  'knowledge-retrieval',
  'question-classifier',
  'if-else',
  'code',
  'template-transform',
  'http-request',
  'variable-assigner',
  'variable-aggregator',
  'tool',
  'parameter-extractor',
  'iteration',
  'document-extractor',
  'list-operator',
  'iteration-start',
  'assigner',
  'agent',
  'loop',
  'loop-start',
  'loop-end',
  'human-input',
  'datasource',
  'datasource-empty',
  'knowledge-index',
  'trigger-schedule',
  'trigger-webhook',
  'trigger-plugin',
]

const EXTRA = ['custom-note', 'iteration-end', 'trigger']

const ROOT = new URL('..', import.meta.url).pathname
const DSL = join(ROOT, 'dsl')
const idOf = (type) => `n_${type.replace(/[^a-z0-9]+/gi, '_')}`
const parentOf = {
  'iteration-start': idOf('iteration'),
  'loop-start': idOf('loop'),
  'loop-end': idOf('loop'),
  'iteration-end': idOf('iteration'),
}

function allTypesYml() {
  const lines = ['app: { name: all-node-types, mode: workflow }', 'workflow:', '  graph:', '    nodes:']
  for (const type of [...BLOCK_ENUM, ...EXTRA]) {
    const id = idOf(type)
    const parent = parentOf[type]
    lines.push(`      - id: ${id}`)
    lines.push('        type: custom')
    if (parent !== undefined) lines.push(`        parentId: ${parent}`)
    lines.push('        data:')
    lines.push(`          type: ${type}`)
    lines.push(`          title: "${type}"`)
    if (type === 'start') lines.push('          variables: [{ variable: seed }]')
    if (type === 'end') lines.push(`          outputs: [{ variable: out, value_selector: [${idOf('llm')}, text] }]`)
    if (type === 'iteration' || type === 'loop') lines.push(`          start_node_id: ${idOf(`${type}-start`)}`)
  }
  return lines.join('\n')
}

// 1. Every official type maps to a canonical (non-generic) IR kind.
{
  for (const type of [...BLOCK_ENUM, ...EXTRA]) {
    assert.notEqual(normalizeKind(type), 'generic', `${type} must be a known kind`)
    assert.ok(KNOWN_KINDS.has(normalizeKind(type)), `${type} must be registered in KNOWN_KINDS`)
  }
  for (const kind of BLOCK_ENUM.map(normalizeKind)) assert.ok(NODE_KINDS.map(normalizeKind).includes(kind))
  console.log(`ok 1 — ${BLOCK_ENUM.length} BlockEnum types + ${EXTRA.length} extras all map to canonical kinds`)
}

// 2. One synthetic graph containing EVERY type parses into IR with zero unknown
//    kinds and correct container association.
{
  const parsed = parseDifyDsl(allTypesYml())
  const ir = buildIR(parsed)
  assert.equal(ir.nodes.length, BLOCK_ENUM.length + EXTRA.length)
  assert.deepEqual(ir.unknownKinds, [])
  assert.equal(ir.byId.get(idOf('start')).kind, 'start')
  assert.equal(ir.byId.get(idOf('variable-assigner')).kind, 'assigner')
  assert.equal(ir.byId.get(idOf('datasource-empty')).kind, 'datasource')
  assert.equal(ir.byId.get(idOf('custom-note')).kind, 'note')
  assert.equal(ir.byId.get(idOf('iteration-end')).kind, 'iteration-end')
  assert.equal(ir.byId.get(idOf('trigger')).kind, 'trigger')
  const iteration = ir.containers.get(idOf('iteration'))
  assert.deepEqual(iteration.children.map((child) => child.kind), ['iteration-start', 'iteration-end'])
  const loop = ir.containers.get(idOf('loop'))
  assert.deepEqual(loop.children.map((child) => child.kind), ['loop-start', 'loop-end'])
  console.log('ok 2 — a graph with every type parses into IR; containers associate their markers')
}

// 3. Coverage count: the synthetic IR contains every canonical official kind.
{
  const ir = buildIR(parseDifyDsl(allTypesYml()))
  const covered = new Set(ir.nodes.map((node) => node.kind))
  const required = [...new Set(BLOCK_ENUM.map(normalizeKind))]
  const missing = required.filter((kind) => !covered.has(kind))
  assert.deepEqual(missing, [])
  console.log(`ok 3 — parse-layer coverage: ${required.length}/${required.length} official kinds covered (no blind spot)`)
}

// 4. Every real .yml in dsl/ parses with no unknown type and no structural
//    issue, and compiles to a workflow script.
{
  const files = readdirSync(DSL).filter((file) => file.endsWith('.yml')).sort()
  assert.ok(files.length >= 10, `expected several DSL samples, found ${files.length}`)
  for (const file of files) {
    const parsed = parseDifyDsl(readFileSync(join(DSL, file), 'utf8'))
    const inspection = inspectGraph(parsed)
    assert.deepEqual(inspection.unknownKinds, [], `${file} has an unknown node type`)
    assert.deepEqual(inspection.issues, [], `${file} has parse/schedule issues`)
    const compiled = compileGraph(parsed)
    assert.match(compiled.script, /return \{ nodes: __nodes, outputs:/, `${file} did not compile`)
  }
  console.log(`ok 4 — ${files.length} real DSL samples parse clean, no unknown types, all compile`)
}

// 5. The mature multi-node sample exercises the new node families in one graph.
{
  const parsed = parseDifyDsl(readFileSync(join(DSL, 'mature-ticket-triage.yml'), 'utf8'))
  const inspection = inspectGraph(parsed)
  const expected = ['parameter-extractor', 'if-else', 'llm', 'variable-aggregator', 'code', 'iteration', 'iteration-start', 'template-transform', 'end']
  for (const kind of expected) assert.ok(inspection.nodeTypes[kind] >= 1, `mature sample should include ${kind}`)
  assert.deepEqual(inspection.issues, [])
  console.log(`ok 5 — mature sample covers ${Object.keys(inspection.nodeTypes).length} kinds in one compilable graph`)
}

console.log('COVERAGE TESTS OK')
