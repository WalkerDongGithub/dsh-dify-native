import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd = mkdtempSync(join(process.cwd(), '.tmp-extraction-'))
writeFileSync(join(cwd, 'a.txt'), 'alpha')
writeFileSync(join(cwd, 'b.txt'), '')
writeFileSync(join(cwd, 'long.txt'), 'x'.repeat(2_010_000))
execFileSync(process.env.DIFY_RUNTIME_PYTHON ?? 'python3', ['tests/helpers/extraction-reference.py', cwd], { env: { ...process.env, PYTHONPATH: [join(process.cwd(), '.vendor-extraction'), process.env.DIFY_PYTHONPATH].filter(Boolean).join(':') } })
const { readFileSync } = await import('node:fs')
const server = createServer((req,res) => { if(req.url === '/missing.pdf') {res.writeHead(404);res.end('missing');return} res.setHeader('content-type','application/pdf'); res.end(readFileSync(join(cwd,'real.pdf'))) })
await new Promise(r => server.listen(0,'127.0.0.1',r))
const h = await realHarness(cwd)
async function run(files) {
 const c=compileGraph({appName:'extract',mode:'workflow',nodes:[{id:'s',data:{type:'start',variables:[{variable:'files'}]}},{id:'x',data:{type:'document-extractor',variable_selector:['s','files']}},{id:'e',data:{type:'end',outputs:[{variable:'text',value_selector:['x','text']}]}}],edges:[{source:'s',target:'x'},{source:'x',target:'e'}]})
 const r=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{files},parent:h.parent,subagentProvider:'dify-node'})
 try{return await r.result}finally{await r.dispose()}
}
try {
 let r=await run(['a.txt','b.txt']); assert.equal(r.stopReason,'completed',r.error); assert.deepEqual(r.value.outputs.text,['alpha',''])
 r=await run('long.txt'); assert.equal(r.stopReason,'completed',r.error); assert.equal(r.value.outputs.text.length,2_010_000)
 for(const [file,text] of [['real.pdf','Actual PDF'],['real.docx','Actual Office'],['real.xlsx','Ada']]) {r=await run(file);assert.equal(r.stopReason,'completed',r.error);assert.match(r.value.outputs.text,new RegExp(text))}
 r=await run({url:`http://127.0.0.1:${server.address().port}/real.pdf`,extension:'.pdf'});assert.equal(r.stopReason,'completed',r.error);assert.match(r.value.outputs.text,/Actual PDF/)
 for(const input of [['a.txt','absent.txt'],{url:`http://127.0.0.1:${server.address().port}/missing.pdf`,extension:'.pdf'},'unknown.bin']) {r=await run(input);assert.equal(r.stopReason,'error');assert.match(r.error,/document-extractor/)}
 writeFileSync(join(cwd,'binary.txt'),Buffer.from([0,255,1,0]));r=await run('binary.txt');assert.equal(r.stopReason,'error');assert.match(r.error,/binary|decode/)
 console.log('EXTRACTION ENGINE OK: arrays, full text, PDF/Office, remote bytes, failures')
} finally {await h.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
