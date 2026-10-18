/** Real installed dsh services, real PTC child process, real subagent registry,
 * real dify-node and sandbox. Only ctx.llm is scripted. No AsyncFunction runner.
 * The tool service fixture is an actual HTTP endpoint declared through the
 * deployment's supported YAML contract; this does not prove public Jina uptime.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { realHarness } from './helpers/real-harness.mjs'
import { compileGraph, parseDifyDsl } from '../lib/dsl.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSL = resolve(ROOT, 'dsl')
const TMP = mkdtempSync(join(ROOT, '.tmp-engine-'))
const envKeys = ['DIFY_TOOLS_ROOT', 'DIFY_TOOL_ALLOW', 'DIFY_KNOWLEDGE_ROOT']
const oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))
const requests = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost').searchParams.get('url')
  requests.push(url)
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: { content: `document:${url}` } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
mkdirSync(join(TMP, 'tools'))
writeFileSync(join(TMP, 'tools/jina.yaml'), `provider: jina
tool: jina_reader
parameters:
  - {name: url, type: string, required: true}
request:
  url: http://127.0.0.1:${server.address().port}/read
  query: {url: '{{parameters.url}}'}
response:
  text: '{{response}}'
`)
const dataset = 'be517915-1dd5-4d09-a67d-4d5e4e4b21a8'
mkdirSync(join(TMP, 'knowledge', dataset), { recursive: true })
writeFileSync(join(TMP, 'knowledge', dataset, 'help.md'), 'app help: reset wristband\n')
writeFileSync(join(TMP, 'records.jsonl'), '{"name":"Ada","score":9}\n{"name":"Lin","score":8}\n')
writeFileSync(join(TMP, 'doc.txt'), '真实文档 fixture\nsecond line')
process.env.DIFY_TOOLS_ROOT = join(TMP, 'tools')
process.env.DIFY_TOOL_ALLOW = 'jina/jina_reader,missing/undeclared'
process.env.DIFY_KNOWLEDGE_ROOT = join(TMP, 'knowledge')
let h
const evidence = []
let replies = [], calls = []
function llm(queue) { replies = [...queue]; calls = [] }
function parsed(file) { return parseDifyDsl(readFileSync(join(DSL, file), 'utf8')) }
async function run(file, inputs, queue = []) {
  llm(queue)
  const result = await h.run(join(DSL, file), inputs)
  assert.equal(result.status, 'succeeded', `${file}: ${result.error}`)
  assert.deepEqual(replies, [], `${file}: unused LLM replies`)
  assert.equal(result.events.filter(e => e.at === 'start').length, result.agentsStarted)
  assert.equal(result.events.filter(e => e.at === 'end').length, result.agentsStarted)
  evidence.push({ file, outputs: result.outputs, executed: Object.keys(result.nodes), support: result.support })
  return result
}
function branch(r, id, selected, present, absent) {
  assert.equal(r.nodes[id].outputs.result, selected)
  assert.ok(r.nodes[present], `${present} should execute`)
  assert.equal(r.nodes[absent], undefined, `${absent} should not execute`)
}
// Additional DSLs also go through the exact installed engine, never a local VM.
async function runGraph(graph, inputs = {}) {
  const c = compileGraph(graph)
  const handle = h.ctx.workflowEngine.start({ meta: c.meta, script: c.script, args: inputs, parent: h.parent, subagentProvider: 'dify-node' })
  try { return await handle.result } finally { await handle.dispose() }
}
function graph(nodes, edges) {
  return { appName: 'negative-and-support-e2e', mode: 'workflow', nodes: nodes.map(([id, data]) => ({ id, data })), edges: edges.map(([source, target, sourceHandle = 'source']) => ({ source, target, sourceHandle })) }
}
try {
  h = await realHarness(TMP)
  h.ctx.provide('llm', {
    listProviders: () => [{ id: 'zai' }],
    async *stream(options) {
      calls.push(options)
      assert.ok(replies.length, 'unexpected LLM request')
      yield { type: 'text-delta', text: replies.shift() }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  h.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'zai', model: 'glm-4.5-air' }) })

  // The baseline includes an actual confined Python process and its final value.
  let r = await run('json-repair.yml', { llm_string: '{name: "Ada",}' })
  assert.deepEqual(JSON.parse(r.outputs.output), { name: 'Ada' })
  assert.match(r.nodes['1732007419308'].backendArgv0, /landlock|bwrap|sandbox/)
  assert.notEqual(r.nodes['1732007419308'].enforcement, 'test')
  r = await run('jieba.yml', { 'sys.query': '你好世界' })
  assert.deepEqual(r.outputs, { answer: "['你好', '世界']" })
  r = await run('nodes-code-languages.yml', { n: 5 })
  assert.deepEqual(r.outputs, { result: 11 })
  r = await run('nodes-list-operator.yml', { rows: [{ status: 'ok', score: 1 }, { status: 'bad', score: 99 }, { status: 'ok', score: 8 }, { status: 'ok', score: 3 }] })
  assert.deepEqual(r.outputs, { result: [{ status: 'ok', score: 8 }, { status: 'ok', score: 3 }], count: 2 })
  r = await run('nodes-iteration.yml', { items: ['a', 'b', 'c'] })
  assert.deepEqual(r.outputs, { result: ['第0项: a', '第1项: b', '第2项: c'] })
  r = await run('nodes-iteration.yml', { items: [] })
  assert.deepEqual(r.outputs, { result: [] })
  assert.equal(r.agentsStarted, 0)
  r = await run('nodes-loop.yml', { rounds: 3 })
  assert.deepEqual(r.outputs, { result: [{ round: 'round-0' }, { round: 'round-1' }, { round: 'round-2' }] })
  // simplified: datasource reads local JSONL; document extraction supports text.
  r = await run('nodes-datasource.yml', {})
  assert.deepEqual(r.outputs, { result: '数据源=records 记录={"name":"Ada","score":9}' })
  assert.equal(r.nodes.ds.outputs.count, 2)
  r = await run('nodes-document-extractor.yml', { doc: 'doc.txt' })
  assert.deepEqual(r.outputs, { text: '真实文档 fixture\nsecond line' })
  assert.equal(r.nodes.ext.meta.failed, 0)
  // simplified trigger: inject an event; no webhook listener is started.
  r = await run('nodes-trigger.yml', { topic: 'deploy' })
  assert.deepEqual(r.outputs, { result: '触发主题: deploy' })
  // simplified agent: one model turn, no autonomous tools.
  r = await run('nodes-agent.yml', { task: 'say hello' }, ['研究完成'])
  assert.deepEqual(r.outputs, { answer: '研究完成' })
  assert.equal(r.nodes.agent.meta.mode, 'single-turn')
  assert.deepEqual(r.nodes.agent.meta.toolsExecuted, [])
  r = await run('nodes-parameter-extractor.yml', { text: '张三在北京' }, ['{"name":"张三","city":"北京"}'])
  assert.deepEqual(r.outputs, { name: '张三', city: '北京', success: 1 })
  r = await run('python-coding.yml', { 'sys.query': 'print hello' }, ['print("hello")'])
  assert.deepEqual(r.outputs, { answer: 'print("hello")' })
  r = await run('seo-slug.yml', { title: 'Hello World' }, ['hello-world'])
  assert.deepEqual(r.outputs, { output: 'hello-world' })
  assert.match(JSON.stringify(calls[0]), /Hello World/)

  for (const country of ['', 'Canada']) {
    const suggestion = country ? 'Use Canadian style' : 'Improve fluency'
    r = await run('translation.yml', { source_lang: 'English', target_lang: 'French', source_text: 'Hello', country }, ['Bonjour', suggestion, `final:${country || 'generic'}`])
    assert.deepEqual(r.outputs, { output: `final:${country || 'generic'}` })
    branch(r, '1721118545228', country ? 'false' : 'true', country ? '1721118668192' : '1721118559807', country ? '1721118559807' : '1721118668192')
    assert.match(JSON.stringify(calls.at(-1)), new RegExp(suggestion))
  }
  for (const priority of ['high', 'normal']) {
    const advice = priority === 'high' ? '立即联系客户。' : '常规工单，按队列处理。'
    r = await run('mature-ticket-triage.yml', { ticket: 'app payment failure' }, [JSON.stringify({ priority, keywords: ['app', 'payment'] }), ...(priority === 'high' ? [advice] : [])])
    assert.deepEqual(r.outputs, { reply: `建议：${advice}\n关键词：\n· app\n· payment`, advice, keywords: ['app', 'payment'] })
    branch(r, 'br', priority === 'high' ? 'true' : 'false', priority === 'high' ? 'high' : 'normal', priority === 'high' ? 'normal' : 'high')
  }
  for (const [classId, chosen, absent] of [['1715846546749', '1718246916748', '1718246959048'], ['1715846565625', '1718246959048', '1718246916748']]) {
    r = await run('intent-reply.yml', { query: 'app help' }, ['intent: app help', classId, 'branch response', `final:${classId}`])
    assert.deepEqual(r.outputs, { output: `final:${classId}` })
    assert.equal(r.nodes['1718246909580'].outputs.class_id, classId)
    assert.ok(r.nodes[chosen]); assert.equal(r.nodes[absent], undefined)
    if (classId === '1715846565625') {
      // simplified: real harness grep + lexical ranking, no embeddings.
      const k = r.nodes['1721623802451']
      assert.equal(k.meta.engine, 'grep+lexical')
      assert.equal(k.outputs.result[0].content, 'app help: reset wristband')
    }
  }
  for (const [query, success] of [['{}', false], ['{"username":"svcvit","password":"x"}', true]]) {
    r = await run('form-demo.yml', { 'sys.query': query })
    if (success) assert.deepEqual(r.outputs, { answer: '登录成功，我们聊点什么？' })
    else assert.equal(r.outputs.answer, '初次使用，请登录员工账号和密码哦。\n\n' + parsed('form-demo.yml').nodes.find(n => n.id === '1730163641212').data.template)
    branch(r, '1731379291700', success ? 'true' : 'false', success ? '1731379076735' : '1730163641212', success ? '1730163641212' : '1731379076735')
  }
  // The current runner initializes conversation defaults per run. Seed a logged-in
  // conversation in the DSL fixture to reach the already-authenticated branch;
  // this is NOT a claim of session-to-session token persistence.
  const loggedIn = parsed('form-demo.yml')
  loggedIn.conversationVariables.find(v => v.name === 'user_token').value = 'existing-token'
  llm(['welcome back'])
  const chat = await runGraph(loggedIn, { 'sys.query': 'hello' })
  assert.equal(chat.stopReason, 'completed', chat.error)
  assert.deepEqual(chat.value.outputs, { answer: 'welcome back' })
  branch(chat.value, '1731378918101', 'false', '1731378486318', '1731378644337')
  assert.deepEqual(replies, [])

  // All three source documents pass through real contract HTTP and Python JSON
  // parsing. This fixture endpoint tests wiring; public Jina is separately unproven.
  for (const lang of ['zh-Hans', 'en-US', 'ja-JP']) {
    r = await run('lang-consistency.yml', { url: 'README.md', lang }, ['EN checked', 'CN checked', 'JP checked'])
    assert.deepEqual(r.outputs, { cn: 'CN checked', en: 'EN checked', jp: 'JP checked' })
    const prefix = 'document:https://raw.githubusercontent.com/langgenius/dify-docs/refs/heads/main/'
    assert.equal(r.nodes['1732346962510'].outputs.result, prefix + ({ 'zh-Hans': 'zh_CN', 'en-US': 'en', 'ja-JP': 'jp' }[lang]) + '/README.md')
    for (const id of ['17310793844280', '17310794023810', '1732344950523']) assert.ok(r.nodes[id].ok)
  }
  assert.equal(requests.length, 9)

  // Undeclared tools fail after engine -> registry -> dify-node dispatch.
  const badTool = graph([['s', { type: 'start', variables: [] }], ['bad-tool', { type: 'tool', provider_name: 'missing', provider_type: 'builtin', tool_name: 'undeclared' }], ['e', { type: 'end', outputs: [] }]], [['s', 'bad-tool'], ['bad-tool', 'e']])
  const toolFailure = await runGraph(badTool)
  assert.equal(toolFailure.stopReason, 'error')
  assert.match(toolFailure.error, /bad-tool.*missing\/undeclared.*not declared/)
  assert.equal(toolFailure.agentsStarted, 1)
  const broken = parsed('json-repair.yml')
  broken.nodes.find(n => n.data.type === 'code').data.code = 'def main(llm_string):\n    raise ValueError("intentional e2e failure")'
  const brokenPath = join(TMP, 'broken.yml')
  // Write a genuine DSL so run-tool status mapping and node error text are tested.
  // JSON is valid YAML and parseDifyDsl accepts the same original Dify schema.
  writeFileSync(brokenPath, JSON.stringify({ app: { name: 'broken', mode: 'workflow' }, workflow: { graph: { nodes: broken.nodes, edges: broken.edges } } }))
  const failure = await h.run(brokenPath, { llm_string: 'x' })
  assert.equal(failure.status, 'failed')
  assert.match(failure.error, /1732007419308.*intentional e2e failure/)
  assert.deepEqual(failure.outputs, {})
  let starts = 0
  const offStart = h.ctx.on('workflow/start', () => { starts += 1 })
  try {
    const missing = await h.run(join(DSL, 'json-repair.yml'), {})
    assert.equal(missing.status, 'rejected')
    assert.match(missing.error, /missing start inputs: llm_string/)
    assert.equal(starts, 0, 'required inputs must be validated before engine publication')
  } finally { offStart() }

  // simplified human-input does not wait. Both declared action routes execute.
  const human = graph([
    ['s', { type: 'start', variables: [] }],
    ['human', { type: 'human-input', title: 'review', form_content: 'Approve?', inputs: [{ name: 'comment', default: { type: 'constant', value: 'fixture' } }], user_actions: [{ id: 'approve' }, { id: 'reject' }] }],
    ['yes', { type: 'template-transform', template: 'APPROVED', variables: [] }],
    ['no', { type: 'template-transform', template: 'REJECTED', variables: [] }],
    ['agg', { type: 'variable-aggregator', variables: [['yes', 'output'], ['no', 'output']], output_type: 'string' }],
    ['e', { type: 'end', outputs: [{ variable: 'result', value_selector: ['agg', 'output'] }] }],
  ], [['s', 'human'], ['human', 'yes', 'approve'], ['human', 'no', 'reject'], ['yes', 'agg'], ['no', 'agg'], ['agg', 'e']])
  for (const action of ['approve', 'reject']) {
    const result = await runGraph(human, { 'human.human.action': action })
    assert.equal(result.stopReason, 'completed', result.error)
    assert.deepEqual(result.value.outputs, { result: action === 'approve' ? 'APPROVED' : 'REJECTED' })
    assert.equal(result.value.nodes.human.meta.autoResolved, true)
  }
  // placeholder knowledge-index is actually scheduled and honestly writes zero.
  const index = graph([['s', { type: 'start', variables: [] }], ['idx', { type: 'knowledge-index', dataset_id: 'fixture', index_chunk_variable_selector: ['sys', 'query'] }], ['e', { type: 'end', outputs: [{ variable: 'status', value_selector: ['idx', 'status'] }, { variable: 'indexed', value_selector: ['idx', 'indexed'] }] }]], [['s', 'idx'], ['idx', 'e']])
  const indexed = await runGraph(index)
  assert.equal(indexed.stopReason, 'completed', indexed.error)
  assert.deepEqual(indexed.value.outputs, { status: 'not_written', indexed: 0 })

  const samples = new Set(evidence.map(e => e.file))
  assert.deepEqual([...samples].sort(), readdirSync(DSL).filter(f => f.endsWith('.yml')).sort())
  if (process.env.DIFY_E2E_EVIDENCE) writeFileSync(process.env.DIFY_E2E_EVIDENCE, JSON.stringify({ samples: samples.size, cases: evidence }, null, 2))
  console.log(`ENGINE E2E OK: ${samples.size}/18 samples, ${evidence.length} sample runs + negative/support cases`)
} finally {
  if (h) await h.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(TMP, { recursive: true, force: true })
  for (const key of envKeys) if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]
}
