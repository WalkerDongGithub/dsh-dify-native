import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-http-follow-'))
const server=createServer((req,res)=>res.end('real response'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const h=await realHarness(cwd)
try {
 const c=compileGraph({appName:'http-follow',mode:'workflow',nodes:[{id:'s',data:{type:'start'}},{id:'http',data:{type:'http-request',method:'post',url:`http://127.0.0.1:${server.address().port}/`}},{id:'next',data:{type:'template-transform',template:'after {{#http.body#}}',variables:[]}},{id:'e',data:{type:'end',outputs:[{variable:'text',value_selector:['next','output']}]}}],edges:[{source:'s',target:'http'},{source:'http',target:'next'},{source:'next',target:'e'}]})
 const run=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{},parent:h.parent,subagentProvider:'dify-node'});try{const r=await run.result;assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.text,'after real response')}finally{await run.dispose()}
 console.log('HTTP FOLLOW ENGINE OK: ordinary HTTP success reaches downstream node')
}finally{await h.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
