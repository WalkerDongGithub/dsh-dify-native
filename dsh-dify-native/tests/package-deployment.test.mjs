import assert from 'node:assert/strict'
import { mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const root=process.cwd(), temp=mkdtempSync(join(tmpdir(),'dify-package-clean-'))
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:temp,encoding:'utf8',timeout:180_000,maxBuffer:2_097_152,...options})
try {
 const packed=JSON.parse(run('npm',['pack',root,'--json','--pack-destination',temp,'--cache',join(temp,'cache')]))[0]
 const paths=new Set(packed.files.map(f=>f.path))
 for(const file of ['lib/index.js','lib/extract-document.py','lib/document-parsers.py','lib/cron-slots.py','lib/schedule-parser.py','requirements-extraction.txt','requirements-events.txt','scripts/install-vendor.sh','scripts/install-extraction.sh','scripts/install-events.sh','docs/capability-report.md','docs/event-deployment.md','docs/human-wait.md']) assert.ok(paths.has(file),`npm pack must include ${file}`)
 writeFileSync(join(temp,'package.json'),'{"name":"clean-deployment","private":true,"type":"module"}')
 run('npm',['install',join(temp,packed.filename),'--ignore-scripts','--no-audit','--no-fund','--cache',join(temp,'cache')])
 const output=run(process.execPath,['--input-type=module','-e',`import {createRequire} from 'node:module'; import assert from 'node:assert/strict'; await import('./node_modules/dsh-dify-native/lib/index.js'); const require=createRequire(import.meta.url); for(const name of ['nunjucks','yaml','ajv']) { const path=require.resolve(name);assert.ok(path.startsWith(process.cwd()+'/node_modules/'),name+': '+path) } console.log('CLEAN PACKAGE IMPORT OK: declared nunjucks/yaml/ajv')`],{env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}})
 assert.match(output,/CLEAN PACKAGE IMPORT OK/)
 // Use explicit dependency paths; do not duplicate-install Python packages.
 const installed=join(temp,'node_modules/dsh-dify-native')
 const env={...process.env,PYTHONPATH:[process.env.DIFY_EXTRACTION_VENDOR??resolve(root,'.vendor-extraction'),process.env.DIFY_PYTHONPATH].filter(Boolean).join(':')}
 const result=JSON.parse(run(process.env.DIFY_RUNTIME_PYTHON??'python3',[join(installed,'lib/extract-document.py')],{env,input:JSON.stringify({bytes:readFileSync(join(root,'tests/fixtures/extraction.pdf')).toString('base64'),extension:'.pdf'})}))
 assert.equal(result.ok,true,result.error);assert.equal(result.text,'Actual PDF')
 const cron=run(process.env.DIFY_RUNTIME_PYTHON??'python3',[join(installed,'lib/cron-slots.py'),JSON.stringify({cron:'0 9 * * *',timezone:'UTC',after:'2026-10-18T08:59:00Z',until:'2026-10-18T09:00:00Z'})],{env:{...process.env,PYTHONPATH:[process.env.DIFY_EVENTS_VENDOR??resolve(root,'.vendor-events'),process.env.DIFY_PYTHONPATH].filter(Boolean).join(':')}})
 assert.deepEqual(JSON.parse(cron),['2026-10-18T09:00:00.000Z'])
 console.log(output.trim());console.log('PACKAGE DEPLOYMENT OK: packed scripts/docs/requirements, isolated npm install/import, explicit Python paths')
}finally{rmSync(temp,{recursive:true,force:true})}
