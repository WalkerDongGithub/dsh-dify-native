import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { compileGraph } from '../lib/dsl.js'
import { realHarness } from './helpers/real-harness.mjs'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-datasource-'));writeFileSync(join(cwd,'a.txt'),'source text')
let hits=0
const server=createServer((req,res)=>{hits++;assert.equal(req.headers.authorization,'Bearer fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify({title:'Remote',content:'Page text',page_id:'page-1'}))})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
writeFileSync(join(cwd,'page.yaml'),`provider: cloud\ntool: page\nparameters:\n  - {name: page_id, required: true}\n  - {name: token, form: form, required: true}\nrequest:\n  url: http://127.0.0.1:${server.address().port}/page\n  headers: {Authorization: 'Bearer {{credentials.token}}'}\n  query: {id: '{{parameters.page_id}}'}\nresponse:\n  variables: {title: '{{response.title}}', content: '{{response.content}}', page_id: '{{response.page_id}}'}\n`)
process.env.DIFY_DATASOURCES_ROOT=cwd
const h=await realHarness(cwd)
async function run(data,args={}) {
 const c=compileGraph({appName:'datasource',mode:'workflow',nodes:[{id:'ds',data:{type:'datasource',provider_name:'local/file',datasource_name:'local_file',...data}},{id:'e',data:{type:'end',outputs:[{variable:'file',value_selector:['ds','file']},{variable:'type',value_selector:['ds','datasource_type']},{variable:'title',value_selector:['ds','title']},{variable:'content',value_selector:['ds','content']}]}}],edges:[{source:'ds',target:'e'}]})
 const r=h.ctx.workflowEngine.start({meta:c.meta,script:c.script,args,parent:h.parent,subagentProvider:'dify-node'});try{return await r.result}finally{await r.dispose()}
}
try {
 let r=await run({}, {'sys.datasource_type':'local_file','sys.datasource_info':{file:{path:'a.txt',filename:'a.txt',mime_type:'text/plain',related_id:'local-1'}}});assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.type,'local_file');assert.equal(r.value.outputs.file.filename,'a.txt');assert.equal(r.value.outputs.file.size,11);assert.equal(r.value.outputs.file.transfer_method,'local_file')
 r=await run({type:'datasource-empty'},{'sys.datasource_type':'website_crawl','sys.datasource_info':{title:'Site',content:'Crawled'}});assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.title,'Site');assert.equal(r.value.outputs.content,'Crawled')
 r=await run({provider_name:'cloud',provider_type:'plugin',datasource_name:'undeclared',datasource_parameters:{path:{type:'constant',value:'a.txt'}}});assert.equal(r.stopReason,'error');assert.match(r.error,/not declared|native.*plugin/);assert.equal(hits,0)
 r=await run({provider_name:'cloud',provider_type:'plugin',datasource_name:'page',datasource_configurations:{token:'fixture'},datasource_parameters:{page_id:{type:'constant',value:'page-1'}}},{'sys.datasource_type':'online_document','sys.datasource_info':{page:{page_id:'page-1'}}});assert.equal(r.stopReason,'completed',r.error);assert.equal(r.value.outputs.title,'Remote');assert.equal(r.value.outputs.content,'Page text');assert.equal(hits,1)
 writeFileSync(join(cwd,'bad.jsonl'), '{"broken":\n');r=await run({provider_type:'builtin',datasource_parameters:{path:{type:'constant',value:'bad.jsonl'}}});assert.equal(r.stopReason,'error');assert.match(r.error,/JSON|read/)
 console.log('DATASOURCE ENGINE OK: system variables, file/website shapes, declared remote, no guessed paths')
}finally{await h.close();delete process.env.DIFY_DATASOURCES_ROOT;await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true})}
