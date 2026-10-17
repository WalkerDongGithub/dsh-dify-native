/**
 * template-transform Jinja2 support.
 *
 * Dify backs `template-transform` with a real Jinja2 environment; this runtime
 * delegates to nunjucks so consumer templates actually work. Two layers:
 *
 *   1. `{{#node.var#}}` — Dify selectors, resolved by the compiler.
 *   2. Jinja2 — everything else, rendered by nunjucks at execution time.
 *
 * Failure policy: an unrenderable template is the author's error. The node
 * fails with the construct and line; it never emits raw template text.
 *
 *   node tests/template-jinja.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { compileGraph, inspectGraph, parseDifyDsl } from '../lib/dsl.js'
import { compileJinja, hasJinja, renderJinja } from '../lib/jinja.js'

const DSL = '/home/walker/dify-test/dsl'

/** A minimal graph around one template-transform node. */
function graphWithTemplate(template, variables = []) {
  const declared = variables
    .map((name) => `            - { variable: ${name}, value_selector: [s, ${name}] }`)
    .join('\n')
  const yaml = `
app: { name: probe, mode: workflow }
kind: app
version: 0.1.0
workflow:
  graph:
    nodes:
      - id: s
        type: custom
        data:
          type: start
          title: start
          variables:
            - { variable: items, label: items, type: array, required: true }
            - { variable: name, label: name, type: text-input, required: true }
      - id: t
        type: custom
        data:
          type: template-transform
          title: tmpl
          template: ${JSON.stringify(template)}
          variables:
${declared || '            []'}
      - id: e
        type: custom
        data:
          type: end
          title: end
          outputs: [{ variable: output, value_selector: [t, output] }]
    edges:
      - { id: e1, source: s, target: t }
      - { id: e2, source: t, target: e }
`
  return inspectGraph(parseDifyDsl(yaml))
}

const invalidRows = (inspection) => (inspection.diagnostics ?? []).filter((row) => row.code === 'template-jinja-invalid')

// ---------------------------------------------------------------- detection
// 1. A selector-only template is not Jinja and stays on the inline fast path.
{
  assert.equal(hasJinja('第{{#s.name#}}项'), false)
  const inspection = graphWithTemplate('第{{#s.name#}}项')
  assert.equal(invalidRows(inspection).length, 0)
  assert.equal(inspection.support.find((row) => row.id === 't').mode, 'full')
  console.log('ok 1 — selector-only templates are not Jinja and stay full')
}

// 2. Jinja constructs are detected.
{
  assert.equal(hasJinja('{% for x in items %}{{ x }}{% endfor %}'), true)
  assert.equal(hasJinja('Hello {{ name }}'), true)
  assert.equal(hasJinja('{{ name | upper }}'), true)
  assert.equal(hasJinja('a{# note #}b'), true)
  assert.equal(hasJinja('{{#s.name#}} is {{ name }}'), true, 'selectors are stripped, {{ name }} remains')
  console.log('ok 2 — Jinja2 constructs are detected, selectors are excluded')
}

// ---------------------------------------------------------------- rendering
// 3. The constructs users actually write render correctly.
{
  const cases = [
    ['{% for x in items %}- {{ x }}\n{% endfor %}', { items: ['a', 'b'] }, '- a\n- b\n'],
    ['{% if n > 3 %}big{% else %}small{% endif %}', { n: 5 }, 'big'],
    ['{% if n > 3 %}big{% else %}small{% endif %}', { n: 1 }, 'small'],
    ['{{ name | upper }}', { name: 'abc' }, 'ABC'],
    ['{{ p | round(2) }}', { p: 3.14159 }, '3.14'],
    ['{{ xs | join(", ") }}', { xs: [1, 2, 3] }, '1, 2, 3'],
    ['{{ missing | default("none") }}', {}, 'none'],
    ['{% for i in items %}{{ i.name }}:{{ i.price }};{% endfor %}', { items: [{ name: 'x', price: 9 }] }, 'x:9;'],
    ['{% for r in rows %}{% for c in r %}{{ c }}|{% endfor %}{% endfor %}', { rows: [[1, 2], [3]] }, '1|2|3|'],
    ['{% set t = 0 %}{% for x in xs %}{% set t = t + x %}{% endfor %}{{ t }}', { xs: [1, 2, 3] }, '6'],
  ]
  for (const [template, context, expected] of cases) {
    const result = renderJinja(template, context)
    assert.equal(result.ok, true, `expected ${template} to render`)
    assert.equal(result.text, expected, `wrong render for ${template}`)
  }
  console.log(`ok 3 — ${cases.length} Jinja2 constructs render correctly (for/if/filters/set/nested)`)
}

// 3b. Jinja2 filters nunjucks lacks are provided (map / tojson / items / unique),
//     plus the keyword-argument form of `sum`, which nunjucks otherwise NaNs.
{
  const items = [{ n: 'b', p: 2 }, { n: 'a', p: 1 }, { n: 'a', p: 1 }]
  const cases = [
    ['{{ items | map(attribute="n") | join(",") }}', 'b,a,a'],
    ['{{ items | map(attribute="n") | unique | join(",") }}', 'b,a'],
    ['{{ items | map(attribute="n") | tojson }}', '["b","a","a"]'],
    ['{{ xs | unique | sort | join(",") }}', '1,3'],
    ['{{ d | items | list | length }}', '2'],
    ['{{ items | sum(attribute="p") }}', '4'],
    ['{{ items | sum("p") }}', '4'],
    ['{{ items | sum(attribute="p", start=10) }}', '14'],
    ['{{ [1,2,3] | sum }}', '6'],
  ]
  const context = { items, xs: [3, 1, 1], d: { a: 1, b: 2 } }
  for (const [template, expected] of cases) {
    const result = renderJinja(template, context)
    assert.equal(result.ok, true, `expected ${template} to render`)
    assert.equal(result.text, expected, `wrong render for ${template}`)
  }
  console.log('ok 3b — map/tojson/items/unique and keyword-argument sum work')
}


{
  const inspection = graphWithTemplate('{{#s.name#}} has {{ items | length }} items', ['items'])
  assert.equal(invalidRows(inspection).length, 0)
  // The compiled script must substitute the selector before handing the text
  // to the Jinja runtime, not pass `{{#...#}}` through to nunjucks.
  const yaml = `
app: { name: probe, mode: workflow }
kind: app
workflow:
  graph:
    nodes:
      - id: s
        type: custom
        data: { type: start, title: start, variables: [{ variable: items, label: i, type: array, required: true }] }
      - id: t
        type: custom
        data:
          type: template-transform
          title: tmpl
          template: '{{#s.items#}} count={{ items | length }}'
          variables: [{ variable: items, value_selector: [s, items] }]
      - id: e
        type: custom
        data: { type: end, title: end, outputs: [{ variable: output, value_selector: [t, output] }] }
    edges:
      - { id: e1, source: s, target: t }
      - { id: e2, source: t, target: e }
`
  const script = compileGraph(parseDifyDsl(yaml)).script
  // Only `{{#...#}}` is substituted here; `{{ items | length }}` stays intact
  // for nunjucks, which is exactly Dify's two-layer order.
  assert.match(script, /const __tpl = \(__text\(args\["items"\]\) \+ " count=\{\{ items \| length \}\}"\)/, 'the selector must be substituted, Jinja left intact')
  assert.match(script, /__ctx\["items"\] = args\["items"\]/, 'the variable context must carry the real value')
  assert.match(script, /__jinja\(__tpl, __ctx/, 'the substituted text goes to the Jinja runtime')
  console.log('ok 4 — selector substitution precedes Jinja rendering')
}

// ---------------------------------------------------------------- failure policy
// 5. An unrenderable template FAILS rather than emitting raw text.
{
  const result = renderJinja('{% for x in items %}{{ x }}', { items: [1] })
  assert.equal(result.ok, false, 'a broken template must not render')
  assert.match(result.error, /unexpected end of file/)
  console.log('ok 5 — a broken template returns an error, never the raw text')
}

// 6. An unknown filter fails.
{
  const result = renderJinja('{{ x | nosuchfilter }}', { x: 1 })
  assert.equal(result.ok, false)
  assert.match(result.error, /filter not found|nosuchfilter/i)
  console.log('ok 6 — an unknown filter fails the render')
}

// 7. The error names the line and the offending source.
{
  const result = renderJinja('ok line\n{% for x in y %}{{ x }}', { y: [1] })
  assert.equal(result.ok, false)
  console.log('ok 7 — render errors carry position information')
}

// ---------------------------------------------------------------- compile-time
// 8. A syntax error is reported at inspect time, before any run.
{
  const inspection = graphWithTemplate('{% for x in items %}{{ x }}')
  const rows = invalidRows(inspection)
  assert.equal(rows.length, 1, 'a broken template must be reported by inspect')
  assert.match(rows[0].message, /does not compile/)
  assert.match(rows[0].message, /template error in the workflow/)
  const support = inspection.support.find((row) => row.id === 't')
  assert.equal(support.mode, 'simplified')
  assert.match(support.reason, /does not compile/)
  console.log('ok 8 — a broken template is reported by inspect (before the run)')
}

// 9. A valid Jinja template is `full` and not reported.
{
  const inspection = graphWithTemplate('{% for x in items %}- {{ x }}{% endfor %}', ['items'])
  assert.equal(invalidRows(inspection).length, 0, 'a valid template must not be reported')
  assert.equal(inspection.support.find((row) => row.id === 't').mode, 'full')
  console.log('ok 9 — a valid Jinja template compiles clean and is reported as full')
}

// 10. Compile-time diagnostics never become compile issues.
{
  const inspection = graphWithTemplate('{% for x in items %}{{ x }}')
  assert.deepEqual(inspection.issues, [], 'diagnostics must never fail compilation')
  console.log('ok 10 — template diagnostics stay advisory, never a compile issue')
}

// 11. compileJinja distinguishes valid from invalid without rendering.
{
  assert.equal(compileJinja('{% for x in y %}{{ x }}{% endfor %}'), undefined)
  assert.notEqual(compileJinja('{% for x in y %}{{ x }}'), undefined)
  console.log('ok 11 — compileJinja checks syntax without executing the template')
}

// ---------------------------------------------------------------- safety
// 12. Prototype-chain access is blocked (see README security note).
{
  const escape = renderJinja('{{ a["constructor"]["constructor"]("return process")() }}', { a: '' })
  // Either it fails or it yields nothing useful — but it must never return `process`.
  assert.equal(escape.ok, false, 'prototype escape must not render')
  const plain = renderJinja('{{ name }}', { name: 'abc' })
  assert.equal(plain.ok, true)
  assert.equal(plain.text, 'abc', 'the guard must not break normal lookups')
  console.log('ok 12 — prototype-chain access is blocked; normal lookups still work')
}

// 13. The shipped DSL samples still report nothing.
{
  for (const file of readdirSync(DSL).filter((name) => name.endsWith('.yml'))) {
    const inspection = inspectGraph(parseDifyDsl(readFileSync(`${DSL}/${file}`, 'utf8')))
    const rows = invalidRows(inspection)
    assert.equal(rows.length, 0, `${file} unexpectedly reports a template error: ${JSON.stringify(rows)}`)
  }
  console.log('ok 13 — no shipped sample reports a template error')
}

console.log('TEMPLATE JINJA TESTS OK')
