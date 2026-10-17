import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
import { startEventRuntime } from '../lib/event-runtime.js'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-schedule-')),path=join(cwd,'schedule.json')
writeFileSync(path,JSON.stringify({app:{name:'scheduled',mode:'workflow'},workflow:{graph:{nodes:[{id:'t',data:{type:'trigger-schedule',mode:'cron',cron_expression:'0 9 * * *',timezone:'Asia/Shanghai'}},{id:'e',data:{type:'end',outputs:[{variable:'at',value_selector:['t','triggered_at']}]}}],edges:[{source:'t',target:'e'}]}}}))
process.env.S_GAP_SCHEDULE_TOKEN='fixture'
const config={port:0,stateDir:join(cwd,'state'),schedules:[{id:'morning',workflow:path,cron:'0 9 * * *',timezone:'Asia/Shanghai',start_at:'2026-10-18T00:59:00.000Z'}],routes:[]}
const h=await realHarness(cwd);let runtime
try {
 runtime=await startEventRuntime(h.ctx,config,h.parent);assert.equal(typeof runtime.tick,'function','scheduler must expose real delivery tick')
 let results=await runtime.tick(new Date('2026-10-18T01:00:00.000Z'));assert.equal(results.length,1);assert.equal(results[0].status,'succeeded',results[0].error);assert.equal(results[0].outputs.at,'2026-10-18T01:00:00.000Z')
 assert.deepEqual(await runtime.tick(new Date('2026-10-18T01:00:30.000Z')),[])
 await runtime.close();runtime=await startEventRuntime(h.ctx,config,h.parent)
 results=await runtime.tick(new Date('2026-10-19T01:00:00.000Z'));assert.equal(results.length,1);assert.equal(results[0].outputs.at,'2026-10-19T01:00:00.000Z')
 console.log('SCHEDULE ENGINE OK: cron timezone, true slot timestamp, persistent dedup and restart catch-up')
}finally{await runtime?.close();await h.close();delete process.env.S_GAP_SCHEDULE_TOKEN;rmSync(cwd,{recursive:true,force:true})}
