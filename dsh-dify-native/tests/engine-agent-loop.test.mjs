import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-agent-loop-'));let hits=0
const server=createServer((req,res)=>{hits++;res.setHeader('content-type','application/json');res.end('{"value":42}')});await new Promise(r=>server.listen(0,'127.0.0.1',r))
writeFileSync(join(cwd,'tool.yaml'),`provider: test\ntool: lookup\nparameters:\n  - {name: key, required: true}\nrequest: {url: 'http://127.0.0.1:${server.address().port}/lookup'}\n`)
process.env.DIFY_TOOLS_ROOT=cwd;process.env.DIFY_TOOL_ALLOW='test/lookup'
const h=await realHarness(cwd);let queue=[],calls=[]
h.ctx.provide('llm',{listProviders:()=>[{id:'test'}],async *stream(options){calls.push(options);assert.ok(queue.length);yield {type:'text-delta',text:queue.shift()};yield {type:'usage',usage:{inputTokens:2,outputTokens:3,totalTokens:5}};yield {type:'finish',reason:{kind:'stop'}}}})
async function run(replies,limit=3,signal) {
 queue=[...replies];calls=[]
 const c=compileGraph({appName:'agent-tools',mode:'workflow',nodes:[{id:'s',data:{type:'start'}},{id:'a',data:{type:'agent',agent_strategy_name:'dsh-bounded-tools',model:{provider:'test',name:'fixture'},agent_parameters:{instruction:{value:'Use declared tools to find answer'},maximum_iterations:{value:limit},tools:{value:[{provider_name:'test',tool_name:'lookup',parameters_schema:{type:'object',required:['key'],properties:{key:{type:'string'}},additionalProperties:false}}]}}}},{id:'e',data:{type:'end',outputs:[{variable:'text',value_selector:['a','text']},{variable:'usage',value_selector:['a','usage']},{variable:'json',value_selector:['a','json']},{variable:'files',value_selector:['a','files']}]}}],edges:[{source:'s',target:'a'},{source:'a',target:'e'}]})
 const r=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{},parent:h.parent,subagentProvider:'dify-node',signal});try{return await r.result}finally{await r.dispose()}
}
const tool=(id='1',name='lookup',args={key:'x'})=>JSON.stringify({tool_calls:[{id,name,arguments:args}]})
try {
 let r=await run([tool(),'The answer is 42']);assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.text,'The answer is 42');assert.equal(hits,1);assert.equal(calls.length,2);assert.match(JSON.stringify(calls[1].messages),/42/);assert.equal(r.value.outputs.usage.total_tokens,10);assert.ok(Array.isArray(r.value.outputs.json));assert.deepEqual(r.value.outputs.files,[])
 for(const reply of [tool('2','undeclared'),tool('3','lookup',{key:2})]) {const before=hits;r=await run([reply]);assert.equal(r.stopReason,'error');assert.match(r.error,/declared|schema/);assert.equal(hits,before)}
 const before=hits;r=await run([tool('same'),tool('same')]);assert.equal(r.stopReason,'error');assert.match(r.error,/duplicate/);assert.equal(hits,before+1)
 r=await run([tool('limited')],1);assert.equal(r.stopReason,'error');assert.match(r.error,/iteration limit/)
 const controller=new AbortController();controller.abort();const prev=hits;r=await run([tool()],3,controller.signal);assert.notEqual(r.stopReason,'completed');assert.equal(hits,prev)
 console.log('AGENT LOOP ENGINE OK: real HTTP tool feedback, bounds, schema, duplicates, cancellation, output shape')
}finally{await h.close();await new Promise(r=>server.close(r));delete process.env.DIFY_TOOLS_ROOT;delete process.env.DIFY_TOOL_ALLOW;rmSync(cwd,{recursive:true,force:true})}
