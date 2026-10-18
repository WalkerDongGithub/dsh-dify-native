import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { realHarness } from './helpers/real-harness.mjs'
const root = mkdtempSync(join(tmpdir(),'dify-mixed-'))
let h
try {
 h = await realHarness(root)
 h.ctx.provide('llm',{stream(){throw Error('unexpected model request')}})
 const cases = [
  ['{{ base }}{{ id }}', {base:'https://example.test/videos/',id:'abc-123'}, 'https://example.test/videos/abc-123'],
  ['{{#s.prefix#}}/{{ base }}{{ id }}', {prefix:'poll',base:'https://example.test/videos/',id:'abc-123'}, 'poll/https://example.test/videos/abc-123'],
  ['{% for base in items %}{{ base }};{% endfor %}|{{ base }}', {items:['a','b'],base:'outside'}, 'a;b;|outside'],
  ['{{ base }}|{{ id | upper }}', {base:'{{ id }}',id:'abc'}, '{{ id }}|ABC'],
  ['{{#s.prefix#}}/{{ base }}', {prefix:'head',base:'{% if x %}literal{% endif %}'}, 'head/{% if x %}literal{% endif %}'],
  ['{{#s.base#}}{{#s.id#}}', {base:'https://example.test/',id:'abc'}, 'https://example.test/abc'],
 ]
 for (const [index,[template,inputs,expected]] of cases.entries()) {
  const path=join(root,`mixed-${index}.yml`)
  writeFileSync(path,JSON.stringify({app:{name:'mixed',mode:'workflow'},workflow:{graph:{nodes:[
   {id:'s',data:{type:'start',variables:Object.keys(inputs).map(variable=>({variable,type:'text-input'}))}},
   {id:'t',data:{type:'template-transform',template,variables:Object.keys(inputs).map(variable=>({variable,value_selector:['s',variable]}))}},
   {id:'e',data:{type:'end',outputs:[{variable:'out',value_selector:['t','output']}]}}
  ],edges:[{source:'s',target:'t'},{source:'t',target:'e'}]}}}))
  const result=await h.run(path,inputs)
  assert.equal(result.status,'succeeded',result.error)
  assert.equal(result.outputs.out,expected,template)
 }
 console.log('MIXED TEMPLATE OK: real harness selector/local/loop binding/syntax-containing values/inline path; no model calls')
} finally { if(h) await h.close(); rmSync(root,{recursive:true,force:true}) }
