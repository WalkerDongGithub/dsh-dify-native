import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-human-form-')),path=join(cwd,'form.json')
writeFileSync(path,JSON.stringify({app:{name:'form',mode:'workflow'},workflow:{graph:{nodes:[{id:'s',data:{type:'start',variables:[{variable:'name'}]}},{id:'h',data:{type:'human-input',form_content:'Hello {{#s.name#}}: {{#$output.comment#}}',inputs:[{output_variable_name:'comment',type:'paragraph',default:{type:'variable',selector:['s','name']}}],user_actions:[{id:'ok',title:'OK'}]}},{id:'e',data:{type:'end',outputs:[{variable:'comment',value_selector:['h','comment']},{variable:'form',value_selector:['h','__rendered_content']}]}}],edges:[{source:'s',target:'h'},{source:'h',target:'e',sourceHandle:'ok'}]}}}))
const h=await realHarness(cwd)
try{
 let r=await h.run(path,{name:'Alice'});assert.equal(r.status,'waiting',r.error);assert.equal(r.pending.formContent,'Hello Alice: {{#$output.comment#}}');assert.equal(r.pending.formInputs[0].default.value,'Alice')
 const resume=h.ctx.tools.get('dify_native_resume');r=await resume.execute({pendingId:r.pendingId,action:'ok'},{agent:h.parent});assert.equal(r.status,'succeeded',r.error);assert.deepEqual(r.outputs,{comment:'Alice',form:'Hello Alice: Alice'})
 console.log('HUMAN FORM ENGINE OK: dynamic form and variable defaults survive waiting')
}finally{await h.close();rmSync(cwd,{recursive:true,force:true})}
