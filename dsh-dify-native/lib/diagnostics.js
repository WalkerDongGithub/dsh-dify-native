/**
 * Internal diagnostics for the Dify DSL compiler and node provider.
 *
 * The runtime is being built out node by node, so a graph can be *executed* by
 * a node implementation that is only a subset of Dify's semantics. That is
 * allowed — what is not allowed is losing the fact silently. Every place that
 * skips a node, drops a DSL field, or substitutes a simplified implementation
 * records a diagnostic here instead of throwing.
 *
 * Diagnostics never change behaviour: a graph with diagnostics still runs and
 * still reports `succeeded`. They are surfaced for engineers through the
 * `dify_native_inspect` output and the per-node `dify_native_run` record (and
 * the trace file), never presented to an end user as an error.
 *
 * Deliberately dependency-free and side-effect-free so both the compile layer
 * (`dsl.js`) and the execution layer (`provider.js`/`index.js`) can use it
 * without a cycle.
 */

/**
 * Subject namespace for the Dify-semantics deviation rows (`semantics-differ`,
 * `semantics-degraded`, `node-unsupported`).
 *
 * These coexist with `field-dropped`, whose subject is the bare `"<node>:<field>"`
 * — "you set this, we ignored it". A deviation says something different: "this
 * node behaves differently from Dify on this axis", and it fires whether or not
 * the DSL set the field. Sharing a namespace made a deviation look like a
 * dropped field on a field that IS implemented (e.g. `structured_output_enabled`),
 * breaking the honest "not implemented => reported" contract the other codes
 * guarantee. The prefix keeps the two separable by subject alone.
 */
export const DEVIATION_PREFIX = '~'

/**
 * Collect diagnostics for one compile or run.
 * @returns a collector with the sink shape the rest of the package uses.
 */
export function createDiagnostics() {
  const rows = []
  const seen = new Set()
  const add = (severity, code, subject, message) => {
    // One row per (code, subject): a node visited twice must not double-report.
    const key = `${code}\u0000${subject}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ severity, code, subject, message })
  }
  return {
    /** A field was present in the DSL but has no implementation; it was ignored. */
    dropped(subject, field, nodeKind) {
      add('warning', 'field-dropped', `${subject}:${field}`, `${nodeKind ?? 'node'} ${subject}: field "${field}" is parsed but not implemented; value is ignored`)
    },
    /** A node runs with a subset of its Dify semantics. */
    simplified(subject, nodeKind, message) {
      add('warning', 'node-simplified', subject, `${nodeKind} ${subject}: ${message}`)
    },
    /** A node is recognized and scheduled but performs no work. */
    placeholder(subject, nodeKind, message) {
      add('warning', 'node-placeholder', subject, `${nodeKind} ${subject}: ${message}`)
    },
    /** A node type is unknown to this compiler; it executes as a no-op. */
    unknown(subject, rawType) {
      add('warning', 'node-unknown', subject, `node ${subject}: unknown type "${rawType}"; executed as a generic passthrough (no work performed)`)
    },
    /**
     * A template-transform template does not compile as Jinja2. This is the
     * template author's error: the run fails that node rather than emitting the
     * raw text. Reported at compile time so `inspect` shows it before a run
     * spends models on the nodes leading up to it.
     */
    templateInvalid(subject, nodeKind, problem) {
      add(
        'warning',
        'template-jinja-invalid',
        `${subject}:template`,
        `${nodeKind} ${subject}: Jinja2 template does not compile — ${problem}. ` +
          'This is a template error in the workflow; the node will fail when the run reaches it.',
      )
    },
    /**
     * The node runs and reports success, but does something DIFFERENT from Dify
     * rather than something less. Distinct from `node-simplified` because a
     * reduced implementation is visible in the output shape, while this one
     * usually is not: e.g. an LLM served by another model still returns text.
     *
     * `where` is the DSL field/condition responsible, `what` the user-visible
     * consequence, `fix` what to do about it (may be empty).
     *
     * IMPORTANT: these rows must NEVER be used to downgrade a support level.
     * If they were, every node of a known kind would become `simplified` and the
     * level would stop discriminating. They are reported as their own codes.
     */
    differs(subject, nodeKind, where, what, fix) {
      add(
        'notice',
        'semantics-differ',
        `${DEVIATION_PREFIX}${subject}:${where}`,
        `${nodeKind} ${subject} [${where}] differs from Dify: ${what}${fix ? ` -> ${fix}` : ''}`,
      )
    },
    /** The node runs with reduced fidelity on this axis (a subset, not a swap). */
    degraded(subject, nodeKind, where, what, fix) {
      add(
        'warning',
        'semantics-degraded',
        `${DEVIATION_PREFIX}${subject}:${where ?? 'node'}`,
        `${nodeKind} ${subject}${where ? ` [${where}]` : ''} is degraded: ${what}${fix ? ` -> ${fix}` : ''}`,
      )
    },
    /**
     * The node cannot do this at all. It fails or is refused before side
     * effects — loud, never silent. Reported up front so `inspect` reveals it
     * before a run spends models on the nodes leading up to it.
     */
    rejected(subject, where, what, fix) {
      add(
        'warning',
        'node-unsupported',
        `${DEVIATION_PREFIX}${subject}:${where}`,
        `node ${subject} [${where}] is not supported: ${what}${fix ? ` -> ${fix}` : ''}`,
      )
    },
    /** Free-form diagnostic for the compiler's own structural notices. */
    note(subject, message) {
      add('warning', 'note', subject, message)
    },
    /** All diagnostics collected so far (a copy). */
    list() {
      return rows.slice()
    },
    /** Diagnostic messages as plain strings, for `warnings: string[]` callers. */
    messages() {
      return rows.map((row) => row.message)
    },
    /** Codes present, for a compact summary. */
    codes() {
      const out = {}
      for (const row of rows) out[row.code] = (out[row.code] ?? 0) + 1
      return out
    },
    get size() {
      return rows.length
    },
  }
}

/**
 * Node-data keys that are presentation-only, so their absence of an
 * implementation is never reportable: canvas placement, authoring metadata,
 * and ReactFlow bookkeeping.
 */
const IGNORED_FIELDS = new Set([
  'type', 'title', 'desc', 'selected', 'position', 'positionAbsolute',
  'width', 'height', 'zIndex', 'extent', 'dragHandle', 'sourcePosition',
  'targetPosition', 'isInIteration', 'isInLoop', 'iteration_id', 'loop_id',
  'parentId', 'isParallel', 'isLoop', 'label', 'color', 'icon',
])

/**
 * Report every node-data key that is neither presentation-only nor known to be
 * consumed by this runtime. `consumed` is the set of keys the compiler actually
 * reads for that node kind (see `CONSUMED_FIELDS` in `dsl.js`), so a reported
 * key means "the DSL set a value that had no effect".
 *
 * @param diagnostics - collector from {@link createDiagnostics}.
 * @param nodeId - node under inspection (used as the diagnostic subject).
 * @param kind - canonical node kind, for the message.
 * @param data - the raw `node.data` object.
 * @param consumed - keys this node kind reads.
 */
export function reportDroppedFields(diagnostics, nodeId, kind, data, consumed) {
  if (data === null || typeof data !== 'object') return
  for (const key of Object.keys(data)) {
    if (IGNORED_FIELDS.has(key)) continue
    if (consumed.has(key)) continue
    diagnostics.dropped(nodeId, key, kind)
  }
}
