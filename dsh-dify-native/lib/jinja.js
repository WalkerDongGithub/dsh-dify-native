/**
 * Jinja2 rendering for `template-transform` nodes.
 *
 * Dify backs `template-transform` with a real Jinja2 environment. This module
 * provides that by delegating to nunjucks (Mozilla's Jinja2 port), so the node
 * supports the constructs users actually write: `{% for %}`, `{% if %}`,
 * filters, `{% set %}`, nested loops, attribute access and arithmetic.
 *
 * Two-layer variable syntax, matching Dify's execution order:
 *
 *   1. `{{#node.var#}}` — Dify's own selector reference. The compiler resolves
 *      these to values BEFORE the template is rendered (see `renderTextExpr` in
 *      `dsl.js`), and they arrive here as plain values in `context`.
 *   2. Jinja2 — everything left over. `{{ name }}`, `{% for item in items %}`,
 *      `{{ price | round(2) }}` and so on are evaluated here.
 *
 * Failure policy: a template that cannot be rendered is the template author's
 * error, not ours. The node fails with a message that names the construct and
 * the position, and the run stops there. We never fall back to emitting the
 * raw template text: that would hand the caller a plausible-looking wrong
 * answer instead of telling them they made a mistake.
 */
import nunjucks from 'nunjucks'

/**
 * Property names a template must never reach.
 *
 * nunjucks is not a sandbox: `{{ a["constructor"]["constructor"](...)(...) }}`
 * can escape to the JS host. Dify's Jinja2 environment has the equivalent
 * exposure, so this is not a behaviour difference — it is a defensive boundary.
 * These names have no legitimate place in a workflow template, so blocking them
 * costs no real functionality (see README's security note).
 */
const DENY = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'arguments',
])

let hardened = false

/**
 * Install the property-access guard once per process.
 *
 * nunjucks resolves every `a.b` / `a["b"]` through `runtime.memberLookup`, so
 * replacing that one function closes the prototype-chain route without touching
 * the compiler or forking the library. Idempotent: the plugin may be mounted
 * more than once in a process tree.
 */
function harden() {
  if (hardened) return
  const runtime = nunjucks.runtime
  if (runtime !== undefined && typeof runtime.memberLookup === 'function') {
    const original = runtime.memberLookup
    runtime.memberLookup = function guardedMemberLookup(object, name) {
      if (typeof name === 'string' && DENY.has(name)) return undefined
      return original(object, name)
    }
  }
  hardened = true
}

/**
 * Jinja2 filters nunjucks does not ship, added so templates that work in Dify
 * keep working here.
 *
 * Each entry mirrors Jinja2's signature and behaviour. They are registered on
 * the environment rather than patched into the library, so they are local to
 * this plugin's templates.
 */
const EXTRA_FILTERS = {
  /**
   * `map(attribute="name")` / `map("upper")` — Jinja2's map.
   * nunjucks has no `map` at all, and `{{ xs | map(...) }}` failing is common
   * enough (it is the standard way to pull one field out of records) to add.
   *
   * nunjucks passes keyword arguments as ONE object in the first positional
   * slot, so `map(attribute="x")` arrives as `{attribute: 'x'}` while
   * `map("upper")` arrives as the string `'upper'`.
   */
  map(sequence, keyword) {
    const list = Array.isArray(sequence) ? sequence : []
    const kwargs = keyword !== null && typeof keyword === 'object' && !Array.isArray(keyword) ? keyword : undefined
    const attribute = kwargs?.attribute
    if (attribute === undefined || attribute === null) {
      // `map("upper")` applies a filter to every item.
      const filter = this?.filters?.[String(kwargs?.default ?? keyword)]
      return typeof filter === 'function' ? list.map((item) => filter.call(this, item)) : list
    }
    // `map(attribute="name")` projects one field; a dotted path is allowed.
    const path = String(attribute).split('.')
    return list.map((item) => readPath(item, path))
  },
  /** `tojson` — Jinja2's JSON dump (used heavily for debugging output). */
  tojson(value, indent) {
    const out = JSON.stringify(value, null, typeof indent === 'number' ? indent : undefined)
    return out === undefined ? 'null' : out
  },
  /** `items` — iterate a dict as (key, value) pairs. */
  items(mapping) {
    return mapping !== null && typeof mapping === 'object' ? Object.entries(mapping) : []
  },
  /** `unique` — drop duplicate entries, preserving order. */
  unique(sequence) {
    const list = Array.isArray(sequence) ? sequence : []
    const seen = new Set()
    return list.filter((item) => {
      const key = typeof item === 'object' ? JSON.stringify(item) : `${typeof item}:${String(item)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  },
  /**
   * `sum(attribute="price")` — override nunjucks's, which reads only positional
   * arguments and therefore returns `NaN` for Jinja2's keyword form. A `NaN`
   * total is exactly the silent-wrong-output class this runtime refuses to
   * produce, so the keyword form is supported here.
   */
  sum(sequence, keyword) {
    const list = Array.isArray(sequence) ? sequence : []
    const kwargs = keyword !== null && typeof keyword === 'object' && !Array.isArray(keyword) ? keyword : {}
    const attribute = kwargs.attribute ?? (typeof keyword === 'string' ? keyword : undefined)
    const start = kwargs.start ?? 0
    const values = attribute === undefined ? list : list.map((item) => readPath(item, String(attribute).split('.')))
    return values.reduce((total, value) => total + Number(value ?? 0), Number(start) || 0)
  },
}

/** Resolve a dotted attribute path against a value, tolerating nulls. */
function readPath(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** One configured environment, reusing compiled-template caching across nodes. */
let environment

function environmentOf() {
  if (environment === undefined) {
    harden()
    environment = new nunjucks.Environment(null, {
      autoescape: false, // Dify does not HTML-escape workflow text
      throwOnUndefined: false, // Dify renders undefined as empty
      trimBlocks: false,
      lstripBlocks: false,
    })
    for (const [name, filter] of Object.entries(EXTRA_FILTERS)) {
      environment.addFilter(name, filter)
    }
  }
  return environment
}

/**
 * Describe where in the template rendering failed, for the node's error.
 * @param error - the thrown nunjucks error.
 * @param template - the template source, for a line excerpt.
 */
function explain(error, template) {
  const message = `${error?.name ?? 'Error'}: ${String(error?.message ?? error)}`
  const line = Number(error?.lineno ?? error?.line ?? 0)
  if (!Number.isFinite(line) || line <= 0) return message
  const source = String(template).split('\n')[line - 1] ?? ''
  const trimmed = source.trim()
  return trimmed.length > 0 ? `${message} (line ${line}: ${trimmed.slice(0, 120)})` : `${message} (line ${line})`
}

/**
 * Render one template-transform template.
 *
 * @param template - the DSL `template` string, with `{{#node.var#}}` already resolved.
 * @param context - Jinja variables: the node's declared `variables` plus any
 *                  selector values the compiler bound for it.
 * @returns `{ ok: true, text }` or `{ ok: false, error }` when the template is invalid.
 */
export function renderJinja(template, context = {}) {
  try {
    const text = environmentOf().renderString(String(template ?? ''), context ?? {})
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: explain(error, template) }
  }
}

/**
 * Compile a template without rendering it, to surface syntax errors early.
 *
 * A template-transform node can be checked at inspect time this way: the
 * compiler reports an invalid template before a run spends any models on the
 * nodes that lead up to it.
 *
 * @param template - raw DSL template.
 * @returns `undefined` when the template compiles, else a human-readable error.
 */
export function compileJinja(template) {
  try {
    // `Template` alone only stores the source; `compile()` is what lexes and
    // parses it, so that is the call that surfaces a syntax error eagerly.
    new nunjucks.Template(String(template ?? ''), environmentOf()).compile()
    return undefined
  } catch (error) {
    return explain(error, template)
  }
}

/**
 * Whether a template string contains Jinja2 constructs at all.
 *
 * Used by the compiler to decide whether a `template-transform` node needs the
 * Jinja path or is fully handled by selector substitution alone. `{{#a.b#}}`
 * selectors are stripped first, so a selector-only template reports `false`.
 *
 * @param template - raw DSL template.
 */
export function hasJinja(template) {
  const remainder = String(template ?? '').replace(/\{\{#([^#{}]+)#\}\}/g, '')
  return /\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|\{\{(?!\s*#)[\s\S]*?\}\}/.test(remainder)
}
