import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-conversation-')),path=join(cwd,'conversation.json')
writeFileSync(path,JSON.stringify({app:{name:'state',mode:'workflow'},workflow:{conversation_variables:[{name:'n',value:0}],graph:{nodes:[{id:'s',data:{type:'start'}},{id:'c',data:{type:'code',code_language:'javascript',code:'function main({n}) { return {n:n+1} }',variables:[{variable:'n',value_selector:['conversation','n']}]}},{id:'a',data:{type:'assigner',items:[{variable_selector:['conversation','n'],operation:'over-write',input_type:'variable',value:['c','n']}]}},{id:'e',data:{type:'end',outputs:[{variable:'n',value_selector:['conversation','n']}]}}],edges:[{source:'s',target:'c'},{source:'c',target:'a'},{source:'a',target:'e'}]}}}))
let h=await realHarness(cwd)
try {
 let r=await h.run(path);assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.n,1)
 r=await h.run(path);assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.n,2)
 const session=h.ctx.sessions.create('other',{meta:{cwd}})
 r=await h.ctx.tools.get('dify_native_run').execute({path},{agent:{session}});assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.n,1)
 console.log('CONVERSATION ENGINE OK: cross-run state and session isolation')
}finally{await h.close();rmSync(cwd,{recursive:true,force:true})}
