/**
 * Diagnostics coverage: nodes and DSL values that are recognized but not fully
 * implemented must be *reported*, never silently ignored — and never fatal.
 *
 * The contract this file pins down:
 *   - an unknown node type parses, compiles, and runs as a passthrough, and is
 *     reported as `node-unknown` with mode `passthrough`;
 *   - a DSL field with no implementation is reported as `field-dropped` with a
 *     node-scoped subject, and the graph still compiles;
 *   - nodes with a documented subset of Dify semantics report their `mode`
 *     (`simplified` / `placeholder`) without changing compile success;
 *   - diagnostics never appear in `issues`, so `compileGraph` still succeeds.
 *
 *   node tests/diagnostics.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildIR, compileGraph, inspectGraph, parseDifyDsl } from '../lib/dsl.js'

const ROOT = new URL('..', import.meta.url).pathname
const DSL_DIR = join(ROOT, 'dsl')
const HEADER = 'app: { name: diagnostics, mode: workflow }\nkind: app\nversion: 0.1.3\nworkflow:\n  graph:\n'

/** Build a minimal start → <middle> → end DSL from a middle-node YAML block. */
function graphYaml(middle, { edges } = {}) {
  const nodes = [
    '      - { id: s, type: custom, data: { type: start, variables: [{ variable: q, type: text-input, required: true }] } }',
    middle,
    '      - { id: e, type: custom, data: { type: end, outputs: [{ variable: out, value_selector: [m, text] }] } }',
  ].join('\n')
  const links = edges ?? [
    '      - { id: e1, source: s, target: m, sourceHandle: source }',
    '      - { id: e2, source: m, target: e, sourceHandle: source }',
  ]
  return `${HEADER}    nodes:\n${nodes}\n    edges:\n${links.join('\n')}\n`
}

function inspect(text) {
  return inspectGraph(parseDifyDsl(text))
}

const codes = (inspection) => inspection.diagnostics.map((row) => row.code)

/**
 * Dify-semantics deviations are reported for every node of a known kind, by
 * design (see DEVIATION_PREFIX in lib/diagnostics.js): they say "this node
 * behaves differently from Dify on axis X" and must not depend on whether the
 * DSL happened to set a field. The assertions below are about the
 * *drop / unknown / support-level* contract, so they filter deviation rows out
 * rather than switching them off — a silent global switch would let a real
 * deviation disappear unnoticed, which is exactly what this file guards.
 */
const DEVIATION_CODES = new Set(['semantics-differ', 'semantics-degraded', 'node-unsupported'])
const isDeviation = (row) => DEVIATION_CODES.has(row.code)
const dropsOnly = (inspection) => inspection.diagnostics.filter((row) => !isDeviation(row))
const subjects = (inspection, code) =>
  inspection.diagnostics.filter((row) => row.code === code).map((row) => row.subject.split(':')[0])
const supportOf = (inspection, id) => inspection.support.find((row) => row.id === id)

// ---------------------------------------------------------------- unknown node

{
  const text = graphYaml('      - { id: m, type: custom, data: { type: future-node, title: 未来节点 } }')
  const inspection = inspect(text)

  assert.equal(inspection.issues.length, 0, 'an unknown type must not make the graph invalid')
  assert.ok(
    inspection.diagnostics.some((row) => row.code === 'node-unknown' && row.subject === 'm'),
    'unknown node type is reported',
  )
  assert.match(
    inspection.diagnostics.find((row) => row.code === 'node-unknown').message,
    /future-node.*passthrough|passthrough.*future-node/,
  )
  assert.deepEqual(inspection.unknownKinds, ['future-node'])
  assert.equal(supportOf(inspection, 'm').mode, 'passthrough', 'support row marks the node as passthrough')

  // Still compiles and executes as an explicit no-op.
  const compiled = compileGraph(parseDifyDsl(text))
  assert.match(compiled.script, /kind: 'generic'/)
  assert.match(compiled.script, /passthrough/)
  console.log('ok 1 — unknown node type is reported as node-unknown and still compiles as a visible passthrough')
}

// ------------------------------------------------------------- dropped fields

{
  const text = graphYaml(
    '      - { id: m, type: custom, data: { type: llm, title: 模型, model: { provider: zai, name: glm-4.5-air, completion_params: { temperature: 0.2, top_p: 0.5, response_format: json } }, prompt_template: [{ role: user, text: "{{#s.q#}}" }], retry_config: { retry_enabled: true, max_retries: 3 }, memory: { window: { enabled: true, size: 10 } }, vision: { enabled: true } } }',
  )
  const inspection = inspect(text)
  const dropped = inspection.diagnostics.filter((row) => row.code === 'field-dropped').map((row) => row.subject)

  assert.equal(inspection.issues.length, 0)
  for (const field of ['retry_config', 'vision', 'model.completion_params.top_p', 'model.completion_params.response_format']) {
    assert.ok(dropped.includes(`m:${field}`), `field "${field}" is reported as dropped`)
  }
  assert.ok(!dropped.includes('m:model.completion_params.temperature'), 'an implemented parameter is not reported')
  assert.equal(supportOf(inspection, 'm').mode, 'simplified', 'a node with dropped fields is marked simplified')
  assert.match(supportOf(inspection, 'm').reason, /dropped/)

  // Non-fatal: the graph still compiles and the field simply has no effect.
  assert.ok(compileGraph(parseDifyDsl(text)).script.length > 0)
  console.log('ok 2 — unimplemented DSL fields are reported as field-dropped and do not fail compilation')
}

// ------------------------------------------- default-valued params are silent

{
  const text = graphYaml(
    '      - { id: m, type: custom, data: { type: llm, title: 模型, model: { provider: zai, name: glm-4.5-air, completion_params: { temperature: 0.1, top_p: 1, presence_penalty: 0, frequency_penalty: 0 } }, prompt_template: [{ role: user, text: "{{#s.q#}}" }], vision: { enabled: false } } }',
  )
  const inspection = inspect(text)
  assert.deepEqual(dropsOnly(inspection), [], 'parameters equal to their provider default are not noise')
  console.log('ok 3 — top_p: 1 / zero penalties / vision disabled are not reported')
}

// ------------------------------------------------------- partial node support

{
  const HUMAN_EDGES = [
    '      - { id: e1, source: s, target: m, sourceHandle: source }',
    '      - { id: e2, source: m, target: e, sourceHandle: approve }',
  ]
  const cases = [
    ['knowledge-retrieval', 'simplified', 'dataset_ids: [], query_variable_selector: [s, q]', undefined],
    ['knowledge-index', 'placeholder', 'dataset_id: ds', undefined],
    ['agent', 'simplified', 'agent_strategy_name: ReAct, agent_parameters: {}', undefined],
    ['document-extractor', 'simplified', 'is_array_file: false, variable_selector: [s, q]', undefined],
    // human-input leaves on an action handle, not `source`.
    ['human-input', 'simplified', 'user_actions: [{ id: approve, title: 通过 }]', HUMAN_EDGES],
  ]
  for (const [kind, mode, dataFields, edges] of cases) {
    // Quote the title: an unquoted `title: knowledge-retrieval` is parsed as YAML
    // flow continuation, not a string.
    const text = graphYaml(
      `      - { id: m, type: custom, data: { type: ${kind}, title: "${kind}", ${dataFields} } }`,
      edges === undefined ? undefined : { edges },
    )
    const inspection = inspect(text)
    assert.equal(inspection.issues.length, 0, `${kind} must stay compilable: ${inspection.issues.join('; ')}`)
    const row = supportOf(inspection, m_assertId(inspection))
    assert.equal(row.mode, mode, `${kind} reports mode ${mode}`)
    assert.ok(row.reason.length > 0, `${kind} explains its limitation`)
  }
  console.log('ok 4 — nodes with partial semantics report their mode (simplified / placeholder)')
}

function m_assertId(inspection) {
  return inspection.nodeIds.find((id) => id !== 's' && id !== 'e')
}

// --------------------------------------------------- real samples stay clean

{
  // Zero false positives on the fully implemented samples, and every reported
  // drop must name a field this runtime genuinely does not read.
  const fullySupported = new Set()
  const knownDrops = new Set([
    'retry_config', 'vision', 'context.enabled',
    'variables', 'var_type', 'agent_strategy_provider_name',
    'retrieval_mode',
    'model.completion_params.top_p',
    'model.completion_params.presence_penalty',
    'model.completion_params.frequency_penalty',
  ])
  const allowedTopLevel = new Set([...knownDrops].map((field) => field.split('.')[0]))
  const knownFileDrops = {
    'intent-reply.yml': ['context.enabled', 'retrieval_mode', 'model.completion_params.top_p', 'vision'],
    'lang-consistency.yml': ['model.completion_params.frequency_penalty', 'model.completion_params.presence_penalty', 'model.completion_params.top_p'],
    'nodes-agent.yml': ['agent_strategy_provider_name'],
    'nodes-datasource.yml': ['variables'],
    'nodes-list-operator.yml': ['var_type'],
  }

  for (const file of readdirSync(DSL_DIR).filter((name) => name.endsWith('.yml')).sort()) {
    const inspection = inspect(readFileSync(join(DSL_DIR, file), 'utf8'))
    assert.equal(inspection.issues.length, 0, `${file} still compiles`)
    // Only field drops: deviation rows are expected on every known node kind and
    // are asserted separately below, so they must not be mistaken for drops.
    const reported = dropsOnly(inspection).map((row) => row.subject.slice(row.subject.indexOf(':') + 1))
    for (const field of reported) {
      assert.ok(knownDrops.has(field.split('.')[0]) && allowedTopLevel.has(field.split('.')[0]) || knownDrops.has(field), `${file}: unexpected diagnostic field ${field}`)
    }
    if (knownFileDrops[file] === undefined) {
      assert.deepEqual(reported, [], `${file} has no dropped-field diagnostics`)
    } else {
      assert.deepEqual([...new Set(reported)].sort(), [...knownFileDrops[file]].sort(), `${file} reports exactly its known gaps`)
    }
    for (const row of inspection.support) {
      if (row.mode === 'full') continue
      fullySupported.add(`${file}:${row.id}:${row.mode}`)
    }
  }
  // These samples set no field the runtime ignores: their exports lose nothing.
  // The node may still be `simplified` for a standing reason (an is_parallel
  // iteration follows engine ordering, an llm routes through the profile), so
  // assert on dropped fields rather than on the level.
  for (const file of ['translation.yml', 'json-repair.yml', 'mature-ticket-triage.yml', 'nodes-iteration.yml', 'jieba.yml']) {
    const inspection = inspect(readFileSync(join(DSL_DIR, file), 'utf8'))
    assert.deepEqual(inspection.diagnostics.filter((row) => row.code === 'field-dropped'), [], `${file} drops no declared field`)
  }
  // ...while deviations from Dify semantics ARE reported on every real sample:
  // a graph must never look pristine just because every node classifies `full`.
  for (const file of readdirSync(DSL_DIR).filter((name) => name.endsWith('.yml')).sort()) {
    const inspection = inspect(readFileSync(join(DSL_DIR, file), 'utf8'))
    assert.ok(Array.isArray(inspection.deviations), `${file} exposes a deviations list`)
    for (const row of inspection.deviations) {
      assert.ok(DEVIATION_CODES.has({ 'silent-changed': 'semantics-differ', degraded: 'semantics-degraded', rejected: 'node-unsupported' }[row.severity]), `${file}: deviation severity ${row.severity} has a diagnostic code`)
      assert.ok(row.consequence && row.consequence.length > 10, `${file}: deviation on ${row.nodeId} explains its consequence`)
    }
  }
  console.log('ok 5 — the 18 real DSL samples report only their genuine gaps; fully implemented graphs stay silent by drop-code, and every known deviation is enumerated')
}

// ------------------------------------------------------ diagnostics never fail

{
  // A graph that would previously "succeed" silently with no work now succeeds
  // with a diagnostic, and `status` semantics are unchanged: no issue, no throw.
  const text = graphYaml('      - { id: m, type: custom, data: { type: totally-unknown, title: x } }')
  const ir = buildIR(parseDifyDsl(text))
  // start/end carry their own (always-on) deviation rows; the unknown node adds
  // exactly one node-unknown and the passthrough deviation explaining its silence.
  assert.deepEqual({ ...ir.diagnosticCodes, 'semantics-differ': 0, 'semantics-degraded': 0 }, { 'node-unknown': 1, 'semantics-differ': 0, 'semantics-degraded': 0 }, 'unknown node type is still the only drop-class code')
  assert.equal(ir.diagnosticCodes['node-unknown'], 1)
  assert.equal(ir.issues, undefined, 'buildIR carries no issue list; inspection does')
  assert.equal(inspect(text).issues.length, 0)
  console.log('ok 6 — diagnostics are advisory: they never become compile issues')
}


// ------------------------------------- known deviations are always reported

{
  // Every node kind this runtime executes must enumerate its Dify deviations,
  // so no node can look pristine merely because it classifies `full`. These are
  // the user-facing "this succeeds but does something else" warnings.
  const cases = {
    // LLM: routed to another model is the flagship silent gap.
    llm: '      - { id: m, type: custom, data: { type: llm, title: 模型, model: { provider: zai, name: glm-4.5-air }, prompt_template: [{ role: user, text: "{{#s.q#}}" }] } }',
    // knowledge-index succeeds while writing nothing.
    'knowledge-index': '      - { id: m, type: custom, data: { type: knowledge-index, title: 索引, dataset_id: ds, index_chunk_variable_selector: [s, q] } }',
    // A plugin-shaped tool is refused, not silently swapped for another tool.
    tool: '      - { id: m, type: custom, data: { type: tool, title: 工具, provider_type: plugin, provider_id: p, tool_name: jina_reader } }',
  }
  for (const [kind, middle] of Object.entries(cases)) {
    const inspection = inspect(graphYaml(middle))
    // graphYaml always contributes s (start) and e (end), which carry their own
    // deviations; scope to the node under test.
    const row = inspection.deviations.filter((item) => item.nodeId === 'm')
    assert.ok(row.length > 0, `${kind} must enumerate at least one deviation`)
    for (const item of row) {
      assert.equal(item.nodeKind, kind)
      assert.ok(['silent-changed', 'degraded', 'rejected'].includes(item.severity), `${kind}: severity ${item.severity} is from the fixed vocabulary`)
      assert.ok(item.consequence.length > 10, `${kind}: deviation explains the consequence`)
      assert.ok(item.where === null || typeof item.where === 'string', `${kind}: where is null or a DSL field/condition`)
    }
    // The mirrored diagnostic codes exist too, under the deviation namespace so
    // they can never be mistaken for a `field-dropped` on an implemented field.
    const mirrored = inspection.diagnostics.filter((d) => isDeviation(d) && d.subject.startsWith('~m'))
    assert.ok(mirrored.length > 0, `${kind}: deviations are mirrored as diagnostics`)
    for (const d of mirrored) assert.ok(d.subject.startsWith('~'), `${kind}: deviation subject ${d.subject} is namespaced`)
  }

  // Deviations must never downgrade a support level: that would collapse the
  // mode taxonomy (everything known would read `simplified`).
  const llmOnly = inspect(graphYaml(cases.llm))
  assert.equal(supportOf(llmOnly, 'm').mode, 'full', 'a plain llm with no dropped field stays full')

  // ...and they must never become compile issues.
  assert.equal(llmOnly.issues.length, 0, 'deviations never block compilation')
  console.log('ok 7 — known deviations from Dify are always enumerated, namespaced, and never downgrade support')
}

console.log('DIAGNOSTICS TESTS OK')
