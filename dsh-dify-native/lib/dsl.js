/**
 * Dify DSL → workflow-script compiler.
 *
 * This module owns ONLY the translation layer the guide allows us to write:
 * parse a Dify .yml, read `workflow.graph`, order the nodes, and emit a
 * JavaScript orchestration script for the harness's existing workflow engine.
 * It contains no scheduler, no executor, no sandbox, no LLM adapter.
 *
 * Supported graph shape (v2): an acyclic graph starting at one `start` node and
 * ending at one `end` node, with LLM / code / if-else / variable-aggregator /
 * template-transform nodes on the way. Branching is compiled into ordinary JS
 * control flow with an activation guard per node; joins (variable-aggregator,
 * or an end node fed by both branches) work because an inactive node simply
 * leaves its result variable `undefined`.
 *
 * Every other node type is reported as unsupported and rejected before a run,
 * never silently skipped.
 */
import { parse as parseYaml } from 'yaml'

const SUPPORTED = new Set([
  'start',
  'end',
  'llm',
  'code',
  'if-else',
  'variable-aggregator',
  'template-transform',
])

/** Node types that need a host capability (agent call) instead of pure script logic. */
const HOST_NODES = new Set(['llm', 'code', 'if-else'])

function nodeType(node) {
  return node?.data?.type ?? node?.type
}

function nodeTitle(node) {
  return node?.data?.title ?? ''
}

function edgeHandle(edge) {
  return edge?.sourceHandle ?? 'source'
}

/** Selector `['node-id', 'var']` → JS expression in the generated script. */
function selectorExpr(selector, ctx) {
  if (!Array.isArray(selector) || selector.length !== 2) {
    throw new Error(`unsupported value_selector ${JSON.stringify(selector)}`)
  }
  const [nodeId, name] = selector
  const key = JSON.stringify(String(name))
  if (String(nodeId) === ctx.startId) return `args[${key}]`
  const binding = ctx.varByNode.get(String(nodeId))
  // A node in an untaken branch stays `undefined`; optional chaining lets a
  // join (variable-aggregator / end) read it without throwing.
  if (binding !== undefined) return `${binding}?.outputs[${key}]`
  throw new Error(`value_selector ${nodeId}.${name} does not name a start input or a preceding node`)
}

/**
 * Render a Dify text (LLM prompt / template body) into a JS string expression.
 * `{{#node.var#}}` references resolve through `selectorExpr`; `{{ name }}`
 * references resolve through the node's own `variables` bindings.
 */
function renderTextExpr(text, selectorCtx, localBindings = new Map()) {
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
    if (selector.length < 2) throw new Error(`malformed prompt reference {{#${match[1]}#}}`)
    expanded.push({ expr: selectorExpr([selector[0], selector.slice(1).join('.')], selectorCtx) })
    cursor = ref.lastIndex
  }
  if (cursor < text.length) expanded.push(...expandLocals(text.slice(cursor)))

  if (expanded.length === 0) return '""'
  const parts = expanded.map((chunk) =>
    chunk.expr !== undefined ? `(${chunk.expr} ?? '')` : JSON.stringify(chunk.literal),
  )
  return `(${parts.join(' + ')})`
}

/**
 * Parse a Dify app DSL into the small graph this layer needs.
 * @param text - raw .yml contents.
 * @returns parsed graph plus its start node and start variables.
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
  }
}

/**
 * Inspect the parsed graph without executing it.
 * @param parsed - result of {@link parseDifyDsl}.
 * @returns node inventory, start inputs, and the unsupported-node list.
 */
export function inspectGraph(parsed) {
  const byId = new Map(parsed.nodes.map((node) => [String(node.id), node]))
  const starts = parsed.nodes.filter((node) => nodeType(node) === 'start')
  const unsupported = parsed.nodes
    .filter((node) => !SUPPORTED.has(nodeType(node)))
    .map((node) => ({ id: String(node.id), type: nodeType(node), title: nodeTitle(node) }))
  const types = {}
  for (const node of parsed.nodes) types[nodeType(node)] = (types[nodeType(node)] ?? 0) + 1
  const start = starts[0]
  const startVariables = (start?.data?.variables ?? []).filter((v) => v?.variable)
  const startInputs = startVariables.map((v) => v.variable)
  const requiredInputs = startVariables.filter((v) => v.required !== false).map((v) => v.variable)
  const end = parsed.nodes.find((node) => nodeType(node) === 'end')
  const endOutputs = (end?.data?.outputs ?? []).map((o) => o.variable).filter(Boolean)
  const issues = []
  if (starts.length !== 1) issues.push(`expected exactly one start node, found ${starts.length}`)
  if (end === undefined) issues.push('no end node')
  if (unsupported.length > 0) issues.push(`unsupported node types: ${unsupported.map((n) => `${n.type}/${n.id}`).join(', ')}`)
  return {
    nodeCount: parsed.nodes.length,
    nodeTypes: types,
    startInputs,
    requiredInputs,
    endOutputs,
    unsupported,
    issues,
    nodeIds: [...byId.keys()],
  }
}

/** Kahn topological order, preferring the DSL's own node order for ties. */
function topologicalOrder(parsed, byId, incoming, outgoing) {
  const index = new Map(parsed.nodes.map((node, i) => [String(node.id), i]))
  const indegree = new Map([...byId.keys()].map((id) => [id, (incoming.get(id) ?? []).length]))
  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0).sort((a, b) => index.get(a) - index.get(b))
  const order = []
  while (ready.length > 0) {
    const id = ready.shift()
    order.push(id)
    const outs = outgoing.get(id) ?? []
    for (const { target } of outs) {
      indegree.set(target, indegree.get(target) - 1)
      if (indegree.get(target) === 0) {
        ready.push(target)
        ready.sort((a, b) => index.get(a) - index.get(b))
      }
    }
  }
  if (order.length !== byId.size) {
    const placed = new Set(order)
    const stranded = [...byId.keys()].filter((id) => !placed.has(id))
    throw new Error(`graph has a cycle or unreachable nodes: ${stranded.join(', ')}`)
  }
  return order
}

/**
 * Compile the parsed graph into a workflow-engine script.
 *
 * The emitted script uses only the engine's documented globals
 * (`agent`, `phase`, `args`) and returns plain JSON. LLM / code / if-else nodes
 * become one `agent()` call per execution whose prompt is a JSON request for
 * the `dify-node` subagent provider; the provider performs the actual model
 * call, sandboxed code run, or condition evaluation. Variable-aggregator and
 * template-transform nodes compile to plain JS, so a branch join costs no agent
 * call.
 *
 * @param parsed - result of {@link parseDifyDsl}.
 * @param options - `name` used in the workflow meta, per-node timeout.
 * @returns the script, meta, execution order, and bound end outputs.
 * @throws when the graph is not a supported acyclic start→…→end graph.
 */
export function compileGraph(parsed, options = {}) {
  const inspection = inspectGraph(parsed)
  if (inspection.issues.length > 0) throw new Error(inspection.issues.join('; '))

  const byId = new Map(parsed.nodes.map((node) => [String(node.id), node]))
  const start = parsed.nodes.find((node) => nodeType(node) === 'start')
  const startId = String(start.id)

  const outgoing = new Map()
  const incoming = new Map()
  for (const edge of parsed.edges) {
    const source = String(edge.source)
    const target = String(edge.target)
    if (!byId.has(source) || !byId.has(target)) throw new Error(`edge ${edge.id} references an unknown node`)
    const sourceType = nodeType(byId.get(source))
    const handle = String(edgeHandle(edge))
    if (sourceType !== 'if-else' && handle !== 'source') {
      throw new Error(`edge ${edge.id} leaves ${source} (${sourceType}) on handle "${handle}"; only if-else branches`)
    }
    if (sourceType === 'if-else') {
      const caseIds = new Set((byId.get(source).data.cases ?? []).map((c) => String(c.case_id)))
      if (!caseIds.has(handle) && handle !== 'false') {
        throw new Error(`edge ${edge.id} leaves if-else ${source} on unknown branch "${handle}"`)
      }
    }
    if (!outgoing.has(source)) outgoing.set(source, [])
    outgoing.get(source).push({ target, handle })
    if (!incoming.has(target)) incoming.set(target, [])
    incoming.get(target).push({ source, handle })
  }
  if (!outgoing.has(startId)) throw new Error('start node has no outgoing edge')
  for (const [id, outs] of outgoing) {
    const type = nodeType(byId.get(id))
    if (type === 'end') throw new Error(`end node ${id} has outgoing edges`)
    if (type === 'if-else') {
      // An if-else may leave a branch unconnected, but each emitted branch must be unique.
      const handles = outs.map((o) => o.handle)
      if (new Set(handles).size !== handles.length) throw new Error(`if-else ${id} has duplicate branch edges`)
    } else if (outs.length > 1) {
      throw new Error(`node ${id} (${type}) has ${outs.length} outgoing edges; only if-else branches`)
    }
  }

  const order = topologicalOrder(parsed, byId, incoming, outgoing)

  // One result variable per non-terminal node, declared up front so that a node
  // in an untaken branch is simply `undefined`.
  const varByNode = new Map()
  let varIndex = 0
  for (const id of order) {
    const type = nodeType(byId.get(id))
    if (type === 'start' || type === 'end') continue
    varByNode.set(id, `__r${varIndex}`)
    varIndex += 1
  }
  const selectorCtx = { startId, varByNode }

  const lines = []
  const nodeMeta = []
  lines.push(`phase(${JSON.stringify(`dify:${parsed.appName || 'workflow'}`)})`)
  lines.push('const __nodes = {}')
  lines.push('const __ran = {}')
  lines.push('const __branch = {}')
  if (varIndex > 0) lines.push(`let ${[...varByNode.values()].join(', ')}`)

  let callIndex = 0
  for (const id of order) {
    const node = byId.get(id)
    const type = nodeType(node)
    if (type === 'start') {
      lines.push(`__ran[${JSON.stringify(id)}] = true`)
      continue
    }
    if (type === 'end') continue

    const guard = (incoming.get(id) ?? [])
      .map(({ source, handle }) => {
        const sourceType = nodeType(byId.get(source))
        if (sourceType === 'if-else') {
          return `(__ran[${JSON.stringify(source)}] === true && __branch[${JSON.stringify(source)}] === ${JSON.stringify(handle)})`
        }
        return `(__ran[${JSON.stringify(source)}] === true)`
      })
      .join(' || ')
    if (guard === '') throw new Error(`node ${id} (${type}) is not reachable from the start node`)
    const variable = varByNode.get(id)

    if (HOST_NODES.has(type)) {
      const inputs = {}
      const local = new Map()
      if (type === 'code') {
        for (const spec of node.data.variables ?? []) {
          if (spec?.variable) inputs[spec.variable] = selectorExpr(spec.value_selector, selectorCtx)
        }
      } else if (type === 'if-else') {
        for (const item of node.data.cases ?? []) {
          for (const condition of item.conditions ?? []) {
            if (condition?.variable_selector?.[1] !== undefined) {
              // Key by node id as well: two conditions may read same-named outputs.
              const key = `${condition.variable_selector[0]}.${condition.variable_selector[1]}`
              inputs[key] = selectorExpr(condition.variable_selector, selectorCtx)
            }
          }
        }
      } else if (type === 'llm') {
        for (const item of node.data.variables ?? []) {
          if (item?.variable) local.set(item.variable, selectorExpr(item.value_selector, selectorCtx))
        }
      }

      const spec = {
        kind: type,
        nodeId: id,
        title: nodeTitle(node),
        timeoutMs: options.nodeTimeoutMs ?? 120_000,
        inputs: {},
      }
      if (type === 'code') {
        spec.codeLanguage = node.data.code_language ?? 'python3'
        spec.code = node.data.code ?? ''
      }
      if (type === 'if-else') {
        spec.cases = (node.data.cases ?? []).map((item) => ({
          case_id: String(item.case_id ?? ''),
          logical_operator: item.logical_operator ?? node.data.logical_operator ?? 'and',
          conditions: (item.conditions ?? []).map((condition) => ({
            comparison_operator: condition.comparison_operator,
            value: condition.value,
            varType: condition.varType,
            variable_selector: condition.variable_selector,
          })),
        }))
        spec.logical_operator = node.data.logical_operator ?? 'and'
      }
      if (type === 'llm') {
        const model = node.data.model ?? {}
        const params = model.completion_params ?? {}
        spec.provider = model.provider
        spec.model = model.name
        if (typeof params.temperature === 'number') spec.temperature = params.temperature
        if (typeof params.max_tokens === 'number') spec.maxTokens = params.max_tokens
        spec.prompt = (node.data.prompt_template ?? []).map((item) => ({
          role: item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user',
          text: '',
        }))
      }

      const label = `${type}:${nodeTitle(node) || id}`
      const reqVar = `__req${callIndex}`
      lines.push(`if (${guard}) {`)
      if (Object.keys(inputs).length > 0) {
        const env = Object.keys(inputs).map((key) => `${JSON.stringify(key)}: ${inputs[key]}`)
        lines.push(`  const __in${callIndex} = {${env.join(', ')}}`)
      } else {
        lines.push(`  const __in${callIndex} = {}`)
      }
      lines.push(`  const ${reqVar} = ${JSON.stringify(spec)}`)
      lines.push(`  ${reqVar}.inputs = __in${callIndex}`)
      if (type === 'llm') {
        ;(node.data.prompt_template ?? []).forEach((item, promptIndex) => {
          const expr = renderTextExpr(String(item.text ?? ''), selectorCtx, local)
          lines.push(`  ${reqVar}.prompt[${promptIndex}].text = ${expr}`)
        })
      }
      lines.push(`  const __raw${callIndex} = await agent(JSON.stringify(${reqVar}), { label: ${JSON.stringify(label)} })`)
      lines.push(`  if (__raw${callIndex} === null) throw new Error('dify node ${id} (${label}) failed: no result from provider')`)
      lines.push(`  ${variable} = JSON.parse(__raw${callIndex})`)
      lines.push(`  if (!${variable}.ok) throw new Error('dify node ${id} (${label}) failed: ' + (${variable}.error ?? 'unknown error'))`)
      lines.push(`  __nodes[${JSON.stringify(id)}] = ${variable}`)
      if (type === 'if-else') lines.push(`  __branch[${JSON.stringify(id)}] = String(${variable}.outputs.result)`)
      lines.push(`  __ran[${JSON.stringify(id)}] = true`)
      lines.push('}')
      callIndex += 1
    } else if (type === 'variable-aggregator') {
      const values = (node.data.variables ?? []).map((selector) => selectorExpr(selector, selectorCtx))
      const outputType = node.data.output_type ?? 'string'
      const fallback = outputType === 'array' ? '[]' : '""'
      lines.push(`if (${guard}) {`)
      lines.push(`  const __pick = [${values.join(', ')}].find((v) => v !== undefined && v !== null)`)
      lines.push(
        `  ${variable} = { ok: true, kind: 'variable-aggregator', title: ${JSON.stringify(nodeTitle(node))}, outputs: { output: __pick === undefined ? ${fallback} : __pick } }`,
      )
      lines.push(`  __nodes[${JSON.stringify(id)}] = ${variable}`)
      lines.push(`  __ran[${JSON.stringify(id)}] = true`)
      lines.push('}')
    } else if (type === 'template-transform') {
      const local = new Map()
      for (const item of node.data.variables ?? []) {
        if (item?.variable) local.set(item.variable, selectorExpr(item.value_selector, selectorCtx))
      }
      const expr = renderTextExpr(String(node.data.template ?? ''), selectorCtx, local)
      lines.push(`if (${guard}) {`)
      lines.push(`  ${variable} = { ok: true, kind: 'template-transform', title: ${JSON.stringify(nodeTitle(node))}, outputs: { output: ${expr} } }`)
      lines.push(`  __nodes[${JSON.stringify(id)}] = ${variable}`)
      lines.push(`  __ran[${JSON.stringify(id)}] = true`)
      lines.push('}')
    }

    nodeMeta.push({ id, type, title: nodeTitle(node), variable })
  }

  const end = parsed.nodes.find((node) => nodeType(node) === 'end')
  const entries = (end.data.outputs ?? []).map((out, i) => {
    const expr = selectorExpr(out.value_selector, selectorCtx)
    const key = JSON.stringify(out.variable ?? `output_${i}`)
    return `${key}: (${expr} === undefined ? null : ${expr})`
  })
  lines.push(`const __outputs = {${entries.join(', ')}}`)
  lines.push('return { nodes: __nodes, outputs: __outputs }')

  return {
    script: lines.join('\n'),
    meta: {
      name: `dify-${(parsed.appName || 'workflow').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}`,
      description: `Compiled Dify workflow ${parsed.appName || ''} (${order.length} nodes)`,
      phases: [{ title: `dify:${parsed.appName || 'workflow'}` }],
    },
    order,
    startInputs: inspection.startInputs,
    requiredInputs: inspection.requiredInputs,
    endOutputs: inspection.endOutputs,
    nodes: nodeMeta,
    inspection,
  }
}
