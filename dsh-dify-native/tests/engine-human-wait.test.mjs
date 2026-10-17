import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-human-'));let effects=0
const server=createServer((req,res)=>{effects++;res.end('effect committed')});await new Promise(r=>server.listen(0,'127.0.0.1',r))
function workflow(timeout=1) {return {app:{name:'wait',mode:'workflow'},workflow:{graph:{nodes:[{id:'s',data:{type:'start'}},{id:'effect',data:{type:'http-request',method:'post',url:`http://127.0.0.1:${server.address().port}/effect`}},{id:'h',data:{type:'human-input',form_content:'Review {{#$output.comment#}}',timeout,timeout_unit:'hour',inputs:[{output_variable_name:'comment',type:'paragraph',default:{type:'constant',value:'default'}}],user_actions:[{id:'approve',title:'Approved'},{id:'reject',title:'Rejected'}]}},{id:'yes',data:{type:'template-transform',template:'approved {{#h.comment#}}',variables:[]}},{id:'no',data:{type:'template-transform',template:'rejected',variables:[]}},{id:'expired',data:{type:'template-transform',template:'expired',variables:[]}},{id:'agg',data:{type:'variable-aggregator',variables:[['yes','output'],['no','output'],['expired','output']]}},{id:'e',data:{type:'end',outputs:[{variable:'result',value_selector:['agg','output']},{variable:'action',value_selector:['h','__action_value']},{variable:'form',value_selector:['h','__rendered_content']}]}}],edges:[{source:'s',target:'effect'},{source:'effect',target:'h'},{source:'h',target:'yes',sourceHandle:'approve'},{source:'h',target:'no',sourceHandle:'reject'},{source:'h',target:'expired',sourceHandle:'__timeout'},{source:'yes',target:'agg'},{source:'no',target:'agg'},{source:'expired',target:'agg'},{source:'agg',target:'e'}]}}}}
const path=join(cwd,'human.json');writeFileSync(path,JSON.stringify(workflow()))
let h=await realHarness(cwd)
try {
 let r=await h.run(path);assert.equal(r.status,'waiting',r.error);assert.equal(effects,1);assert.ok(r.pendingId);assert.deepEqual(r.outputs,{})
 const pendingId=r.pendingId,session=h.parent.session
 const blocked=await h.run(path);assert.equal(blocked.status,'failed');assert.match(blocked.error,/pending|waiting/);assert.equal(effects,1)
 await h.close();h=await realHarness(cwd)
 const resume=h.ctx.tools.get('dify_native_resume');assert.ok(resume)
 r=await resume.execute({pendingId,action:'invalid'},{agent:{session}});assert.equal(r.status,'rejected');assert.equal(effects,1)
 r=await resume.execute({pendingId,action:'approve',inputs:{comment:'human supplied'}},{agent:{session}});assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.result,'approved human supplied');assert.equal(r.outputs.action,'Approved');assert.equal(r.nodes.h.meta.autoResolved,false);assert.equal(r.outputs.form,'Review human supplied');assert.equal(effects,1,'resume must never replay upstream HTTP')
 r=await resume.execute({pendingId,action:'approve',inputs:{comment:'human supplied'}},{agent:{session}});assert.equal(r.status,'succeeded',r.error);assert.equal(r.duplicate,true);assert.equal(effects,1)
 writeFileSync(path,JSON.stringify(workflow(0)));r=await h.run(path);assert.equal(r.status,'waiting');const expired=r.pendingId
 r=await resume.execute({pendingId:expired},{agent:h.parent});assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.result,'expired');assert.equal(r.outputs.action,'');assert.equal(effects,2)
 console.log('HUMAN WAIT ENGINE OK: durable waiting, restart resume, form/actions, timeout, no side-effect replay')
}finally{await h.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
