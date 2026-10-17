import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-http-timeout-'))
const timers=new Set();const server=createServer((req,res)=>{const t=setTimeout(()=>{timers.delete(t);res.end('too late')},2000);timers.add(t)});await new Promise(r=>server.listen(0,'127.0.0.1',r))
const h=await realHarness(cwd)
try {
 const c=compileGraph({appName:'http-timeout',mode:'workflow',nodes:[{id:'s',data:{type:'start'}},{id:'h',data:{type:'http-request',method:'post',url:`http://127.0.0.1:${server.address().port}/`,timeout:{connect:1,read:1,write:1},error_strategy:'fail-branch'}},{id:'yes',data:{type:'template-transform',template:'unexpected success',variables:[]}},{id:'no',data:{type:'template-transform',template:'timed out',variables:[]}},{id:'a',data:{type:'variable-aggregator',variables:[['yes','output'],['no','output']]}},{id:'e',data:{type:'end',outputs:[{variable:'result',value_selector:['a','output']}]}}],edges:[{source:'s',target:'h'},{source:'h',target:'yes',sourceHandle:'success-branch'},{source:'h',target:'no',sourceHandle:'fail-branch'},{source:'yes',target:'a'},{source:'no',target:'a'},{source:'a',target:'e'}]})
 const run=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{},parent:h.parent,subagentProvider:'dify-node'});try{const r=await run.result;assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.result,'timed out');assert.match(r.value.nodes.h.outputs.error_message,/timed out|curl exited 28/i)}finally{await run.dispose()}
 console.log('HTTP TIMEOUT ENGINE OK: official timeout.connect/read/write keys are consumed')
}finally{await h.close();for(const t of timers)clearTimeout(t);server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
