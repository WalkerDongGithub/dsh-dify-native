import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { realHarness } from './helpers/real-harness.mjs'
import { startEventRuntime } from '../lib/event-runtime.js'
const cwd=mkdtempSync(join(process.cwd(),'.tmp-schedule-visual-')),schedules=[]
for(const [frequency,visual_config] of [['hourly',{on_minute:15}],['daily',{time:'9:00 AM'}],['weekly',{time:'9:00 AM',weekdays:['sat']}],['monthly',{time:'9:00 AM',monthly_days:['last']}]]) {
 const path=join(cwd,frequency+'.json');writeFileSync(path,JSON.stringify({app:{name:frequency,mode:'workflow'},workflow:{graph:{nodes:[{id:'t',data:{type:'trigger-schedule',mode:'visual',frequency,visual_config,timezone:'UTC'}},{id:'e',data:{type:'end',outputs:[{variable:'at',value_selector:['t','triggered_at']}]}}],edges:[{source:'t',target:'e'}]}}}));schedules.push({id:frequency,workflow:path,start_at:'2026-10-31T08:59:00.000Z'})
}
const h=await realHarness(cwd);let runtime
try {
 runtime=await startEventRuntime(h.ctx,{routes:[],schedules,stateDir:join(cwd,'state'),port:0},h.parent)
 const results=await runtime.tick(new Date('2026-10-31T09:15:00.000Z'));assert.equal(results.length,4)
 for(const r of results){assert.equal(r.status,'succeeded',r.error);assert.equal(r.outputs.at,r.appName==='hourly'?'2026-10-31T09:15:00.000Z':'2026-10-31T09:00:00.000Z')}
 console.log('VISUAL SCHEDULE ENGINE OK: hourly/daily/weekly/monthly-last official conversion')
}finally{await runtime?.close();await h.close();rmSync(cwd,{recursive:true,force:true})}
