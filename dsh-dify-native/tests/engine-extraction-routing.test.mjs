import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-routing-'))
execFileSync(process.env.DIFY_RUNTIME_PYTHON??'python3',['tests/helpers/extraction-reference.py',cwd],{env:{...process.env,PYTHONPATH:[process.env.DIFY_EXTRACTION_VENDOR??resolve('.vendor-extraction'),process.env.DIFY_PYTHONPATH].filter(Boolean).join(':')}})
const cases=JSON.parse(readFileSync(join(cwd,'route-cases.json'),'utf8'))
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/vtt');res.end(readFileSync(join(cwd,'data.vtt'))) });await new Promise(r=>server.listen(0,'127.0.0.1',r))
const h=await realHarness(cwd)
async function run(files){const c=compileGraph({appName:'route',mode:'workflow',nodes:[{id:'s',data:{type:'start',variables:[{variable:'files'}]}},{id:'x',data:{type:'document-extractor',variable_selector:['s','files']}},{id:'e',data:{type:'end',outputs:[{variable:'text',value_selector:['x','text']}]}}],edges:[{source:'s',target:'x'},{source:'x',target:'e'}]});const run=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{files},parent:h.parent,subagentProvider:'dify-node'});try{return await run.result}finally{await run.dispose()}}
try {
 // Official extension routing wins: .vtt stays plain text.
 let r=await run('data.vtt');assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.text,readFileSync(join(cwd,'data.vtt'),'utf8'))
 // Parameterized exact comparison for EVERY plain extension in the official AST,
 // plus MIME-only local PDF/Office/text routes, in one real engine array call.
 r=await run(cases.map(c=>c.file));assert.equal(r.stopReason,'completed',r.error);assert.deepEqual(r.value.outputs.text,cases.map(c=>c.expected))
 const vtt=cases.find(c=>c.file?.mime_type==='text/vtt')
 r=await run({url:`http://127.0.0.1:${server.address().port}/no-extension`});assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.text,vtt.expected)
 // Explicit extension takes priority over MIME even on a filename with no suffix.
 r=await run({path:'mime-data-vtt',extension:'.vtt',mime_type:'text/vtt'});assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.text,readFileSync(join(cwd,'data.vtt'),'utf8'))
 r=await run({path:'mime-data-vtt',extension:'.unknown',mime_type:'text/plain'});assert.equal(r.stopReason,'error');assert.match(r.error,/Unsupported|unsupported/)
 writeFileSync(join(cwd,'bad.doc'),'unavailable legacy converter')
 r=await run(['data.vtt',{path:'bad.doc',mime_type:'text/plain'}]);assert.equal(r.stopReason,'error');assert.match(r.error,/conversion|unstructured/)
 console.log(`EXTRACTION ROUTING ENGINE OK: ${cases.length-8} official plain extensions + 8 MIME routes, extension priority, remote MIME, mixed failure`)
}finally{await h.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
