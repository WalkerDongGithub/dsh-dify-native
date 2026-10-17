import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-events-'))
function graph(type) {return {app:{name:'event',mode:'workflow'},workflow:{graph:{nodes:[{id:'t',data:{type,method:'POST',content_type:'application/json',headers:[{name:'X-Topic'}],params:[{name:'q'}],body:[{name:'value'}],variables:[{variable:'topic'}]}},{id:'e',data:{type:'end',outputs:[{variable:'value',value_selector:['t','value']},{variable:'header',value_selector:['t','X_Topic']},{variable:'query',value_selector:['t','q']},{variable:'topic',value_selector:['t','topic']}]}}],edges:[{source:'t',target:'e'}]}}}}
for(const [name,type] of [['hook','trigger-webhook'],['plain','trigger'],['plugin','trigger-plugin']])writeFileSync(join(cwd,`${name}.json`),JSON.stringify(graph(type)))
process.env.S_GAP_EVENT_TOKEN='fixture'
const config={host:'127.0.0.1',port:0,stateDir:join(cwd,'event-state'),routes:[{id:'hook',endpoint:'/hook',workflow:join(cwd,'hook.json'),token_env:'S_GAP_EVENT_TOKEN'},{id:'plain',endpoint:'/plain',workflow:join(cwd,'plain.json'),token_env:'S_GAP_EVENT_TOKEN',inputs:{topic:'body.value'}},{id:'plugin',endpoint:'/plugin',workflow:join(cwd,'plugin.json'),token_env:'S_GAP_EVENT_TOKEN',bridge:true,inputs:{topic:'body.value'},signature_env:'S_GAP_EVENT_TOKEN'}]}
const configPath=join(cwd,'events.json');writeFileSync(configPath,JSON.stringify(config))
const h=await realHarness(cwd)
try {
 const tool=h.ctx.tools.get('dify_native_events');assert.ok(tool,'real plugin must expose event deployment tool')
 const active=await tool.execute({configPath},{agent:h.parent});assert.ok(active.url)
 const send=async(path,id,extra={})=>fetch(active.url+path,{method:'POST',headers:{Authorization:'Bearer fixture','X-Event-ID':id,'X-Topic':'deploy','content-type':'application/json',...extra},body:'{"value":"actual event"}'})
 let response=await send('/hook','1');assert.equal(response.status,200);let result=await response.json();assert.equal(result.status,'succeeded',result.error);assert.equal(result.support.find(n=>n.id==='t').mode,'simplified');assert.equal(result.nodes.t.outputs['sys.conversation_id'],h.parent.session.id);assert.deepEqual(result.outputs,{value:'actual event',header:'deploy',query:null,topic:null})
 response=await send('/hook?q=real','2');result=await response.json();assert.equal(result.outputs.query,'real')
 response=await send('/hook','1');assert.equal(response.status,200);assert.equal((await response.json()).duplicate,true)
 response=await send('/plain','3');result=await response.json();assert.equal(result.outputs.topic,'actual event')
 response=await send('/plain','4',{Authorization:'Bearer wrong'});assert.equal(response.status,401)
 response=await send('/plugin','5');assert.equal(response.status,401)
 const {createHmac}=await import('node:crypto');const signature=createHmac('sha256','fixture').update('5.{"value":"actual event"}').digest('hex')
 response=await send('/plugin','5',{'X-Event-Signature':signature});result=await response.json();assert.equal(result.status,'succeeded',result.error);assert.equal(result.outputs.topic,'actual event');assert.equal(result.event.native_plugin_subscription,false)
 console.log('EVENT ENGINE OK: live HTTP, configured fields, auth, dedup, trigger and signed plugin bridges')
}finally{await h.close();delete process.env.S_GAP_EVENT_TOKEN;rmSync(cwd,{recursive:true,force:true})}
