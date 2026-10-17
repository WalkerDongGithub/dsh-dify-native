/** Regression: nested containers must execute through the real workflow engine. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'

const cwd = mkdtempSync(fileURLToPath(new URL('../.tmp-nested-', import.meta.url)))
const h = await realHarness(cwd)
try {
  for (const explicitParent of [false, true]) {
    const nodes = [
      ['s', { type: 'start', variables: [{ variable: 'rows', required: true }] }],
      ['outer', { type: 'iteration', iterator_selector: ['s', 'rows'], output_selector: ['inner', 'output'], start_node_id: 'os' }],
      ['os', { type: 'iteration-start', iteration_id: 'outer' }],
      ['inner', { type: 'iteration', iterator_selector: ['os', 'item'], output_selector: ['cell', 'output'], start_node_id: 'is', is_parallel: true, ...(explicitParent ? { iteration_id: 'outer' } : {}) }],
      ['is', { type: 'iteration-start', iteration_id: 'inner' }],
      ['cell', { type: 'template-transform', iteration_id: 'inner', template: '{{ value }}!', variables: [{ variable: 'value', value_selector: ['is', 'item'] }] }],
      ['e', { type: 'end', outputs: [{ variable: 'result', value_selector: ['outer', 'output'] }] }],
    ].map(([id, data]) => ({ id, data }))
    const edges = [['s', 'outer'], ['os', 'inner'], ['is', 'cell'], ['outer', 'e']].map(([source, target]) => ({ source, target, sourceHandle: 'source' }))
    const compiled = compileGraph({ appName: 'nested-e2e', mode: 'workflow', nodes, edges })
    const run = h.ctx.workflowEngine.start({ meta: compiled.meta, script: compiled.script, args: { rows: [['a', 'b'], ['c', 'd']] }, parent: h.parent, subagentProvider: 'dify-node' })
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'completed', result.error)
      assert.equal(result.agentsStarted, 4)
      assert.deepEqual(result.value.outputs, { result: [['a!', 'b!'], ['c!', 'd!']] })
    } finally { await run.dispose() }
  }
  console.log('NESTED ENGINE E2E OK: explicit and inferred container ownership')
} finally {
  await h.close()
  rmSync(cwd, { recursive: true, force: true })
}
