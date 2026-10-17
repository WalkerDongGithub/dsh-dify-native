import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-extraction-diff-'))
const python=process.env.DIFY_RUNTIME_PYTHON??'python3'
try {
 execFileSync(python,['tests/helpers/extraction-reference.py',cwd],{env:{...process.env,PYTHONPATH:[resolve('.vendor-extraction'),process.env.DIFY_PYTHONPATH].filter(Boolean).join(':')}})
 const expected=JSON.parse(readFileSync(join(cwd,'expected.json'),'utf8'))
 const h=await realHarness(cwd)
 try {
  for(const [file,text] of Object.entries(expected)) {
   const c=compileGraph({appName:'extract-differential',mode:'workflow',nodes:[{id:'s',data:{type:'start',variables:[{variable:'file'}]}},{id:'x',data:{type:'document-extractor',variable_selector:['s','file']}},{id:'e',data:{type:'end',outputs:[{variable:'text',value_selector:['x','text']}]}}],edges:[{source:'s',target:'x'},{source:'x',target:'e'}]})
   const run=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args:{file},parent:h.parent,subagentProvider:'dify-node'})
   try{const r=await run.result;assert.equal(r.stopReason,'completed',`${file}: ${r.error}`);assert.equal(r.value.outputs.text,text,`${file}: fixed official extractor output`)}finally{await run.dispose()}
  }
  console.log('EXTRACTION DIFFERENTIAL ENGINE OK: 8 formats, exact fixed official outputs')
 }finally{await h.close()}
}finally{rmSync(cwd,{recursive:true,force:true})}
