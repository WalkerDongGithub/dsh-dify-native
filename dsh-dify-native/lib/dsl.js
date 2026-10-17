/**
 * Dify DSL → IR → workflow-script compiler.
 *
 * This module owns ONLY the translation layer the guide allows us to write:
 * parse a Dify .yml, normalize `workflow.graph` into an explicit IR, then emit a
 * JavaScript orchestration script for the harness's existing workflow engine.
 * It contains no scheduler, no executor, no sandbox, no LLM adapter.
 *
 * Node coverage is intentionally *complete*: every Dify `BlockEnum` type is
 * recognized and normalized into an IR node. An unknown future type is still
 * parsed (kind `generic`, recorded as a warning) so the parse layer never says
 * "I don't know this node"; execution of such a node is a visible passthrough.
 *
 * Graph shape: one entry (`start`, or a trigger/datasource node when the app is
 * trigger-driven) to one `end` or one/more terminal `answer` nodes, with
 * iteration / loop containers whose children are associated by `parentId`
 * (ReactFlow) or `data.iteration_id` / `data.loop_id`.
 *
 * Branch ownership stays in code: if-else evaluates its DSL conditions,
 * question-classifier maps the model's answer back to a pre-declared class id,
 * http-request maps success/failure to pre-declared edge handles, and
 * human-input maps its resolved action to a pre-declared action handle. The
 * model never chooses which edge runs. Iteration and loop bodies are compiled
 * into ordinary `for` loops (or the engine's `parallel` combinator for
 * `is_parallel: true`), so loop bounds and item order are code, not model.
 */
import { parse as parseYaml } from 'yaml'
import { createDiagnostics, reportDroppedFields } from './diagnostics.js'
import { compileJinja, hasJinja } from './jinja.js'

/**
 * Canonical node kinds. The first block is Dify's `BlockEnum` (web types.ts),
 * the rest are wrapper/internal aliases Dify exports and the two internal
 * markers this compiler also accepts (`iteration-end`, `generic`).
 */
export const NODE_KINDS = [
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
  // accepted aliases / internal markers (not in the frontend enum)
  'iteration-end',
  'trigger',
  'custom-note',
]

/** Wrapper variant → canonical kind. */
const KIND_ALIASES = {
  'variable-assigner': 'assigner',
  'datasource-empty': 'datasource',
  'custom-note': 'note',
  'custom-iteration-start': 'iteration-start',
  'trigger': 'trigger',
}

export const KNOWN_KINDS = new Set(NODE_KINDS.map((kind) => KIND_ALIASES[kind] ?? kind))

/** Kinds that execute through the `dify-node` host provider (one agent() call). */
const HOST_KINDS = new Set([
  'llm',
  'code',
  'if-else',
  'question-classifier',
  'http-request',
  'tool',
  'knowledge-retrieval',
  'knowledge-index',
  'agent',
  'parameter-extractor',
  'document-extractor',
  'datasource',
  'human-input',
])

/** Kinds whose outgoing edge handle names a pre-declared branch. */
const BRANCH_KINDS = new Set(['if-else', 'question-classifier', 'http-request', 'human-input'])

/** Kinds that own a nested sub-graph. */
const CONTAINER_KINDS = new Set(['iteration', 'loop'])

/** Kinds that may be a graph entry when there is no `start` node. */
const TRIGGER_KINDS = new Set(['trigger', 'trigger-schedule', 'trigger-webhook', 'trigger-plugin', 'datasource'])

/** Kinds that are internal container markers, never top-level work. */
const MARKER_KINDS = new Set(['iteration-start', 'iteration-end', 'loop-start', 'loop-end'])

/** Kinds that produce no work and may sit disconnected on the canvas. */
const NON_EXECUTABLE_KINDS = new Set(['note'])

/**
 * Node-data keys this compiler reads, per canonical kind. A key present in a
 * node's `data` but absent here is reported as dropped: the DSL set a value
 * that has no effect on this runtime.
 */
const CONSUMED_FIELDS = {
  start: new Set(['variables']),
  end: new Set(['outputs']),
  answer: new Set(['answer', 'variables']),
  llm: new Set(['model', 'prompt_template', 'variables', 'context', 'vision', 'memory', 'structured_output_enabled', 'structured_output']),
  code: new Set(['code_language', 'code', 'variables', 'outputs', 'dependencies']),
  'if-else': new Set(['cases', 'logical_operator']),
  'question-classifier': new Set(['model', 'classes', 'query_variable_selector', 'instruction', 'instructions', 'topics', 'memory']),
  'http-request': new Set(['method', 'url', 'headers', 'params', 'body', 'authorization', 'error_strategy', 'default_value', 'timeout']),
  tool: new Set(['provider_id', 'provider_name', 'provider_type', 'tool_name', 'tool_label', 'tool_parameters', 'tool_configurations', 'settings']),
  'knowledge-retrieval': new Set(['dataset_ids', 'query_variable_selector', 'retrieval_setting', 'single_retrieval_config', 'multiple_retrieval_config']),
  'knowledge-index': new Set(['dataset_id', 'index_chunk_variable_selector', 'keyword_number']),
  agent: new Set(['agent_strategy_name', 'agent_strategy_label', 'version', 'agent_parameters', 'agent_job', 'output_schema', 'model', 'memory']),
  'parameter-extractor': new Set(['model', 'query', 'query_variable_selector', 'instruction', 'reasoning_mode', 'parameters', 'memory']),
  'document-extractor': new Set(['is_array_file', 'variable_selector']),
  'list-operator': new Set(['variable', 'filter_by', 'order_by', 'limit']),
  datasource: new Set(['provider_name', 'provider_id', 'provider_type', 'datasource_name', 'datasource_label', 'datasource_parameters']),
  'human-input': new Set(['user_actions', 'form_content', 'inputs', 'timeout', 'timeout_unit']),
  iteration: new Set(['iterator_selector', 'output_selector', 'is_parallel', 'parallel_nums', 'error_handle_mode', 'start_node_id', 'output_type', 'flatten_output']),
  loop: new Set(['loop_count', 'loop_count_selector', 'break_conditions', 'logical_operator', 'error_handle_mode', 'start_node_id']),
  'template-transform': new Set(['template', 'variables']),
  assigner: new Set(['items', 'version', 'assigned_variable_selector', 'input_variable_selector', 'write_mode', 'value']),
  'variable-aggregator': new Set(['output_type', 'variables', 'advanced_settings']),
  'iteration-start': new Set(['variables']),
  'loop-start': new Set(),
  'loop-end': new Set(['outputs']),
  'iteration-end': new Set(['outputs']),
  note: new Set(['text']),
  trigger: new Set(['method', 'content_type', 'variables', 'status_code', 'schedule_type', 'cron', 'mode', 'endpoint']),
  'trigger-schedule': new Set(['schedule_type', 'cron', 'mode', 'variables']),
  'trigger-webhook': new Set(['method', 'content_type', 'variables', 'status_code', 'endpoint']),
  'trigger-plugin': new Set(['provider_name', 'provider_id', 'event', 'variables']),
  generic: new Set(),
}

/**
 * Completion parameters carried into the LLM request. Any other key under
 * `model.completion_params` is reported by {@link reportModelGaps}.
 */
const CONSUMED_COMPLETION_PARAMS = new Set(['temperature', 'max_tokens'])

/**
 * Completion parameters that are harmless at their default and equal to it in
 * most real exports (`top_p: 1`, zero penalties). Reporting them would bury the
 * parameters that actually change model behaviour, so they are skipped only
 * while their value is the provider default.
 */
const DEFAULT_SILENT_COMPLETION_PARAMS = {
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
  max_tokens: undefined,
}

/**
 * Inspect a node for DSL values this runtime does not implement. The generic
 * sweep over `data` (in `buildIR`) covers top-level keys; this pass handles the
 * two nested shapes that sweep cannot see: `model.completion_params.*` and
 * `context.enabled`, which changes what `{{#context#}}` contains.
 */
function reportModelGaps(diagnostics, node) {
  const { id, kind, data } = node
  if (data === null || typeof data !== 'object') return
  const model = data.model
  if (model !== null && typeof model === 'object') {
    for (const [key, value] of Object.entries(model.completion_params ?? {})) {
      if (CONSUMED_COMPLETION_PARAMS.has(key)) continue
      // Skip a parameter that is present at its provider default: it cannot
      // change behaviour, so reporting it would be noise, not signal.
      if (key in DEFAULT_SILENT_COMPLETION_PARAMS && value === DEFAULT_SILENT_COMPLETION_PARAMS[key]) continue
      diagnostics.dropped(id, `model.completion_params.${key}`, kind)
    }
  }
  // `context.enabled` switches `{{#context#}}` from empty to retrieval segments;
  // without it the reference always renders empty.
  if (data.context !== null && typeof data.context === 'object' && data.context.enabled === true) {
    diagnostics.dropped(id, 'context.enabled', kind)
  }
  // `vision` is read into the node spec but no image ever reaches the prompt;
  // only an *enabled* vision block is a behavioural gap (disabled is the default).
  if (data.vision !== null && typeof data.vision === 'object' && data.vision.enabled === true) {
    diagnostics.dropped(id, 'vision', kind)
  }
}

/**
 * Compile-check a `template-transform` node's Jinja2 template.
 *
 * Jinja2 itself is rendered at execution time by `lib/jinja.js` (nunjucks). This
 * pass compiles the template up front so a syntax error surfaces in
 * `dify_native_inspect` — before anything runs — instead of after a graph has
 * already spent models and time. It is a report, not a gate: compilation still
 * succeeds, and the run fails the node with the same message.
 *
 * Only `template-transform` is checked: LLM prompts use `{{ name }}` local
 * bindings by design (see `renderTextExpr`), so scanning them would be noise.
 *
 * @param diagnostics - collector from {@link createDiagnostics}.
 * @param node - normalized IR node.
 */
function reportTemplateGaps(diagnostics, node) {
  if (node.kind !== 'template-transform') return
  const template = node.data?.template
  if (typeof template !== 'string' || template.length === 0) return
  // Selector references are resolved by this compiler before Jinja runs, so
  // they must be blanked for the check: `{{#a.b#}}` is not Jinja and would
  // otherwise be reported as an unbalanced `}}`.
  const checkable = template.replace(/\{\{#([^#{}]+)#\}\}/g, '')
  const problem = compileJinja(checkable)
  if (problem !== undefined) diagnostics.templateInvalid(node.id, node.kind, problem)
}

function nodeType(node) {
  return node?.data?.type ?? node?.type
}

function nodeTitle(node) {
  return node?.data?.title ?? ''
}

function edgeHandle(edge) {
  return edge?.sourceHandle ?? 'source'
}

/** Normalize a raw Dify `data.type` (incl. wrapper aliases) to a canonical kind. */
export function normalizeKind(rawType) {
  const raw = String(rawType ?? '')
  const kind = KIND_ALIASES[raw] ?? raw
  return KNOWN_KINDS.has(kind) ? kind : 'generic'
}

/** Selector `['node-id', 'var']` → JS expression in the generated script. */
function selectorExpr(selector, scope) {
  if (!Array.isArray(selector) || selector.length !== 2) {
    throw new Error(`unsupported value_selector ${JSON.stringify(selector)}`)
  }
  const [nodeId, name] = selector
  const key = JSON.stringify(String(name))
  const head = String(nodeId)
  if (head === scope.startId) return `args[${key}]`
  // Dify's variable scopes. `conversation` / `environment` start from the DSL's
  // declared values and are updated by assigner nodes; `sys` is derived from
  // the run inputs.
  if (head === 'conversation' || head === 'environment' || head === 'sys') return `__vars[${JSON.stringify(head)}][${key}]`
  // Container-local bindings: iteration-start / loop-start expose `item`/`index`,
  // and their declared variables resolve to the current loop's JS values.
  const local = scope.locals?.get(head)
  if (local !== undefined) {
    if (Object.prototype.hasOwnProperty.call(local, name)) return local[name]
    return 'undefined'
  }
  const binding = scope.varByNode.get(head)
  // A node in an untaken branch stays `undefined`; optional chaining lets a
  // join (variable-aggregator / end) read it without throwing.
  if (binding !== undefined) return `${binding}?.outputs[${key}]`
  throw new Error(`value_selector ${nodeId}.${name} does not name an entry input, a variable scope, a container-local binding, or a preceding node`)
}

/**
 * Render a Dify text (LLM prompt / template body / agent instruction) into a
 * JS string expression. `{{#node.var#}}` references resolve through
 * `selectorExpr`; `{{ name }}` references resolve through the node's own
 * `variables` bindings.
 */
function renderTextExpr(text, scope, localBindings = new Map()) {
  /** Split one literal into literal/expression segments on `{{ name }}` bindings. */
  const expandLocals = (literal) => {
    if (localBindings.size === 0) return [{ literal }]
    const out = []
    const token = /\{\{\s*([^{}#]+?)\s*\}\}/g
    let cursor = 0
    let match
    while ((match = token.exec(literal)) !== null) {
      const expr = localBindings.get(match[1].trim())
      if (expr === undefined) continue
      if (match.index > cursor) out.push({ literal: literal.slice(cursor, match.index) })
      out.push({ expr })
      cursor = token.lastIndex
    }
    if (cursor < literal.length) out.push({ literal: literal.slice(cursor) })
    return out
  }

  const expanded = []
  const ref = /\{\{#([^#{}]+)#\}\}/g
  let cursor = 0
  let match
  while ((match = ref.exec(text)) !== null) {
    if (match.index > cursor) expanded.push(...expandLocals(text.slice(cursor, match.index)))
    const selector = match[1].split('.')
    if (selector.length === 1 && localBindings.has(selector[0])) {
      // Dify's reserved `{{#context#}}` placeholder names a node-local binding,
      // not a node output selector.
      expanded.push({ expr: localBindings.get(selector[0]) })
    } else {
      if (selector.length < 2) throw new Error(`malformed prompt reference {{#${match[1]}#}}`)
      expanded.push({ expr: selectorExpr([selector[0], selector.slice(1).join('.')], scope) })
    }
    cursor = ref.lastIndex
  }
  if (cursor < text.length) expanded.push(...expandLocals(text.slice(cursor)))

  if (expanded.length === 0) return '""'
  const parts = expanded.map((chunk) =>
    // `__text` renders arrays of retrieval segments and objects deterministically
    // instead of JavaScript's `[object Object]`.
    chunk.expr !== undefined ? `__text(${chunk.expr})` : JSON.stringify(chunk.literal),
  )
  return `(${parts.join(' + ')})`
}

/**
 * Parse a Dify app DSL into the raw graph layer.
 * @param text - raw .yml contents.
 * @returns parsed graph plus its declared variable scopes.
 */
export function parseDifyDsl(text) {
  const doc = parseYaml(text)
  if (doc == null || typeof doc !== 'object') throw new Error('DSL root is not an object')
  const workflow = doc.workflow
  if (workflow == null || typeof workflow !== 'object') throw new Error('DSL has no workflow block')
  const graph = workflow.graph
  if (graph == null || !Array.isArray(graph.nodes)) throw new Error('workflow.graph.nodes is missing')
  const app = doc.app ?? {}
  return {
    appName: app.name ?? '',
    mode: app.mode ?? '',
    nodes: graph.nodes,
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    environmentVariables: Array.isArray(workflow.environment_variables) ? workflow.environment_variables : [],
    conversationVariables: Array.isArray(workflow.conversation_variables) ? workflow.conversation_variables : [],
    agentPackages: doc.agent_packages ?? {},
    raw: doc,
  }
}

/** One ReactFlow node → one normalized IR node (no graph logic yet). */
function normalizeNode(node) {
  const rawType = String(nodeType(node) ?? '')
  const kind = normalizeKind(rawType)
  const data = node.data ?? {}
  return {
    id: String(node.id),
    rawType,
    kind,
    title: nodeTitle(node),
    parentId: node.parentId != null ? String(node.parentId) : undefined,
    isInIteration: data.isInIteration === true,
    isInLoop: data.isInLoop === true,
    iterationId: data.iteration_id != null ? String(data.iteration_id) : undefined,
    loopId: data.loop_id != null ? String(data.loop_id) : undefined,
    data,
    raw: node,
  }
}

/** Declared container association of a normalized node, if any. */
function declaredParent(node) {
  return node.parentId ?? node.iterationId ?? node.loopId
}

/**
 * Build the explicit IR: normalized nodes, container sub-graphs, top-level
 * edges, and the entry node. Pure parsing — no execution, no ordering errors
 * thrown here (inspection reports them instead).
 *
 * @param parsed - result of {@link parseDifyDsl}.
 * @returns `{ appName, mode, nodes, byId, edges, topNodes, topEdges, containers, entryId, entryKind, startId, startInputs, requiredInputs, warnings, unknownKinds }`
 */
export function buildIR(parsed) {
  const nodes = parsed.nodes.map(normalizeNode)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const warnings = []
  // Structured side channel for engineers: every skip / drop / simplification.
  // `warnings` stays the plain-string list; `diagnostics` keeps code + subject.
  const diagnostics = createDiagnostics()

  for (const node of nodes) {
    if (node.kind === 'generic') {
      warnings.push(`node ${node.id} has unknown type "${node.rawType}"; parsed as generic passthrough`)
      diagnostics.unknown(node.id, node.rawType)
      continue
    }
    // Report every node-data value this compiler does not read, then the nested
    // model parameters. Both are non-fatal: the graph still compiles and runs.
    reportDroppedFields(diagnostics, node.id, node.kind, node.data, CONSUMED_FIELDS[node.kind] ?? new Set())
    reportModelGaps(diagnostics, node)
    reportTemplateGaps(diagnostics, node)
  }

  // Container children: ReactFlow `parentId`, Dify's `data.iteration_id` /
  // `data.loop_id`, or (as a last resort) `isInIteration`/`isInLoop` + the
  // container's own edge into its start node.
  const containers = new Map()
  const childOf = new Map()
  for (const node of nodes) {
    if (!CONTAINER_KINDS.has(node.kind)) continue
    const children = nodes.filter((candidate) => {
      if (candidate.id === node.id) return false
      const parent = declaredParent(candidate)
      if (parent !== undefined) return parent === node.id
      return false
    })
    containers.set(node.id, {
      id: node.id,
      kind: node.kind,
      node,
      children,
      startId: node.data.start_node_id != null ? String(node.data.start_node_id) : undefined,
      endId: undefined,
      innerEdges: [],
    })
    for (const child of children) childOf.set(child.id, node.id)
  }

  // Fallback association for exports that only carry the edge container→start.
  const edgePairs = parsed.edges.map((edge) => ({
    id: String(edge.id ?? ''),
    source: String(edge.source),
    target: String(edge.target),
    handle: String(edgeHandle(edge)),
  }))
  for (const container of containers.values()) {
    if (container.children.length > 0) continue
    const link = edgePairs.find(
      (edge) =>
        edge.source === container.id &&
        byId.has(edge.target) &&
        (byId.get(edge.target).kind === 'iteration-start' ||
          byId.get(edge.target).kind === 'loop-start' ||
          byId.get(edge.target).kind === 'start'),
    )
    if (link === undefined) continue
    const collected = new Set([link.target])
    const queue = [link.target]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const edge of edgePairs) {
        if (edge.source !== current) continue
        if (edge.target === container.id || byId.get(edge.target)?.kind === 'end') continue
        if (collected.has(edge.target)) continue
        collected.add(edge.target)
        queue.push(edge.target)
      }
    }
    container.children = [...collected].map((id) => byId.get(id)).filter(Boolean)
    for (const child of container.children) childOf.set(child.id, container.id)
  }

  // A nested container may omit its own parent metadata even though its
  // incoming edge starts at an explicitly owned body node. Infer only an
  // unambiguous owner, never override explicit metadata or create a cycle.
  // Repeat so deeper nesting can inherit an owner inferred in this pass.
  let inferredParent
  do {
    inferredParent = false
    for (const nested of containers.values()) {
      if (childOf.has(nested.id) || declaredParent(nested.node) !== undefined) continue
      const owners = new Set(edgePairs
        .filter((edge) => edge.target === nested.id && childOf.has(edge.source))
        .map((edge) => childOf.get(edge.source)))
      if (owners.size !== 1) continue
      const owner = [...owners][0]
      let ancestor = owner
      const seen = new Set()
      while (ancestor !== undefined && ancestor !== nested.id && !seen.has(ancestor)) {
        seen.add(ancestor)
        ancestor = childOf.get(ancestor)
      }
      if (ancestor !== undefined) continue
      containers.get(owner).children.push(nested.node)
      childOf.set(nested.id, owner)
      inferredParent = true
    }
  } while (inferredParent)

  for (const container of containers.values()) {
    const childIds = new Set(container.children.map((child) => child.id))
    container.innerEdges = edgePairs.filter((edge) => childIds.has(edge.source) && childIds.has(edge.target))
    const marker = container.children.find((child) => child.kind === `${container.kind}-start`)
    if (container.startId === undefined) container.startId = marker?.id ?? container.children[0]?.id
    const endMarker = container.children.find((child) => child.kind === `${container.kind}-end`)
    container.endId = endMarker?.id
    if (container.children.length === 0) {
      const message = `container ${container.id} (${container.kind}) has no child nodes associated by parentId/iteration_id/loop_id`
      warnings.push(message)
      diagnostics.note(container.id, message)
    }
    if (container.startId !== undefined && !childIds.has(container.startId)) {
      const message = `container ${container.id} start_node_id ${container.startId} is not one of its children`
      warnings.push(message)
      diagnostics.note(container.id, message)
    }
  }

  const isInner = (id) => childOf.has(id)
  const topNodes = nodes.filter((node) => !isInner(node.id))
  const topIds = new Set(topNodes.map((node) => node.id))
  const topEdges = edgePairs.filter((edge) => topIds.has(edge.source) && topIds.has(edge.target))

  // Entry: exactly one start, else one trigger-ish node, else the first
  // disconnected executable node (reported as an issue by inspection).
  const starts = topNodes.filter((node) => node.kind === 'start')
  const triggers = topNodes.filter((node) => TRIGGER_KINDS.has(node.kind))
  const entry = starts[0] ?? triggers[0]
  const entryId = entry?.id
  const entryKind = entry?.kind

  const start = starts[0]
  const startVariables = (start?.data?.variables ?? []).filter((v) => v?.variable)
  const startInputs = startVariables.map((v) => v.variable)
  const requiredInputs = startVariables.filter((v) => v.required !== false).map((v) => v.variable)

  return {
    appName: parsed.appName,
    mode: parsed.mode,
    nodes,
    byId,
    edges: edgePairs,
    topNodes,
    topEdges,
    containers,
    entryId,
    entryKind,
    startId: start?.id,
    startInputs,
    requiredInputs,
    unknownKinds: [...new Set(nodes.filter((n) => n.kind === 'generic').map((n) => n.rawType))],
    warnings,
    diagnostics: diagnostics.list(),
    diagnosticCodes: diagnostics.codes(),
  }
}

/** Incoming/outgoing adjacency for a node id set + edge list. */
function adjacency(ids, edges) {
  const idSet = new Set(ids)
  const incoming = new Map()
  const outgoing = new Map()
  for (const id of idSet) {
    incoming.set(id, [])
    outgoing.set(id, [])
  }
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue
    outgoing.get(edge.source).push({ target: edge.target, handle: edge.handle })
    incoming.get(edge.target).push({ source: edge.source, handle: edge.handle })
  }
  return { incoming, outgoing }
}

/** Kahn order over an explicit node set, preferring the DSL's own node order. */
function orderNodes(nodes, edges, preferredIndex) {
  const ids = nodes.map((node) => node.id)
  const { incoming, outgoing } = adjacency(ids, edges)
  const indegree = new Map([...incoming].map(([id, list]) => [id, list.length]))
  const ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => preferredIndex(a) - preferredIndex(b))
  const order = []
  while (ready.length > 0) {
    const id = ready.shift()
    order.push(id)
    for (const { target } of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) {
        ready.push(target)
        ready.sort((a, b) => preferredIndex(a) - preferredIndex(b))
      }
    }
  }
  if (order.length !== ids.length) {
    const placed = new Set(order)
    const stranded = ids.filter((id) => !placed.has(id))
    throw new Error(`graph has a cycle or unreachable nodes: ${stranded.join(', ')}`)
  }
  return order
}

/** Allowed outgoing edge handles for one source node, per Dify's branch contract. */
function allowedHandles(node) {
  const kind = node.kind
  const data = node.data ?? {}
  if (kind === 'if-else') return new Set([...new Set((data.cases ?? []).map((c) => String(c.case_id ?? ''))), 'false'])
  if (kind === 'question-classifier') return new Set((data.classes ?? []).map((c) => String(c.id ?? c.name ?? '')))
  if (kind === 'http-request') {
    return String(data.error_strategy ?? 'none') === 'fail-branch' ? new Set(['success-branch', 'fail-branch']) : new Set(['source'])
  }
  if (kind === 'human-input') {
    const actions = new Set((data.user_actions ?? []).map((action) => String(action.id ?? '')).filter(Boolean))
    actions.add('__timeout')
    return actions
  }
  return new Set(['source'])
}

/** Normalize Dify's header shape (`"K: V"` text or `[{key,value}]`) into pairs. */
function headerPairs(headers) {
  if (Array.isArray(headers)) {
    return headers
      .filter((item) => item != null && item.key != null && String(item.key).length > 0)
      .map((item) => ({ key: String(item.key), value: item.value ?? '' }))
  }
  if (typeof headers === 'string') {
    return headers
      .split(/\r?\n/)
      .map((line) => {
        const colon = line.indexOf(':')
        if (colon <= 0) return undefined
        return { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }
      })
      .filter(Boolean)
  }
  return []
}

/** Normalize Dify's query-parameter shape (`"k=v"` text or `[{key,value}]`). */
function paramPairs(params) {
  if (Array.isArray(params)) {
    return params
      .filter((item) => item != null && item.key != null && String(item.key).length > 0)
      .map((item) => ({ key: String(item.key), value: item.value ?? '' }))
  }
  if (typeof params === 'string') {
    return params
      .split(/\r?\n/)
      .map((line) => {
        const eq = line.indexOf('=')
        if (eq <= 0) return undefined
        return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() }
      })
      .filter(Boolean)
  }
  return []
}

/** One HTTP body data item → a JS expression for its value. */
function bodyValueExpr(item, scope) {
  const value = item?.value
  if (item?.type === 'variable' && Array.isArray(value)) return selectorExpr(value, scope)
  if (typeof value === 'string') return renderTextExpr(value, scope)
  if (value === undefined) return '""'
  return JSON.stringify(value)
}

/** Compile a Dify `body` block into a concrete JS object expression. */
function bodyExpr(body, scope) {
  const type = String(body?.type ?? 'none')
  if (type === 'none') return `{type:'none'}`
  if (type === 'json') {
    if (Array.isArray(body.data)) {
      const items = body.data
        .filter((item) => item != null && item.key != null && String(item.key).length > 0)
        .map((item) => `{key:${JSON.stringify(String(item.key))}, value:${bodyValueExpr(item, scope)}}`)
      return `{type:'json', data:[${items.join(', ')}]}`
    }
    if (typeof body.data === 'string') return `{type:'json', raw:${renderTextExpr(body.data, scope)}}`
    return `{type:'json', value:${JSON.stringify(body.data ?? {})}}`
  }
  if (type === 'raw-text') return `{type:'raw-text', data:${renderTextExpr(String(body.data ?? ''), scope)}}`
  if (type === 'x-www-form-urlencoded') {
    const items = (Array.isArray(body.data) ? body.data : [])
      .filter((item) => item != null && item.key != null && String(item.key).length > 0)
      .map((item) => `{key:${JSON.stringify(String(item.key))}, value:${bodyValueExpr(item, scope)}}`)
    return `{type:'x-www-form-urlencoded', data:[${items.join(', ')}]}`
  }
  throw new Error(`unsupported http-request body type "${type}" (supported: none, json, raw-text, x-www-form-urlencoded)`)
}

/** Dify's HTTP node timeout is seconds; pick the largest non-zero phase budget. */
function httpTimeoutMs(data) {
  const timeout = data?.timeout
  if (typeof timeout === 'number' && timeout > 0) return Math.round(timeout * 1000)
  if (timeout != null && typeof timeout === 'object') {
    const seconds = ['max_connect_timeout', 'max_read_timeout', 'max_write_timeout']
      .map((key) => Number(timeout[key]) || 0)
      .filter((value) => value > 0)
    if (seconds.length > 0) return Math.round(Math.max(...seconds) * 1000)
  }
  return 30_000
}

/** Normalize both Dify assigner shapes (v1 single target, v2 `items[]`). */
function assignerItems(data) {
  if (Array.isArray(data.items) && data.items.length > 0) return data.items
  if (Array.isArray(data.assigned_variable_selector) && data.assigned_variable_selector.length > 0) {
    const input = data.input_variable_selector
    return [
      {
        variable_selector: data.assigned_variable_selector,
        input_type: Array.isArray(input) ? 'variable' : 'constant',
        value: Array.isArray(input) ? input : data.value,
        operation: data.write_mode ?? data.operation ?? 'over-write',
      },
    ]
  }
  return []
}

/** A Dify "typed value" (`{type, value}` or a plain literal) → JS expression. */
function difyValueExpr(raw, scope) {
  if (raw != null && typeof raw === 'object' && 'value' in raw && ('type' in raw || 'selector' in raw)) {
    const value = raw.value
    if (raw.type === 'variable' && Array.isArray(value)) return selectorExpr(value, scope)
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string')) {
      // Newer exports encode a selector as a bare 2-string array with
      // `type: variable`; older ones omit the type.
      return selectorExpr(value, scope)
    }
    if (raw.selector !== undefined && Array.isArray(raw.selector) && raw.selector.length === 2) {
      return selectorExpr(raw.selector, scope)
    }
    if (typeof value === 'string') return renderTextExpr(value, scope)
    return JSON.stringify(value ?? '')
  }
  if (typeof raw === 'string') return renderTextExpr(raw, scope)
  return JSON.stringify(raw ?? '')
}

/** Build a concrete JS object expression for a Dify tool node's parameters. */
function toolArgumentsExpr(parameters, scope) {
  const entries = []
  for (const [key, raw] of Object.entries(parameters ?? {})) {
    entries.push(`${JSON.stringify(key)}: ${difyValueExpr(raw, scope)}`)
  }
  return `{${entries.join(', ')}}`
}

/** Build a concrete JS object expression for datasource / plugin parameters. */
function parameterObjectExpr(parameters, scope) {
  const entries = []
  for (const [key, raw] of Object.entries(parameters ?? {})) {
    entries.push(`${JSON.stringify(key)}: ${difyValueExpr(raw, scope)}`)
  }
  return `{${entries.join(', ')}}`
}

/** The local `{{ name }}` bindings for an LLM/template/answer node. */
function localBindings(node, scope) {
  const local = new Map()
  for (const item of node.data?.variables ?? []) {
    if (item?.variable) local.set(item.variable, selectorExpr(item.value_selector, scope))
  }
  // `{{#context#}}` is Dify's reserved placeholder for a node's context block.
  const context = node.data?.context
  if (context?.enabled === true && Array.isArray(context.variable_selector)) {
    local.set('context', selectorExpr(context.variable_selector, scope))
  }
  return local
}

/** One Dify if-else condition → JS boolean expression using the script's `__cmp`. */
function conditionExpr(condition, scope) {
  const selector = condition?.variable_selector
  const left = Array.isArray(selector) ? selectorExpr(selector, scope) : 'undefined'
  return `__cmp(${left}, ${JSON.stringify(String(condition?.comparison_operator ?? '='))}, ${JSON.stringify(condition?.value ?? null)}, ${JSON.stringify(condition?.varType ?? null)})`
}

/** The agent node's strategy parameters flattened to plain values. */
function agentParameterMap(data) {
  const out = {}
  for (const [key, raw] of Object.entries(data?.agent_parameters ?? {})) {
    out[key] = raw != null && typeof raw === 'object' && 'value' in raw ? raw.value : raw
  }
  return out
}

/** Dify agent model, from either the legacy strategy params or the node block. */
function agentModel(data) {
  const params = agentParameterMap(data)
  const fromParams = params.model
  if (fromParams != null && typeof fromParams === 'object' && (fromParams.provider || fromParams.name || fromParams.model)) {
    return { provider: fromParams.provider, name: fromParams.name ?? fromParams.model, completion: fromParams.completion_params ?? {} }
  }
  const model = data?.model ?? {}
  return { provider: model.provider, name: model.name, completion: model.completion_params ?? {} }
}

/** Nodes of one unit (top level or one container body) with their own scope. */
function unitFor(nodes, edges, entryId) {
  const preferred = new Map(nodes.map((node, index) => [node.id, index]))
  return {
    nodes,
    edges,
    entryId,
    order: orderNodes(nodes, edges, (id) => preferred.get(id) ?? 0),
  }
}

/**
 * Inspect the IR without executing it: node inventory, entry inputs, container
 * map, and every structural problem that would make a deterministic run
 * impossible (or ambiguous).
 */
export function inspectIR(ir) {
  const types = {}
  for (const node of ir.nodes) types[node.kind] = (types[node.kind] ?? 0) + 1
  const issues = []
  const starts = ir.topNodes.filter((node) => node.kind === 'start')
  const entry = ir.byId.get(ir.entryId)
  if (starts.length > 1) issues.push(`expected at most one start node, found ${starts.length}`)
  if (entry === undefined) issues.push('no start node and no trigger node to enter the graph')
  const terminals = ir.topNodes.filter((node) => node.kind === 'end' || node.kind === 'answer')
  if (terminals.length === 0) issues.push('no end node and no terminal answer node')

  const topIds = new Set(ir.topNodes.map((node) => node.id))
  for (const edge of ir.edges) {
    if (!ir.byId.has(edge.source) || !ir.byId.has(edge.target)) {
      issues.push(`edge ${edge.id} references an unknown node`)
      continue
    }
    // Container ↔ child edges belong to the container body, not the main DAG.
    if (!topIds.has(edge.source) || !topIds.has(edge.target)) continue
    const source = ir.byId.get(edge.source)
    const allowed = allowedHandles(source)
    if (!allowed.has(edge.handle)) {
      issues.push(`edge ${edge.id} leaves ${edge.source} (${source.kind}) on handle "${edge.handle}"; allowed: ${[...allowed].join(', ') || '(none)'}`)
    }
    if (source.kind === 'question-classifier') {
      const ids = (source.data.classes ?? []).map((c) => String(c.id ?? c.name ?? ''))
      if (new Set(ids).size !== ids.length) issues.push(`question-classifier ${edge.source} has duplicate class ids`)
    }
  }

  const { outgoing } = adjacency([...topIds], ir.topEdges)
  for (const node of ir.topNodes) {
    const outs = outgoing.get(node.id) ?? []
    if (node.kind === 'end' || node.kind === 'answer' || node.kind === 'note') continue
    if (BRANCH_KINDS.has(node.kind)) {
      const handles = outs.map((item) => item.handle)
      if (new Set(handles).size !== handles.length) issues.push(`${node.kind} ${node.id} has duplicate branch edges`)
      continue
    }
    // Non-branch fan-out is legal in Dify (parallel arms). The compiled model
    // runs each arm in topological order behind its own `__ran[source]` guard,
    // so the schedule stays dataflow-driven; no edge is guessed.
    if (outs.length === 0 && !NON_EXECUTABLE_KINDS.has(node.kind)) {
      issues.push(`node ${node.id} (${node.kind}) has no outgoing edge and is not a terminal node`)
    }
  }

  for (const container of ir.containers.values()) {
    if (container.children.length > 0) {
      try {
        orderNodes(container.children, container.innerEdges, () => 0)
      } catch (error) {
        issues.push(`container ${container.id}: ${error.message}`)
      }
    }
  }
  try {
    orderNodes(ir.topNodes, ir.topEdges, () => 0)
  } catch (error) {
    issues.push(error.message)
  }

  if (entry !== undefined && !NON_EXECUTABLE_KINDS.has(entry.kind)) {
    const reachable = new Set()
    const queue = [entry.id]
    while (queue.length > 0) {
      const id = queue.shift()
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const item of outgoing.get(id) ?? []) queue.push(item.target)
    }
    for (const node of ir.topNodes) {
      if (NON_EXECUTABLE_KINDS.has(node.kind)) continue
      if (!reachable.has(node.id)) issues.push(`node ${node.id} (${node.kind}) is not reachable from the entry node`)
    }
  }

  return {
    nodeCount: ir.nodes.length,
    nodeTypes: types,
    startInputs: ir.startInputs,
    requiredInputs: ir.requiredInputs,
    endOutputs: (ir.topNodes.find((node) => node.kind === 'end')?.data?.outputs ?? []).map((out) => out.variable).filter(Boolean),
    answerCount: ir.topNodes.filter((node) => node.kind === 'answer').length,
    entry: entry === undefined ? null : { id: entry.id, kind: entry.kind },
    containers: [...ir.containers.values()].map((container) => ({
      id: container.id,
      kind: container.kind,
      startId: container.startId ?? null,
      endId: container.endId ?? null,
      children: container.children.map((child) => child.id),
    })),
    // Per-node support level, so a caller can see at a glance which nodes run
    // with their full Dify semantics and which are simplified / placeholders.
    support: nodeSupport(ir),
    unknownKinds: ir.unknownKinds,
    // Kept for callers/tests from earlier rounds: complete coverage means this
    // list is always empty; unknown future types are visible in `unknownKinds`.
    unsupported: [],
    issues,
    warnings: ir.warnings,
    // Structured sibling of `warnings`: { severity, code, subject, message }.
    // For engineers; never surfaced to an end user as an error.
    diagnostics: ir.diagnostics ?? [],
    diagnosticCodes: ir.diagnosticCodes ?? {},
    nodeIds: ir.nodes.map((node) => node.id),
  }
}

/**
 * Support level of every node that does work, for `dify_native_inspect`.
 * `full` means the node implements the Dify surface this runtime targets;
 * `simplified` means a documented subset; `placeholder` means it is scheduled
 * but does not perform the node's work; `passthrough` means unknown type.
 */
function nodeSupport(ir) {
  const rows = []
  for (const node of ir.nodes) {
    if (MARKER_KINDS.has(node.kind) || node.kind === 'start' || node.kind === 'end' || node.kind === 'note') continue
    let mode = 'full'
    let reason = ''
    if (node.kind === 'generic') {
      mode = 'passthrough'
      reason = 'unknown node type'
    } else if (node.kind === 'knowledge-index') {
      mode = 'placeholder'
      reason = 'no vector store mounted; nothing is written'
    } else if (node.kind === 'knowledge-retrieval') {
      mode = 'simplified'
      reason = 'lexical grep over local files, not embedding retrieval'
    } else if (node.kind === 'agent') {
      mode = 'simplified'
      reason = 'single model turn; declared tools are not executed'
    } else if (node.kind === 'document-extractor') {
      mode = 'simplified'
      reason = 'text-like files only (no PDF/office extraction)'
    } else if (node.kind === 'human-input') {
      mode = 'simplified'
      reason = 'resolved from run args / first declared action; no pause/resume'
    } else if (node.kind === 'datasource') {
      mode = 'simplified'
      reason = 'local JSON/JSONL/text file only, not a Dify datasource plugin'
    }
    // A dropped field on an otherwise-full node is still a partial implementation.
    // Diagnostic subjects are `"<nodeId>:<field>"` for field drops and the bare
    // node id for node-level ones, so match on the prefix.
    if (reason.length === 0 && (ir.diagnostics ?? []).some((row) => row.code === 'field-dropped' && row.subject.split(':')[0] === node.id)) {
      mode = 'simplified'
      reason = 'some declared fields were dropped'
    }
    // An invalid Jinja2 template is worse than a dropped field: the node is
    // reached and fails. Report it ahead of the generic drop reason.
    if ((ir.diagnostics ?? []).some((row) => row.code === 'template-jinja-invalid' && row.subject.split(':')[0] === node.id)) {
      mode = 'simplified'
      reason = 'Jinja2 template does not compile; the node fails when reached'
    }
    rows.push({ id: node.id, kind: node.kind, mode, ...(reason.length > 0 ? { reason } : {}) })
  }
  return rows
}

/** Inspect a parsed DSL (convenience wrapper around {@link buildIR}). */
export function inspectGraph(parsed) {
  return inspectIR(buildIR(parsed))
}

/**
 * Compile the IR into a workflow-engine script.
 *
 * The emitted script uses the engine's documented globals (`agent`, `parallel`,
 * `phase`, `args`). Host nodes become one `agent()` call whose prompt is a JSON
 * request for the `dify-node` subagent provider. Aggregator / template /
 * assigner / answer / list-operator / trigger compile to plain JS, and
 * iteration/loop bodies compile to ordinary control flow (or `parallel` for
 * `is_parallel: true`), so loop bounds and item order are code.
 *
 * @param parsed - result of {@link parseDifyDsl}.
 * @param options - `name` used in the workflow meta, per-node timeout.
 * @returns the script, meta, execution order, and bound end outputs.
 * @throws when the graph is structurally ambiguous or a node config is invalid.
 */
export function compileGraph(parsed, options = {}) {
  const ir = buildIR(parsed)
  const inspection = inspectIR(ir)
  if (inspection.issues.length > 0) throw new Error(inspection.issues.join('; '))
  if (ir.entryId === undefined) throw new Error('no entry node')

  const preferredIndex = new Map(ir.nodes.map((node, index) => [node.id, index]))
  const varByNode = new Map()
  const nodeMeta = []
  const lines = []
  const counters = { call: 0, container: 0, var: 0 }

  const allocate = (id) => {
    const name = `__r${counters.var}`
    counters.var += 1
    varByNode.set(id, name)
    return name
  }
  const START_MARKERS = new Set(['iteration-start', 'loop-start'])
  // Number result variables in execution order (not DSL order) so traces and
  // generated scripts stay stable across compiler refactors.
  const topOrder = orderNodes(ir.topNodes, ir.topEdges, (id) => preferredIndex.get(id) ?? 0)
  for (const id of topOrder) {
    const node = ir.byId.get(id)
    if (node.kind === 'start' || node.kind === 'end' || START_MARKERS.has(node.kind)) continue
    allocate(node.id)
  }

  const indentOf = (level) => '  '.repeat(level)

  lines.push(`phase(${JSON.stringify(`dify:${parsed.appName || 'workflow'}`)})`)
  lines.push('const __nodes = {}')
  lines.push('const __ran = {}')
  lines.push('const __branch = {}')
  lines.push('const __answers = []')
  // Dify's `{{#context#}}` may hold retrieval segments; render them as text
  // rather than JavaScript's default `[object Object]`.
  lines.push(
    'const __text = (v) => v === undefined || v === null ? "" : Array.isArray(v) ? v.map((x) => x !== null && typeof x === "object" ? (x.content ?? JSON.stringify(x)) : String(x)).join("\\n") : typeof v === "object" ? JSON.stringify(v) : String(v)',
  )
  lines.push(
    'const __empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)',
  )
  lines.push(
    'const __num = (v) => { if (typeof v === "boolean" || v === null || v === undefined || v === "") return undefined; const n = typeof v === "number" ? v : Number(String(v).trim()); return Number.isFinite(n) ? n : undefined }',
  )
  // One deterministic comparison helper shared by if-else-style loop breaks and
  // list-operator filters (mirrors provider.js's evaluator).
  lines.push(`const __cmp = (left, op, right, varType) => {
  op = String(op ?? '=').trim()
  if (op === 'empty') return __empty(left)
  if (op === 'not empty') return !__empty(left)
  if (op === 'null') return left === undefined || left === null
  if (op === 'not null') return left !== undefined && left !== null
  const a = __num(left)
  const b = __num(right)
  if (a !== undefined && b !== undefined) {
    if (op === '=' || op === '==' || op === 'is') return a === b
    if (op === '≠' || op === '!=' || op === 'is not') return a !== b
    if (op === '>') return a > b
    if (op === '<') return a < b
    if (op === '≥' || op === '>=') return a >= b
    if (op === '≤' || op === '<=') return a <= b
  }
  const ls = __text(left)
  const rs = __text(right)
  if (op === '=' || op === '==' || op === 'is') return ls === rs
  if (op === '≠' || op === '!=' || op === 'is not') return ls !== rs
  if (op === 'contains') return ls.includes(rs)
  if (op === 'not contains') return !ls.includes(rs)
  if (op === 'start with') return ls.startsWith(rs)
  if (op === 'end with') return ls.endsWith(rs)
  if (op === 'in') return (Array.isArray(right) ? right : [right]).map(__text).includes(ls)
  if (op === 'not in') return !(Array.isArray(right) ? right : [right]).map(__text).includes(ls)
  return false
}`)
  const conversation = Object.fromEntries(
    (parsed.conversationVariables ?? []).filter((v) => v?.name).map((v) => [String(v.name), v.value ?? '']),
  )
  const environment = Object.fromEntries(
    (parsed.environmentVariables ?? []).filter((v) => v?.name).map((v) => [String(v.name), v.value ?? '']),
  )
  lines.push(`const __vars = ${JSON.stringify({ conversation, environment })}`)
  // Dify system variables. `conversation_id` / `dialogue_count` are injected by
  // the run as `args['sys.*']` from the calling harness session (see
  // `systemVariables` in index.js); when absent they stay undefined, which the
  // empty-string defaults below absorb.
  lines.push(
    `__vars.sys = { query: args['sys.query'] ?? '', files: args['sys.files'] ?? [], user_id: args['sys.user_id'] ?? '', app_id: args['sys.app_id'] ?? '', workflow_id: args['sys.workflow_id'] ?? '', conversation_id: args['sys.conversation_id'] ?? '', dialogue_count: args['sys.dialogue_count'] ?? 0, workflow_run_id: args['sys.workflow_run_id'] ?? '', timestamp: args['sys.timestamp'] ?? 0 }`,
  )
  // `entity` is what Dify calls the item of a list-operator / iteration body in
  // some exports; keep the common ones resolvable.
  if (counters.var > 0) lines.push(`let ${[...varByNode.values()].join(', ')}`)
  // Jinja2 rendering for template-transform. The engine's script VM exposes no
  // host function, so it goes through `agent()` like every other node and is
  // performed by the `dify-node` provider (nunjucks lives on the JS side).
  // An invalid template is the author's error and fails the node — never
  // silently fall back to the raw template text.
  lines.push(`const __jinja = async (template, context, nodeId, title) => {
  const req = { kind: 'template-transform', nodeId, title, template, context }
  const raw = await agent(JSON.stringify(req), { label: 'template-transform:' + (title || nodeId) })
  if (raw === null) throw new Error('dify node ' + nodeId + ' (template-transform) failed: no result from provider')
  const res = JSON.parse(raw)
  if (!res.ok) throw new Error('dify node ' + nodeId + ' (template-transform:' + (title || '') + ') failed: ' + (res.error ?? 'unknown error'))
  return res.outputs
}`)

  const scope = {
    startId: ir.startId,
    varByNode,
    locals: new Map(),
    ran: '__ran',
    branch: '__branch',
    nodes: '__nodes',
    indent: 0,
  }

  /** Guard expression for a node, from the incoming edges of its unit. */
  const guardFor = (node, unit, incoming) => {
    if (node.id === unit.entryId) return 'true'
    const ins = incoming.get(node.id) ?? []
    if (ins.length === 0) {
      if (NON_EXECUTABLE_KINDS.has(node.kind) || node.kind === 'trigger' || node.kind.startsWith('trigger-')) return 'true'
      throw new Error(`node ${node.id} (${node.kind}) is not reachable from the entry node`)
    }
    return ins
      .map(({ source, handle }) => {
        const sourceNode = ir.byId.get(source)
        const kind = sourceNode?.kind ?? 'generic'
        if (BRANCH_KINDS.has(kind)) {
          return `(${scope.ran}[${JSON.stringify(source)}] === true && ${scope.branch}[${JSON.stringify(source)}] === ${JSON.stringify(handle)})`
        }
        if (MARKER_KINDS.has(kind)) return `(${scope.ran}[${JSON.stringify(source)}] === true)`
        return `(${scope.ran}[${JSON.stringify(source)}] === true)`
      })
      .join(' || ')
  }

  /** Emit one host-node request + agent() call. */
  const emitHost = (node, unit, guard, level) => {
    const data = node.data ?? {}
    const kind = node.kind
    const pad = indentOf(level)
    const spec = {
      kind,
      nodeId: node.id,
      title: node.title,
      timeoutMs: options.nodeTimeoutMs ?? 120_000,
      inputs: {},
    }
    const variable = scope.varByNode.get(node.id)
    const inputs = {}
    if (kind === 'code') {
      for (const item of data.variables ?? []) {
        if (item?.variable) inputs[item.variable] = selectorExpr(item.value_selector, scope)
      }
      spec.codeLanguage = data.code_language ?? 'python3'
      spec.code = data.code ?? ''
      spec.outputs = data.outputs ?? {}
      // Dify lets a code node declare extra Python packages it imports. The
      // compiler only forwards the declaration; the provider resolves it.
      if (Array.isArray(data.dependencies) && data.dependencies.length > 0) {
        spec.dependencies = data.dependencies.map((item) => String(item))
      }
    } else if (kind === 'if-else') {
      for (const item of data.cases ?? []) {
        for (const condition of item.conditions ?? []) {
          if (condition?.variable_selector?.[1] !== undefined) {
            // Key by node id as well: two conditions may read same-named outputs.
            const key = `${condition.variable_selector[0]}.${condition.variable_selector[1]}`
            inputs[key] = selectorExpr(condition.variable_selector, scope)
          }
        }
      }
      spec.cases = (data.cases ?? []).map((item) => ({
        case_id: String(item.case_id ?? ''),
        logical_operator: item.logical_operator ?? data.logical_operator ?? 'and',
        conditions: (item.conditions ?? []).map((condition) => ({
          comparison_operator: condition.comparison_operator,
          value: condition.value,
          varType: condition.varType,
          variable_selector: condition.variable_selector,
        })),
      }))
      spec.logical_operator = data.logical_operator ?? 'and'
    } else if (kind === 'llm') {
      const model = data.model ?? {}
      const params = model.completion_params ?? {}
      spec.provider = model.provider
      spec.model = model.name
      if (typeof params.temperature === 'number') spec.temperature = params.temperature
      if (typeof params.max_tokens === 'number') spec.maxTokens = params.max_tokens
      spec.prompt = (data.prompt_template ?? []).map((item) => ({
        role: item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user',
        text: '',
      }))
      // Memory is fed from the harness session log at execution time; only the
      // node's declaration travels in the spec.
      if (data.memory !== null && typeof data.memory === 'object') spec.memory = data.memory
      // Dify `structured_output`: when enabled, the node promises its `text`
      // output is a JSON value conforming to `structured_output.schema`. The
      // host `ctx.llm` exposes no response_format, so the provider enforces the
      // contract itself (prompt constraint + schema validation + one repair).
      if (data.structured_output_enabled === true && data.structured_output?.schema !== undefined) {
        spec.structuredOutput = { enabled: true, schema: data.structured_output.schema }
      }
    } else if (kind === 'question-classifier') {
      const model = data.model ?? {}
      const params = model.completion_params ?? {}
      spec.classes = (data.classes ?? []).map((item) => ({
        id: String(item.id ?? item.name ?? ''),
        name: String(item.name ?? ''),
      }))
      spec.instruction = String(data.instruction ?? '')
      spec.provider = model.provider
      spec.model = model.name
      spec.temperature = typeof params.temperature === 'number' ? params.temperature : 0
      spec.maxTokens = 128
    } else if (kind === 'http-request') {
      spec.method = String(data.method ?? 'get').toUpperCase()
      spec.errorStrategy = String(data.error_strategy ?? 'none')
      spec.timeoutMs = httpTimeoutMs(data)
      spec.headers = []
      spec.params = []
      spec.body = { type: 'none' }
      const auth = data.authorization ?? {}
      const authType = String(auth.type ?? 'no-auth')
      spec.authorization = { type: authType }
      if (authType === 'api-key') {
        const cfg = auth.config ?? {}
        spec.authorization.config = {
          type: String(cfg.type ?? 'bearer'),
          header: String(cfg.header ?? 'Authorization'),
          api_key: '',
        }
      }
      const defaults = data.default_value
      if (Array.isArray(defaults)) {
        spec.defaultValue = Object.fromEntries(
          defaults.filter((item) => item != null && item.key != null).map((item) => [String(item.key), item.value ?? '']),
        )
      } else if (defaults != null && typeof defaults === 'object') {
        spec.defaultValue = defaults
      }
    } else if (kind === 'tool') {
      spec.provider = data.provider_name ?? data.provider_id ?? ''
      spec.providerType = data.provider_type ?? ''
      spec.toolName = String(data.tool_name ?? '')
      spec.toolLabel = String(data.tool_label ?? '')
    } else if (kind === 'knowledge-retrieval') {
      const setting = data.retrieval_setting ?? data.single_retrieval_config ?? data.multiple_retrieval_config ?? {}
      spec.datasetIds = (data.dataset_ids ?? []).map(String)
      spec.topK = Number(setting.top_k ?? 4)
      spec.scoreThreshold = Number(setting.score_threshold ?? 0)
    } else if (kind === 'knowledge-index') {
      spec.datasetId = String(data.dataset_id ?? '')
      spec.keywordNumber = Number(data.keyword_number ?? 10)
    } else if (kind === 'agent') {
      const params = agentParameterMap(data)
      const model = agentModel(data)
      spec.provider = model.provider
      spec.model = model.name
      const completion = model.completion ?? {}
      if (typeof completion.temperature === 'number') spec.temperature = completion.temperature
      if (typeof completion.max_tokens === 'number') spec.maxTokens = completion.max_tokens
      spec.strategy = String(data.agent_strategy_name ?? data.agent_node_kind ?? '')
      spec.strategyLabel = String(data.agent_strategy_label ?? '')
      spec.agentVersion = String(data.version ?? '1')
      spec.instruction = ''
      spec.query = ''
      spec.tools = Array.isArray(params.tools)
        ? params.tools.map((tool) => String(tool?.name ?? tool?.tool_name ?? tool?.provider_name ?? tool ?? ''))
        : []
      spec.toolsPolicy = { requested: spec.tools, mode: 'parsed, no tool loop in single-turn execution' }
      spec.outputSchema = data.output_schema ?? null
      spec.declaredOutputs = (data.agent_job?.declared_outputs ?? []).map((item) =>
        typeof item === 'string' ? item : String(item?.name ?? item?.variable ?? ''),
      ).filter(Boolean)
    } else if (kind === 'parameter-extractor') {
      const model = data.model ?? {}
      spec.provider = model.provider
      spec.model = model.name
      spec.temperature = typeof model.completion_params?.temperature === 'number' ? model.completion_params.temperature : 0.1
      if (typeof model.completion_params?.max_tokens === 'number') spec.maxTokens = model.completion_params.max_tokens
      spec.instruction = String(data.instruction ?? '')
      spec.reasoningMode = String(data.reasoning_mode ?? 'prompt')
      spec.parameters = (data.parameters ?? []).map((item) => ({
        name: String(item.name ?? ''),
        type: String(item.type ?? 'string'),
        description: String(item.description ?? ''),
        required: item.required === true,
        options: Array.isArray(item.options) ? item.options : undefined,
      })).filter((item) => item.name.length > 0)
      spec.query = ''
    } else if (kind === 'document-extractor') {
      spec.arrayFile = data.is_array_file !== false
    } else if (kind === 'datasource') {
      spec.provider = String(data.provider_name ?? data.provider_id ?? '')
      spec.providerType = String(data.provider_type ?? '')
      spec.datasourceName = String(data.datasource_name ?? '')
      spec.datasourceLabel = String(data.datasource_label ?? '')
      spec.parameters = {}
    } else if (kind === 'human-input') {
      spec.actions = (data.user_actions ?? []).map((action) => ({ id: String(action.id ?? ''), title: String(action.title ?? '') }))
      spec.formContent = String(data.form_content ?? '')
      spec.formInputs = (data.inputs ?? []).map((input) => ({
        name: String(input.output_variable_name ?? ''),
        type: String(input.type ?? 'paragraph'),
        default: input.default ?? null,
      }))
      spec.timeout = data.timeout
      spec.timeoutUnit = data.timeout_unit
    }

    const label = `${kind}:${node.title || node.id}`
    const reqVar = `__req${counters.call}`
    const inVar = `__in${counters.call}`
    lines.push(`${pad}if (${guard}) {`)
    const env = Object.keys(inputs).map((key) => `${JSON.stringify(key)}: ${inputs[key]}`)
    lines.push(`${pad}  const ${inVar} = {${env.join(', ')}}`)
    lines.push(`${pad}  const ${reqVar} = ${JSON.stringify(spec)}`)
    lines.push(`${pad}  ${reqVar}.inputs = ${inVar}`)
    if (kind === 'llm') {
      ;(data.prompt_template ?? []).forEach((item, promptIndex) => {
        const expr = renderTextExpr(String(item.text ?? ''), scope, localBindings(node, scope))
        lines.push(`${pad}  ${reqVar}.prompt[${promptIndex}].text = ${expr}`)
      })
    }
    if (kind === 'question-classifier') {
      lines.push(`${pad}  ${reqVar}.query = ${selectorExpr(data.query_variable_selector, scope)}`)
    }
    if (kind === 'http-request') {
      lines.push(`${pad}  ${reqVar}.url = ${renderTextExpr(String(data.url ?? ''), scope)}`)
      const headers = headerPairs(data.headers).map(
        (item) => `[${JSON.stringify(item.key)}, ${renderTextExpr(String(item.value), scope)}]`,
      )
      lines.push(`${pad}  ${reqVar}.headers = [${headers.join(', ')}]`)
      const params = paramPairs(data.params).map(
        (item) => `[${JSON.stringify(item.key)}, ${renderTextExpr(String(item.value), scope)}]`,
      )
      lines.push(`${pad}  ${reqVar}.params = [${params.join(', ')}]`)
      lines.push(`${pad}  ${reqVar}.body = ${bodyExpr(data.body, scope)}`)
      if (spec.authorization?.type === 'api-key') {
        const cfg = data.authorization?.config ?? {}
        const keyExpr = Array.isArray(cfg.api_key)
          ? selectorExpr(cfg.api_key, scope)
          : renderTextExpr(String(cfg.api_key ?? ''), scope)
        lines.push(`${pad}  ${reqVar}.authorization.config.api_key = ${keyExpr}`)
      }
    }
    if (kind === 'tool') {
      lines.push(`${pad}  ${reqVar}.arguments = ${toolArgumentsExpr(data.tool_parameters, scope)}`)
      // `tool_configurations` is the user-configured half of a tool call (API
      // keys, per-provider settings). Dify keeps it separate from the per-call
      // `tool_parameters`; both are forwarded now.
      if (data.tool_configurations !== null && typeof data.tool_configurations === 'object') {
        lines.push(`${pad}  ${reqVar}.configurations = ${parameterObjectExpr(data.tool_configurations, scope)}`)
      }
    }
    if (kind === 'knowledge-retrieval') {
      lines.push(`${pad}  ${reqVar}.query = ${selectorExpr(data.query_variable_selector, scope)}`)
    }
    if (kind === 'knowledge-index') {
      lines.push(`${pad}  ${reqVar}.chunk = ${selectorExpr(data.index_chunk_variable_selector, scope)}`)
    }
    if (kind === 'agent') {
      const data2 = node.data ?? {}
      const params = agentParameterMap(data2)
      const instruction =
        data2.agent_job?.workflow_prompt ?? params.instruction ?? data2.instruction ?? ''
      const query = params.query ?? data2.query ?? ''
      lines.push(`${pad}  ${reqVar}.instruction = ${typeof instruction === 'string' ? renderTextExpr(instruction, scope) : '""'}`)
      lines.push(`${pad}  ${reqVar}.query = ${typeof query === 'string' ? renderTextExpr(query, scope) : '""'}`)
    }
    if (kind === 'parameter-extractor') {
      const query = data.query ?? data.query_variable_selector
      const expr = Array.isArray(query) ? selectorExpr(query, scope) : renderTextExpr(String(query ?? ''), scope)
      lines.push(`${pad}  ${reqVar}.query = ${expr}`)
    }
    if (kind === 'document-extractor') {
      lines.push(`${pad}  ${reqVar}.files = ${selectorExpr(data.variable_selector, scope)}`)
    }
    if (kind === 'datasource') {
      lines.push(`${pad}  ${reqVar}.parameters = ${parameterObjectExpr(data.datasource_parameters, scope)}`)
    }
    if (kind === 'human-input') {
      // A synchronous run resolves the human step from the run args, then from
      // the node's declared defaults; the resolved action names the edge.
      const argsLookup = (name) => `(args[${JSON.stringify(`human.${node.id}.${name}`)}] ?? args[${JSON.stringify(name)}])`
      lines.push(`${pad}  ${reqVar}.autoAction = ${argsLookup('action')}`)
    }

    lines.push(`${pad}  const __raw${counters.call} = await agent(JSON.stringify(${reqVar}), { label: ${JSON.stringify(label)} })`)
    lines.push(`${pad}  if (__raw${counters.call} === null) throw new Error('dify node ${node.id} (${label}) failed: no result from provider')`)
    lines.push(`${pad}  ${variable} = JSON.parse(__raw${counters.call})`)
    lines.push(`${pad}  if (!${variable}.ok) throw new Error('dify node ${node.id} (${label}) failed: ' + (${variable}.error ?? 'unknown error'))`)
    lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
    if (kind === 'if-else') lines.push(`${pad}  ${scope.branch}[${JSON.stringify(node.id)}] = String(${variable}.outputs.result)`)
    if (kind === 'question-classifier') lines.push(`${pad}  ${scope.branch}[${JSON.stringify(node.id)}] = String(${variable}.outputs.class_id)`)
    if (kind === 'http-request' && String(data.error_strategy ?? 'none') === 'fail-branch') {
      lines.push(`${pad}  ${scope.branch}[${JSON.stringify(node.id)}] = String(${variable}.branch ?? 'success-branch')`)
    }
    if (kind === 'human-input') {
      lines.push(`${pad}  ${scope.branch}[${JSON.stringify(node.id)}] = String(${variable}.branch ?? ${JSON.stringify(String((data.user_actions ?? [])[0]?.id ?? ''))})`)
    }
    lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
    lines.push(`${pad}}`)
    counters.call += 1
  }

  /** Emit a pure-JS node (no agent call). */
  const emitPure = (node, unit, guard, level) => {
    const data = node.data ?? {}
    const kind = node.kind
    const pad = indentOf(level)
    const variable = scope.varByNode.get(node.id)
    const source = unit.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)
    const sourceValue = (index = 0) => {
      const id = source[index]
      const binding = id === undefined ? undefined : scope.varByNode.get(id)
      return binding === undefined ? 'undefined' : `${binding}?.outputs`
    }
    if (kind === 'note') {
      lines.push(`${pad}${scope.nodes}[${JSON.stringify(node.id)}] = { ok: true, kind: 'note', title: ${JSON.stringify(node.title)}, outputs: {} }`)
      lines.push(`${pad}${scope.ran}[${JSON.stringify(node.id)}] = true`)
      return
    }
    if (kind === 'trigger' || kind.startsWith('trigger-') || kind === 'datasource') {
      // Trigger/datasource entry: expose declared variables from run args, then
      // the node's declared defaults. No external event source is invented.
      const declared = Array.isArray(data.variables) ? data.variables : []
      const fields = declared.map((item) => ({
        name: String(item.variable ?? item.name ?? ''),
        selector: item.value_selector,
      })).filter((item) => item.name.length > 0)
      const entries = fields.map((item) => {
        const declaredDefault = data[item.name]?.value ?? item.default ?? null
        return `${JSON.stringify(item.name)}: (args[${JSON.stringify(item.name)}] ?? ${JSON.stringify(declaredDefault)})`
      })
      if (kind === 'trigger-schedule') {
        entries.push(`triggered_at: new Date(0).toISOString()`)
        entries.push(`mode: ${JSON.stringify(String(data.mode ?? 'visual'))}`)
        entries.push(`frequency: ${JSON.stringify(String(data.frequency ?? ''))}`)
      }
      if (kind === 'trigger-webhook') {
        entries.push(`method: ${JSON.stringify(String(data.method ?? 'POST'))}`)
        entries.push(`body: (args['trigger.body'] ?? null)`)
      }
      if (kind === 'trigger-plugin') {
        entries.push(`event_name: ${JSON.stringify(String(data.event_name ?? ''))}`)
      }
      if (kind === 'datasource') {
        entries.push(`datasource: ${JSON.stringify(String(data.datasource_name ?? ''))}`)
      }
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  ${variable} = { ok: true, kind: ${JSON.stringify(kind)}, title: ${JSON.stringify(node.title)}, outputs: {${entries.join(', ')}} }`)
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (MARKER_KINDS.has(kind)) {
      // A marker that somehow sits at top level: record it, do not invent work.
      lines.push(`${pad}${variable} = { ok: true, kind: ${JSON.stringify(kind)}, title: ${JSON.stringify(node.title)}, outputs: {} }`)
      lines.push(`${pad}${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}${scope.ran}[${JSON.stringify(node.id)}] = true`)
      return
    }
    if (kind === 'variable-aggregator') {
      // Dify 1.9.1 VariableAggregatorNode._run selects the first existing
      // Segment (including NoneSegment), without inspecting its value/type.
      // JS undefined represents an absent pool entry; null is a present value.
      const groups = data.advanced_settings?.group_enabled === true
        ? (data.advanced_settings.groups ?? [])
        : [{ variables: data.variables ?? [] }]
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  const __aggregated = {}`)
      for (const group of groups) {
        const values = (group.variables ?? []).map((selector) => selectorExpr(selector, scope))
        lines.push(`${pad}  {`)
        lines.push(`${pad}    const __pick = [${values.join(', ')}].find((v) => v !== undefined)`)
        const target = data.advanced_settings?.group_enabled === true
          ? `__aggregated[${JSON.stringify(group.group_name)}] = { output: __pick }`
          : '__aggregated.output = __pick'
        lines.push(`${pad}    if (__pick !== undefined) ${target}`)
        lines.push(`${pad}  }`)
      }
      lines.push(
        `${pad}  ${variable} = { ok: true, kind: 'variable-aggregator', title: ${JSON.stringify(node.title)}, outputs: __aggregated }`,
      )
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (kind === 'template-transform') {
      const template = String(data.template ?? '')
      if (!hasJinja(template)) {
        // Selector-only template: rendered inline with zero agent calls. This is
        // the common case and stays exactly as fast as before.
        const expr = renderTextExpr(template, scope, localBindings(node, scope))
        lines.push(`${pad}if (${guard}) {`)
        lines.push(`${pad}  ${variable} = { ok: true, kind: 'template-transform', title: ${JSON.stringify(node.title)}, outputs: { output: ${expr} } }`)
        lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
        lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
        lines.push(`${pad}}`)
        return
      }
      // Jinja2 template. Dify resolves `{{#node.var#}}` selectors BEFORE Jinja2
      // runs, so this emits a template whose selectors have already been
      // substituted with their values, plus a variable context for Jinja.
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  const __ctx = {}`)
      // `localBindings` maps each declared variable (plus `context`) to the JS
      // expression that reads it, so the Jinja runtime sees real values.
      for (const [name, expr] of localBindings(node, scope)) {
        lines.push(`${pad}  __ctx[${JSON.stringify(name)}] = ${expr}`)
      }
      // Selector substitution happens as a plain string render first; the
      // result is then handed to nunjucks unchanged.
      lines.push(`${pad}  const __tpl = ${renderTextExpr(template, scope, localBindings(node, scope))}`)
      lines.push(`${pad}  const __res = await __jinja(__tpl, __ctx, ${JSON.stringify(node.id)}, ${JSON.stringify(node.title ?? '')})`)
      lines.push(`${pad}  ${variable} = { ok: true, kind: 'template-transform', title: ${JSON.stringify(node.title)}, outputs: __res }`)
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (kind === 'assigner') {
      const items = assignerItems(data)
      lines.push(`${pad}if (${guard}) {`)
      for (const item of items) {
        const selector = item?.variable_selector
        if (!Array.isArray(selector) || selector.length < 2) {
          throw new Error(`assigner ${node.id} item has an invalid variable_selector`)
        }
        const [head, name] = [String(selector[0]), String(selector[1])]
        const targetVar = scope.varByNode.get(head)
        const holder =
          head === 'conversation' || head === 'environment' || head === 'sys'
            ? `__vars[${JSON.stringify(head)}]`
            : head === ir.startId
              ? 'args'
              : `${targetVar}.outputs`
        if (head !== 'conversation' && head !== 'environment' && head !== 'sys' && head !== ir.startId) {
          if (targetVar === undefined) throw new Error(`assigner ${node.id} target ${head} is not a preceding node`)
          lines.push(`${pad}  if (${targetVar} === undefined) throw new Error('assigner ${node.id} target ${head}.${name} has not run')`)
        }
        const valueExpr =
          item.input_type === 'constant'
            ? JSON.stringify(item.value ?? '')
            : Array.isArray(item.value)
              ? selectorExpr(item.value, scope)
              : renderTextExpr(String(item.value ?? ''), scope)
        const operation = String(item.operation ?? 'over-write')
        lines.push(`${pad}  {`)
        lines.push(`${pad}    const __v = ${valueExpr}`)
        lines.push(`${pad}    const __h = ${holder}`)
        lines.push(`${pad}    if (__h === undefined || __h === null) throw new Error('assigner ${node.id} target ${head}.${name} is not writable')`)
        const key = JSON.stringify(name)
        if (operation === 'clear') {
          lines.push(`${pad}    delete __h[${key}]`)
        } else if (operation === 'append') {
          lines.push(
            `${pad}    const __c = __h[${key}]; __h[${key}] = Array.isArray(__c) ? [...__c, __v] : (__c === undefined || __c === null ? [__v] : [__c, __v])`,
          )
        } else if (operation === 'extend') {
          lines.push(
            `${pad}    const __c = __h[${key}]; __h[${key}] = Array.isArray(__c) ? [...__c, ...(Array.isArray(__v) ? __v : [__v])] : (Array.isArray(__v) ? __v : [__v])`,
          )
        } else if (['over-write', 'overwrite', 'set', 'overwrite-value', ''].includes(operation)) {
          lines.push(`${pad}    __h[${key}] = __v`)
        } else {
          throw new Error(`assigner ${node.id} operation "${operation}" is not supported`)
        }
        lines.push(`${pad}  }`)
      }
      lines.push(
        `${pad}  ${variable} = { ok: true, kind: 'assigner', title: ${JSON.stringify(node.title)}, outputs: {} }`,
      )
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (kind === 'answer') {
      const expr = renderTextExpr(String(data.answer ?? ''), scope, localBindings(node, scope))
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  const __a = ${expr}`)
      lines.push(`${pad}  ${variable} = { ok: true, kind: 'answer', title: ${JSON.stringify(node.title)}, outputs: { answer: __a, text: __a } }`)
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  __answers.push(__a)`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (kind === 'list-operator') {
      const inputExpr = selectorExpr(data.variable ?? data.variable_selector, scope)
      const filters = data.filter_by?.enabled === true ? (data.filter_by.filters ?? []) : []
      const filterExpr = filters.length === 0
        ? 'true'
        : filters.map((filter) => {
            const value = filter.value
            const right = filter.value_type === 'variable' && Array.isArray(value) ? selectorExpr(value, scope) : JSON.stringify(value ?? null)
            return `__cmp(__item[${JSON.stringify(String(filter.key ?? ''))}], ${JSON.stringify(String(filter.comparison_operator ?? '='))}, ${right}, ${JSON.stringify(filter.varType ?? null)})`
          }).join(' && ')
      const order = data.order_by?.enabled === true ? data.order_by : undefined
      const limit = data.limit?.enabled === true ? Math.max(0, Number(data.limit.size ?? 0)) : undefined
      const extract = data.extract_by?.enabled === true ? String(data.extract_by.serial ?? 'first') : undefined
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  const __list = (() => { const v = ${inputExpr}; return Array.isArray(v) ? v.slice() : v === undefined || v === null ? [] : [v] })()`)
      lines.push(`${pad}  let __filtered = __list.filter((__item) => ${filterExpr})`)
      if (order !== undefined) {
        const key = String(order.key ?? '')
        const direction = String(order.value ?? order.order ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
        lines.push(`${pad}  __filtered = __filtered.slice().sort((a, b) => { const x = a == null ? a : a[${JSON.stringify(key)}]; const y = b == null ? b : b[${JSON.stringify(key)}]; if (x === y) return 0; return (x > y ? 1 : -1) * ${direction} })`)
      }
      if (limit !== undefined) lines.push(`${pad}  __filtered = __filtered.slice(0, ${limit})`)
      lines.push(`${pad}  const __result = ${extract === undefined ? '__filtered' : `(() => { const s = ${JSON.stringify(extract)}; if (s === 'first') return __filtered.slice(0, 1); if (s === 'last') return __filtered.slice(-1); const n = Number(s); return Number.isFinite(n) ? __filtered.slice(Math.max(0, n - 1), Math.max(1, n)) : __filtered.slice(0, 1) })()`}`)
      lines.push(
        `${pad}  ${variable} = { ok: true, kind: 'list-operator', title: ${JSON.stringify(node.title)}, outputs: { result: __result, first_record: __result[0] ?? null, last_record: __result[__result.length - 1] ?? null, count: __result.length } }`,
      )
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    if (kind === 'generic') {
      // An unknown node type must not break parsing or scheduling. It is a
      // visible passthrough: the outgoing `source` edge still runs.
      lines.push(`${pad}if (${guard}) {`)
      lines.push(`${pad}  ${variable} = { ok: true, kind: 'generic', type: ${JSON.stringify(node.rawType)}, title: ${JSON.stringify(node.title)}, outputs: { passthrough: true } }`)
      lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
      lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
      lines.push(`${pad}}`)
      return
    }
    throw new Error(`internal: no emitter for node ${node.id} (${kind})`)
  }

  /** Emit one container (iteration / loop) and its child sub-graph. */
  const emitContainer = (node, unit, guard, level) => {
    const data = node.data ?? {}
    const pad = indentOf(level)
    const container = ir.containers.get(node.id)
    const index = counters.container
    counters.container += 1
    const itemsVar = `__items${index}`
    const outVar = `__out${index}`
    const ranVar = `__ranIt${index}`
    const branchVar = `__branchIt${index}`
    const idxVar = `__idxIt${index}`
    const itemVar = `__itemIt${index}`
    const errorMode = String(data.error_handle_mode ?? 'terminated')
    const continueOnError = errorMode !== 'terminated'
    const removeAbnormal = errorMode === 'remove-abnormal-output'
    const isParallel = data.is_parallel === true && node.kind === 'iteration'
    const maxParallel = Math.max(1, Math.min(64, Number(data.parallel_nums ?? 10) || 10))
    const variable = scope.varByNode.get(node.id)

    const childIds = (container?.children ?? []).map((child) => child.id)
    const childNodes = (container?.children ?? [])
    // Fresh result vars for the body; declared inside the loop body so each item
    // starts clean and untaken branches stay `undefined`.
    const childVars = new Map()
    childNodes.forEach((child, childIndex) => {
      if (START_MARKERS.has(child.kind)) return
      childVars.set(child.id, `__i${index}_${childIndex}`)
    })
    const innerScope = {
      startId: ir.startId,
      varByNode: new Map([...scope.varByNode, ...childVars]),
      locals: new Map(scope.locals),
      ran: ranVar,
      branch: branchVar,
      nodes: '__nodes',
      indent: level + 2,
    }
    // Container-local bindings: `item` / `index` for iteration-start/loop-start.
    const marker = childNodes.find((child) => child.kind === `${node.kind}-start`)
    let markerId = container?.startId ?? marker?.id
    if (markerId === undefined) {
      const entryIncoming = adjacency(childIds, container?.innerEdges ?? []).incoming
      markerId = childNodes.find((child) => (entryIncoming.get(child.id) ?? []).length === 0)?.id
    }
    if (markerId !== undefined) {
      innerScope.locals.set(String(markerId), { item: itemVar, index: idxVar })
      // Some exports reference the container id for the current item.
      innerScope.locals.set(String(node.id), { item: itemVar, index: idxVar })
    }
    const bodyUnit = {
      nodes: childNodes,
      edges: container?.innerEdges ?? [],
      entryId: markerId,
    }
    bodyUnit.order = container !== undefined
      ? orderNodes(childNodes, bodyUnit.edges, (id) => childIds.indexOf(id))
      : []
    const bodyIncoming = adjacency(childIds, bodyUnit.edges).incoming

    // The per-item output expression: iteration output_selector, else the
    // container end marker's collected value, else the last child's outputs.
    let outputExpr
    const outSelector = data.output_selector
    if (Array.isArray(outSelector) && outSelector.length === 2) {
      outputExpr = selectorExpr(outSelector, innerScope)
    } else if (container?.endId !== undefined) {
      outputExpr = `${childVars.get(container.endId)}?.outputs`
    } else {
      const last = [...bodyUnit.order].reverse().find((id) => childVars.has(id))
      outputExpr = last === undefined ? 'null' : `${childVars.get(last)}?.outputs`
    }

    const emitBody = (bodyLevel) => {
      const previousScope = { ...scope }
      // Temporarily switch the closure scope for child emission.
      Object.assign(scope, innerScope, { indent: bodyLevel })
      for (const id of bodyUnit.order) {
        const child = ir.byId.get(id)
        if (child === undefined) continue
        if (child.kind === `${node.kind}-start`) {
          lines.push(`${indentOf(bodyLevel)}if (${idxVar} >= 0) { ${innerScope.ran}[${JSON.stringify(id)}] = true }`)
          continue
        }
        if (child.kind === `${node.kind}-end`) {
          const collect = data.output_type === 'array' ? '{}' : '{}'
          const declared = Array.isArray(child.data?.outputs) ? child.data.outputs : []
          const entries = declared.map((out, outIndex) => {
            const expr = selectorExpr(out.value_selector, innerScope)
            return `${JSON.stringify(out.variable ?? `output_${outIndex}`)}: (${expr} === undefined ? null : ${expr})`
          })
          lines.push(`${indentOf(bodyLevel)}${childVars.get(id)} = { ok: true, kind: ${JSON.stringify(child.kind)}, title: ${JSON.stringify(child.title)}, outputs: ${entries.length > 0 ? `{${entries.join(', ')}}` : collect} }`)
          lines.push(`${indentOf(bodyLevel)}${scope.nodes}[${JSON.stringify(id)}] = ${childVars.get(id)}`)
          lines.push(`${indentOf(bodyLevel)}${innerScope.ran}[${JSON.stringify(id)}] = true`)
          continue
        }
        const childGuard = guardFor(child, bodyUnit, bodyIncoming)
        if (CONTAINER_KINDS.has(child.kind)) emitContainer(child, bodyUnit, childGuard, bodyLevel)
        else if (HOST_KINDS.has(child.kind)) emitHost(child, bodyUnit, childGuard, bodyLevel)
        else emitPure(child, bodyUnit, childGuard, bodyLevel)
      }
      Object.assign(scope, previousScope)
    }

    lines.push(`${pad}if (${guard}) {`)
    const iterExpr = node.kind === 'loop'
      ? (() => {
          const explicitCount = Number(data.loop_count ?? 1)
          const selector = data.loop_count_selector
          const countExpr = Array.isArray(selector) ? `__num(${selectorExpr(selector, scope)})` : String(Number.isFinite(explicitCount) ? explicitCount : 1)
          return `(() => { const n = ${countExpr}; return new Array(n === undefined ? 0 : Math.max(0, Math.min(100, n))).fill(0) })()`
        })()
      : `(() => { const v = ${Array.isArray(data.iterator_selector) ? selectorExpr(data.iterator_selector, scope) : '[]'}; return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v] })()`
    lines.push(`${pad}  const ${itemsVar} = ${iterExpr}`)
    lines.push(`${pad}  const ${outVar} = []`)
    lines.push(`${pad}  const ${ranVar} = {}`)
    lines.push(`${pad}  const ${branchVar} = {}`)

    // Body result variables MUST be declared per item. The script runs in a
    // vm realm that is not strict mode, so an undeclared assignment would land
    // on the shared global object — and a parallel iteration's items would then
    // overwrite each other's intermediate results between two `await`s.
    const bodyDecl = childVars.size > 0 ? `let ${[...childVars.values()].join(', ')}` : ''

    if (isParallel) {
      lines.push(`${pad}  const __parallel${index} = await parallel(${itemsVar}.map((${itemVar}, ${idxVar}) => async () => {`)
      if (bodyDecl) lines.push(`${pad}    ${bodyDecl}`)
      lines.push(`${pad}    try {`)
      emitBody(level + 3)
      lines.push(`${pad}      const __v = ${outputExpr}`)
      lines.push(`${pad}      return { ok: true, value: __v === undefined ? null : __v }`)
      lines.push(`${pad}    } catch (__e) {`)
      lines.push(`${pad}      return { ok: false, error: String(__e && __e.message || __e) }`)
      lines.push(`${pad}    }`)
      lines.push(`${pad}  }))`)
      lines.push(`${pad}  for (const __item of __parallel${index}) {`)
      lines.push(`${pad}    if (__item === null || __item.ok !== true) {`)
      if (continueOnError) {
        lines.push(`${pad}      if (!${JSON.stringify(removeAbnormal)}) ${outVar}.push(null)`)
      } else {
        lines.push(`${pad}      throw new Error('iteration ${node.id} item failed: ' + ((__item && __item.error) || 'unknown error'))`)
      }
      lines.push(`${pad}    } else {`)
      // Dify _execute_parallel_iterations filters all None values in remove
      // mode, including successful null outputs; sequential mode keeps those.
      if (removeAbnormal) lines.push(`${pad}      if (__item.value !== null) ${outVar}.push(__item.value)`)
      else lines.push(`${pad}      ${outVar}.push(__item.value)`)
      lines.push(`${pad}    }`)
      lines.push(`${pad}  }`)
    } else {
      const count = node.kind === 'loop' ? `${itemsVar}.length` : `${itemsVar}.length`
      lines.push(`${pad}  for (let ${idxVar} = 0; ${idxVar} < ${count}; ${idxVar}++) {`)
      lines.push(`${pad}    const ${itemVar} = ${node.kind === 'loop' ? idxVar : `${itemsVar}[${idxVar}]`}`)
      if (bodyDecl) lines.push(`${pad}    ${bodyDecl}`)
      if (continueOnError) {
        lines.push(`${pad}    let __itemFailed = false`)
        lines.push(`${pad}    let __itemValue = null`)
        lines.push(`${pad}    try {`)
        emitBody(level + 3)
        lines.push(`${pad}      const __v = ${outputExpr}`)
        lines.push(`${pad}      __itemValue = __v === undefined ? null : __v`)
        lines.push(`${pad}    } catch (__e) {`)
        lines.push(`${pad}      __itemFailed = true`)
        lines.push(`${pad}      if (!${JSON.stringify(removeAbnormal)}) ${outVar}.push(null)`)
        lines.push(`${pad}    }`)
        lines.push(`${pad}    if (!__itemFailed) ${outVar}.push(__itemValue)`)
      } else {
        emitBody(level + 2)
        lines.push(`${pad}    const __v = ${outputExpr}`)
        lines.push(`${pad}    ${outVar}.push(__v === undefined ? null : __v)`)
      }
      if (node.kind === 'loop' && Array.isArray(data.break_conditions) && data.break_conditions.length > 0) {
        const logic = String(data.logical_operator ?? 'and').toLowerCase()
        const conds = data.break_conditions.map((condition) => conditionExpr(condition, innerScope))
        lines.push(`${pad}    if (${logic === 'or' ? conds.join(' || ') : conds.join(' && ')}) break`)
      }
      lines.push(`${pad}  }`)
    }

    // Dify `flatten_output`: each item may itself yield an array, and the option
    // asks the container to concatenate them into one flat array. Without the
    // flag the per-item values stay nested, exactly as Dify leaves them.
    if (node.kind === 'iteration' && data.flatten_output === true) {
      lines.push(`${pad}  const ${outVar}F = ${outVar}.flat()`)
      lines.push(`${pad}  ${variable} = { ok: true, kind: ${JSON.stringify(node.kind)}, title: ${JSON.stringify(node.title)}, outputs: { output: ${outVar}F, length: ${outVar}F.length } }`)
    } else {
      lines.push(`${pad}  ${variable} = { ok: true, kind: ${JSON.stringify(node.kind)}, title: ${JSON.stringify(node.title)}, outputs: { output: ${outVar}, length: ${outVar}.length } }`)
    }
    lines.push(`${pad}  ${scope.nodes}[${JSON.stringify(node.id)}] = ${variable}`)
    lines.push(`${pad}  ${scope.ran}[${JSON.stringify(node.id)}] = true`)
    lines.push(`${pad}}`)
  }

  /** Emit the top-level unit. */
  const unit = {
    nodes: ir.topNodes,
    edges: ir.topEdges,
    entryId: ir.entryId,
  }
  unit.order = topOrder
  const topIncoming = adjacency(ir.topNodes.map((node) => node.id), ir.topEdges).incoming

  const end = ir.topNodes.find((node) => node.kind === 'end')
  for (const id of unit.order) {
    const node = ir.byId.get(id)
    if (node === undefined) continue
    if (node.kind === 'start') {
      lines.push(`${scope.ran}[${JSON.stringify(id)}] = true`)
      continue
    }
    if (node.kind === 'end') continue
    if (CONTAINER_KINDS.has(node.kind)) {
      emitContainer(node, unit, guardFor(node, unit, topIncoming), 0)
    } else {
      const guard = guardFor(node, unit, topIncoming)
      if (HOST_KINDS.has(node.kind)) emitHost(node, unit, guard, 0)
      else emitPure(node, unit, guard, 0)
    }
    nodeMeta.push({ id, type: node.kind, title: node.title, variable: scope.varByNode.get(id) })
  }

  const entries = (end?.data?.outputs ?? []).map((out, i) => {
    const expr = selectorExpr(out.value_selector, scope)
    const key = JSON.stringify(out.variable ?? `output_${i}`)
    return `${key}: (${expr} === undefined ? null : ${expr})`
  })
  const answers = ir.topNodes.filter((node) => node.kind === 'answer')
  lines.push(`const __outputs = {${entries.join(', ')}}`)
  lines.push(`const __answer = __answers.length > 0 ? __answers.join('\\n\\n') : ''`)
  lines.push(`if (__answers.length > 0 && __outputs.answer === undefined) __outputs.answer = __answer`)
  lines.push('return { nodes: __nodes, outputs: __outputs, answers: __answers }')

  return {
    script: lines.join('\n'),
    meta: {
      name: `dify-${(parsed.appName || 'workflow').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}`,
      description: `Compiled Dify workflow ${parsed.appName || ''} (${unit.order.length} top-level nodes)`,
      phases: [{ title: `dify:${parsed.appName || 'workflow'}` }],
    },
    ir,
    order: unit.order,
    startInputs: inspection.startInputs,
    requiredInputs: inspection.requiredInputs,
    endOutputs: inspection.endOutputs,
    answerCount: inspection.answerCount,
    nodes: nodeMeta,
    inspection,
  }
}
