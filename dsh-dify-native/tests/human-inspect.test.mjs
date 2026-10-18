import assert from 'node:assert/strict'
import { parseDifyDsl, inspectGraph, compileGraph } from '../lib/dsl.js'
const node = (id, type, data = {}, parentId) => ({ id, ...(parentId ? {parentId} : {}), data: {type, ...data} })
function graph(type, nested = false, parentStyle = 'parentId', containerKind = 'iteration') {
 const h = node('h', 'human-input', {inputs: [{type, output_variable_name: 'choice'}], user_actions: [{id: 'ok', title: 'OK'}]}, nested ? 'iter' : undefined)
 if (nested && parentStyle === 'iteration_id') { delete h.parentId; h.data[containerKind === 'iteration' ? 'iteration_id' : 'loop_id'] = 'iter' }
 return parseDifyDsl(JSON.stringify({app: {name: 'human-inspect', mode: 'workflow'}, workflow: {graph: {
 nodes: [node('s', 'start', {variables: []}), ...(nested ? [node('iter', containerKind, {iterator_selector: ['s','items'], start_node_id: 'mark', output_selector: ['h','choice']}), node('mark', `${containerKind}-start`, {}, 'iter')] : []), h, node('e','end',{outputs: []})],
 edges: nested ? [{source:'s',target:'iter'}, {source:'iter',target:'e'}, {source:'mark',target:'h'}] : [{source:'s',target:'h'}, {source:'h',sourceHandle:'ok',target:'e'}]
 }}}))
}
for (const type of ['select', 'file', 'number']) {
 const g = graph(type), result = inspectGraph(g)
 assert.equal(result.support.find(n=>n.id==='h').mode, 'rejected')
 assert.ok(result.diagnostics.some(d=>d.code==='node-unsupported' && d.subject.includes('h:') && d.message.includes('text')))
 assert.throws(()=>compileGraph(g), /form fields are unsupported/)
}
for (const containerKind of ['iteration', 'loop']) for (const style of ['parentId', 'iteration_id']) {
 const g = graph('paragraph', true, style, containerKind), result = inspectGraph(g)
 assert.equal(result.support.find(n=>n.id==='h').mode, 'rejected')
 assert.ok(result.deviations.some(d=>d.nodeId==='h' && d.where==='nested in iteration/loop' && d.bites))
 assert.throws(()=>compileGraph(g), /inside iteration\/loop/)
}
for (const type of ['paragraph', 'text-input', 'text_input', undefined]) {
 const g = graph(type), result = inspectGraph(g)
 assert.notEqual(result.support.find(n=>n.id==='h').mode, 'rejected')
 assert.ok(!result.diagnostics.some(d=>d.code==='node-unsupported' && d.subject.includes('h:')))
 assert.doesNotThrow(()=>compileGraph(g))
}
console.log('HUMAN INSPECT OK: unsupported fields/nesting rejected, valid text forms accepted')
