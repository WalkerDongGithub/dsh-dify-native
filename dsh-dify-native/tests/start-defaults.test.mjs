import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'
import { readFileSync } from 'node:fs'
import { realHarness } from './helpers/real-harness.mjs'
const root = mkdtempSync(join(tmpdir(), 'dify-defaults-'))
const fields = [
 {variable:'base', type:'text-input', default:'https://example.test/videos/'},
 {variable:'paragraph', type:'paragraph', default:'hello'},
 {variable:'count', type:'number', default:7},
 {variable:'choice', type:'select', default:'A'},
 {variable:'zero', type:'number', default:0},
 {variable:'empty', type:'text-input', default:''},
]
const path = join(root,'defaults.yml')
writeFileSync(path, JSON.stringify({app:{name:'defaults', mode:'workflow'}, workflow:{graph:{nodes:[
 {id:'s',data:{type:'start',variables:fields}},
 {id:'e',data:{type:'end',outputs:fields.map(f=>({variable:f.variable,value_selector:['s',f.variable]}))}},
],edges:[{source:'s',target:'e'}]}}}))
// Direct script execution also applies defaults, independently of run-tool normalization.
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
const compiled = compileGraph(parseDifyDsl(readFileSync(path,'utf8')))
const direct = await new AsyncFunction('args','phase',compiled.script)({},()=>{})
assert.deepEqual(direct.outputs,Object.fromEntries(fields.map(f=>[f.variable,f.default])))
let h
try {
 h = await realHarness(root)
 h.ctx.provide('llm',{stream(){throw Error('unexpected model request')}})
 const original = {}
 const defaults = await h.run(path, original)
 assert.equal(defaults.status,'succeeded',defaults.error)
 assert.deepEqual(defaults.outputs, Object.fromEntries(fields.map(f=>[f.variable,f.default])))
 assert.deepEqual(original,{},'do not mutate caller inputs')
 const inputs = {base:'', paragraph:'override', count:0, choice:'B', zero:2, empty:'set'}
 const explicit = await h.run(path,inputs)
 assert.equal(explicit.status,'succeeded',explicit.error)
 assert.deepEqual(explicit.outputs, inputs)
 const nil = await h.run(path,{base:null})
 assert.equal(nil.status,'succeeded',nil.error)
 assert.equal(nil.outputs.base,fields[0].default)
 // A required field without a default must still be rejected.
 const raw=JSON.parse(await (await import('node:fs/promises')).readFile(path,'utf8'))
 raw.workflow.graph.nodes[0].data.variables.push({variable:'required',type:'text-input',required:true})
 writeFileSync(path,JSON.stringify(raw))
 const missing=await h.run(path)
 assert.equal(missing.status,'rejected')
 assert.match(missing.error,/missing start inputs: required/)
 console.log('START DEFAULTS OK: real harness run, omitted/null defaults, explicit empty/zero, required validation; no model calls')
} finally { if(h) await h.close(); rmSync(root,{recursive:true,force:true}) }
