/**
 * Declarative tool contracts — run a third-party tool without writing code.
 *
 * A Dify tool node carries three things: `provider_name`, `tool_name`, and two
 * bags of values — `tool_configurations` (what the user configured once, e.g. an
 * API key) and `tool_parameters` (what this call supplies, e.g. the URL). Dify
 * feeds both into a Python `Tool._invoke` running under its plugin daemon.
 *
 * This module takes the shape that covers most hand-written tools — "take
 * config + parameters, make one HTTP request, pick fields out of the response" —
 * and expresses it as YAML. No Python, no daemon, no per-tool adapter.
 *
 * Deliberately NOT Jinja: a contract builds URLs and attaches credentials, so
 * the template language stays three fixed lookups (`{{parameters.x}}`,
 * `{{credentials.x}}`, `{{response.x}}`) that cannot execute anything.
 *
 * See docs/dify-tool-contract.md for the full format and its honest limits.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Placeholder: `{{parameters.name}}`, `{{credentials.name}}`, `{{response.path}}`.
 * A bare `{{response}}` (no path) means the whole response body, which is what
 * most single-value APIs need.
 */
const PLACEHOLDER = /\{\{\s*(parameters|credentials|response)(?:\.([A-Za-z0-9_.[\]]+))?\s*\}\}/g
const WHOLE_PLACEHOLDER = /^\{\{\s*(parameters|credentials|response)(?:\.([A-Za-z0-9_.[\]]+))?\s*\}\}$/

/** Read a placeholder's value; a missing path yields the family root itself. */
function readPlaceholder(scope, family, path) {
  if (path === undefined) return scope[family]
  return readPath(scope[family], path)
}

/**
 * Read a dotted / indexed path out of a value (`a.b[0].c`).
 * @returns the value at that path, or `undefined`.
 */
function readPath(root, path) {
  let cursor = root
  for (const segment of String(path).split('.')) {
    if (cursor === undefined || cursor === null) return undefined
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment)
    if (match === null) return undefined
    if (match[1].length > 0) cursor = cursor[match[1]]
    for (const index of match[2].match(/\d+/g) ?? []) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[Number(index)]
    }
  }
  return cursor
}

/** Dify's empty-value rule: null / undefined / "" means "omit this field". */
function isEmpty(value) {
  return value === undefined || value === null || value === ''
}

/**
 * Substitute the three placeholder families in one string.
 * A string that is exactly one placeholder yields the raw value (so numbers and
 * booleans keep their type); a mixed string is interpolated as text.
 */
function renderValue(template, scope) {
  if (typeof template !== 'string') return template
  const whole = WHOLE_PLACEHOLDER.exec(template.trim())
  if (whole !== null) return readPlaceholder(scope, whole[1], whole[2])
  return template.replace(PLACEHOLDER, (_all, family, path) => {
    const value = readPlaceholder(scope, family, path)
    return isEmpty(value) ? '' : String(value)
  })
}

/**
 * Render a string→value map, dropping entries that are effectively unset.
 *
 * Dify's tool implementations guard each credential with `if api_key:` — an
 * absent key means the header is not sent at all, never `Bearer ` or
 * `"undefined"`. So a template whose placeholders all resolved empty is treated
 * as "the author guarded this field": its literal prefix (`Bearer `) is not a
 * value to send on its own.
 *
 * A template with no placeholders is always sent, even if it is a bare literal.
 */
function renderMap(map, scope) {
  if (map === null || typeof map !== 'object') return {}
  const out = {}
  for (const [key, template] of Object.entries(map)) {
    const value = renderValue(template, scope)
    if (isEmpty(value)) continue
    if (typeof template === 'string') {
      const placeholders = [...template.matchAll(PLACEHOLDER)]
      if (placeholders.length > 0 && placeholders.every((match) => isEmpty(readPlaceholder(scope, match[1], match[2])))) continue
    }
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return out
}

/**
 * Normalize one parsed contract. Returns `undefined` when the file is not a
 * usable contract, so loading can report it instead of failing the whole run.
 */
function normalizeContract(raw, source) {
  if (raw === null || typeof raw !== 'object') return undefined
  const provider = String(raw.provider ?? '').trim()
  const tool = String(raw.tool ?? '').trim()
  if (provider.length === 0 || tool.length === 0) return undefined
  const request = raw.request
  if (request === null || typeof request !== 'object' || typeof request.url !== 'string') return undefined
  const parameters = Array.isArray(raw.parameters) ? raw.parameters : []
  const declared = []
  for (const item of parameters) {
    if (item === null || typeof item !== 'object') continue
    const name = String(item.name ?? '').trim()
    if (name.length === 0) continue
    declared.push({
      name,
      type: String(item.type ?? 'string'),
      // `llm` = supplied by the call (Dify's tool_parameters); `form` = configured
      // once by the user (Dify's tool_configurations / credentials).
      form: String(item.form ?? 'llm') === 'form' ? 'form' : 'llm',
      required: item.required === true,
      default: item.default,
    })
  }
  return {
    provider,
    tool,
    label: raw.label ?? {},
    parameters: declared,
    request: {
      method: String(request.method ?? 'GET').toUpperCase(),
      url: request.url,
      headers: request.headers ?? {},
      query: request.query ?? request.params ?? {},
      body: request.body,
      bodyIsJson: request.body_is_json !== false,
    },
    response: raw.response ?? {},
    settings: raw.settings ?? {},
    source,
  }
}

/** Load every `*.yaml` / `*.yml` contract under a directory (recursive, one level). */
function loadContractsFrom(dir, into, seen) {
  if (!existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      loadContractsFrom(full, into, seen)
      continue
    }
    if (!/\.ya?ml$/i.test(entry.name)) continue
    const real = (() => {
      try {
        return statSync(full).size
      } catch {
        return 0
      }
    })()
    if (real === 0) continue
    let raw
    try {
      raw = parseYaml(readFileSync(full, 'utf8'))
    } catch {
      continue
    }
    const contract = normalizeContract(raw, full)
    if (contract === undefined) continue
    into.set(`${contract.provider}/${contract.tool}`, contract)
    seen.push(contract)
  }
}

/**
 * Build the registry of every declared tool.
 *
 * @param roots - directories to scan; missing ones are simply skipped, so a
 *                deployment without any contracts has an empty registry.
 * @returns `{ get(provider, tool), list(), errors }`.
 */
export function createToolRegistry(roots) {
  const byKey = new Map()
  const contracts = []
  for (const root of roots ?? []) {
    if (typeof root === 'string' && root.length > 0) loadContractsFrom(root, byKey, contracts)
  }
  return {
    get(provider, tool) {
      return byKey.get(`${provider}/${tool}`)
    },
    has(provider, tool) {
      return byKey.has(`${provider}/${tool}`)
    },
    list() {
      return contracts.map((item) => `${item.provider}/${item.tool}`)
    },
    size() {
      return contracts.length
    },
  }
}

/**
 * Execute one contract.
 *
 * @param contract - from {@link createToolRegistry}.
 * @param values - `{ parameters, configurations }` taken from the DSL node.
 * @param options - `{ fetch, signal }`; `fetch` is the host HTTP client so this
 *                  module owns no network stack of its own.
 * @returns `{ ok: true, outputs, meta }` or `{ ok: false, error }`.
 */
export async function executeContract(contract, values, options = {}) {
  const parameters = values?.parameters ?? {}
  const configurations = values?.configurations ?? {}
  const credentials = {}
  const inputs = {}
  for (const declared of contract.parameters) {
    const source = declared.form === 'form' ? configurations : parameters
    let value = source[declared.name]
    if (typeof value === 'object' && value !== null && 'value' in value) value = value.value
    if (isEmpty(value)) value = declared.default
    if (isEmpty(value)) {
      if (declared.required) {
        return {
          ok: false,
          error: `tool ${contract.provider}/${contract.tool}: required ${declared.form === 'form' ? 'configuration' : 'parameter'} "${declared.name}" is missing`,
        }
      }
      continue
    }
    if (declared.form === 'form') credentials[declared.name] = value
    else inputs[declared.name] = value
  }
  const scope = { parameters: inputs, credentials, response: undefined }
  let url
  try {
    url = new URL(renderValue(contract.request.url, scope))
  } catch {
    return { ok: false, error: `tool ${contract.provider}/${contract.tool}: url is not absolute: ${contract.request.url}` }
  }
  for (const [key, value] of Object.entries(renderMap(contract.request.query, scope))) url.searchParams.append(key, value)
  const headers = renderMap(contract.request.headers, scope)
  const body =
    contract.request.body === undefined || contract.request.body === null
      ? undefined
      : contract.request.bodyIsJson
        ? JSON.stringify(renderMap(contract.request.body, scope))
        : String(renderValue(contract.request.body, scope))
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    if (contract.request.bodyIsJson) headers['Content-Type'] = 'application/json'
  }
  const timeoutMs = Number(contract.settings.timeout_ms ?? 30_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
  const onOuterAbort = () => controller.abort(new Error('cancelled'))
  options.signal?.addEventListener?.('abort', onOuterAbort, { once: true })
  let response
  let raw
  try {
    const fetchImpl = options.fetch
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: 'no HTTP client available to execute the tool contract' }
    }
    response = await fetchImpl(url, {
      method: contract.request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    })
    raw = typeof response.text === 'function' ? await response.text() : ''
  } catch (error) {
    return { ok: false, error: `tool ${contract.provider}/${contract.tool} request failed: ${error?.message ?? String(error)}` }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', onOuterAbort)
  }
  const status = Number(response?.status ?? 0)
  if (typeof response?.ok === 'boolean' && !response.ok) {
    return {
      ok: false,
      error: `tool ${contract.provider}/${contract.tool} returned HTTP ${status}: ${String(raw ?? '').slice(0, 400)}`,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const root = parsed === undefined ? raw : parsed
  scope.response = root
  const outputs = {}
  const textTemplate = contract.response?.text
  const text = textTemplate === undefined || textTemplate === null ? (typeof root === 'string' ? root : raw) : renderValue(textTemplate, scope)
  outputs.text = typeof text === 'string' ? text : text === undefined ? '' : JSON.stringify(text)
  outputs.result = outputs.text
  if (contract.response?.json === true || contract.response?.json === undefined) {
    outputs.json = parsed === undefined ? { body: raw } : parsed
  }
  if (contract.response?.variables !== null && typeof contract.response?.variables === 'object') {
    for (const [name, template] of Object.entries(contract.response.variables)) {
      outputs[name] = renderValue(template, scope)
    }
  }
  return {
    ok: true,
    outputs,
    meta: {
      provider: contract.provider,
      tool: contract.tool,
      status,
      source: contract.source,
      engine: 'declarative-contract',
    },
  }
}
