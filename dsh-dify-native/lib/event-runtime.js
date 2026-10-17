/** Explicit local event bridge; never a Dify plugin subscriber. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseDifyDsl } from './dsl.js'
import { stateKey, readState, writeState, lockState } from './runtime-state.js'
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const at = (obj, path) => String(path).split('.').reduce((v,k)=>v?.[k],obj)
export async function startEventRuntime(ctx, config, parent) {
  if (!parent?.session) throw new Error('Event runtime requires a real parent session')
  if (!config.stateDir || !Array.isArray(config.routes)) throw new Error('Event deployment requires stateDir and routes')
  const schedules = []
  const cronSlots = async (route, after, until) => {
    const vendor = process.env.DIFY_EVENTS_VENDOR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.vendor-events')
    const { stdout } = await promisify(execFile)(process.env.DIFY_RUNTIME_PYTHON ?? 'python3', [join(dirname(fileURLToPath(import.meta.url)), 'cron-slots.py'), JSON.stringify({ cron: route.cron, node: route.entry.data, timezone: route.timezone ?? 'UTC', after, until })], { env: { ...process.env, PYTHONPATH: [vendor, process.env.DIFY_PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(':') }, timeout: 10_000, maxBuffer: 1_048_576 })
    return JSON.parse(stdout)
  }
  for (const declaration of config.schedules ?? []) {
    const parsed = parseDifyDsl(await readFile(declaration.workflow, 'utf8'))
    const entry = parsed.nodes.find(n => n.data?.type === 'trigger-schedule')
    if (!entry || !declaration.id) throw new Error('Schedule needs a stable id and a trigger-schedule workflow')
    const route = { ...declaration, entry, cron: declaration.cron ?? entry.data.cron_expression, timezone: declaration.timezone ?? entry.data.timezone ?? 'UTC', started: declaration.start_at ?? new Date().toISOString() }
    await cronSlots(route, route.started, route.started)
    schedules.push(route)
  }
  const routes = new Map()
  for (const route of config.routes) {
    if (!route.id || !route.endpoint?.startsWith('/') || routes.has(route.endpoint)) throw new Error('Each route needs a unique endpoint and id')
    const parsed = parseDifyDsl(await readFile(route.workflow, 'utf8'))
    const entry = parsed.nodes.find(n => ['trigger','trigger-webhook','trigger-plugin','trigger-schedule'].includes(n.data?.type))
    if (!entry) throw new Error(`No trigger entry in ${route.workflow}`)
    if (entry.data.type === 'trigger-plugin' && route.bridge !== true) throw new Error('native plugin subscription is not implemented; declare bridge:true for external signed events')
    const token = process.env[route.token_env]
    if (!token) throw new Error(`Missing route token environment variable ${route.token_env}`)
    if (entry.data.type === 'trigger-plugin' && !process.env[route.signature_env]) throw new Error('Plugin bridge requires signature_env')
    routes.set(route.endpoint, { ...route, entry, token })
  }
  const deliver = async (route, id, envelope) => {
    const key = stateKey(`event:${route.id}:${id}`), root = resolve(config.stateDir)
    const release = await lockState(root, key)
    try {
      const saved = await readState(root, key)
      const hash = stateKey(JSON.stringify(envelope))
      if (saved) {
        if (saved.hash !== hash) throw Object.assign(new Error('Event id reused with different payload'), { status: 409 })
        if (!saved.result) throw Object.assign(new Error('Event already claimed; inspect interrupted run before any manual retry'), { status: 409 })
        return { ...saved.result, duplicate: true }
      }
      // Claim BEFORE starting: a crash cannot automatically replay side effects.
      await writeState(root, key, { hash, state: 'claimed', claimedAt: new Date().toISOString() })
      const inputs = {}
      for (const [name, path] of Object.entries(route.inputs ?? {})) inputs[name] = at(envelope, path) ?? null
      const data = route.entry.data, outputs = {}
      if (data.type === 'trigger-webhook') {
        if (!['application/json', 'text/plain'].includes(data.content_type ?? 'application/json')) throw new Error('This bridge supports JSON/text webhook bodies; multipart/binary upload lifecycle remains unsupported')
        for (const field of data.headers ?? []) outputs[field.name.replaceAll('-', '_')] = envelope.headers[field.name.toLowerCase()] ?? null
        for (const field of data.params ?? []) outputs[field.name] = envelope.query[field.name] ?? null
        for (const field of data.body ?? []) outputs[field.name] = data.content_type === 'text/plain' ? envelope.body : envelope.body?.[field.name] ?? null
        outputs._webhook_raw = { headers: envelope.headers, query_params: envelope.query, body: data.content_type === 'text/plain' ? { raw: envelope.body } : envelope.body }
      } else Object.assign(outputs, inputs)
      inputs[`__dify_event.${route.entry.id}`] = outputs
      inputs['trigger.body'] = envelope.body
      inputs['trigger.triggered_at'] = envelope.triggered_at ?? new Date().toISOString()
      const result = await ctx.tools.get('dify_native_run').execute({ path: resolve(route.workflow), inputs }, { agent: parent })
      const record = { ...result, event: { id, route: route.id, engine: 'external-event-bridge', native_plugin_subscription: false } }
      await writeState(root, key, { hash, state: 'settled', result: record })
      return record
    } finally { await release() }
  }
  const tick = async (now = new Date()) => {
    const results = []
    for (const route of schedules) {
      const key = stateKey(`schedule:${route.id}`), root = resolve(config.stateDir)
      const release = await lockState(root, key)
      try {
        const saved = await readState(root, key)
        const until = now.toISOString()
        const after = saved?.last ?? route.started
        if (until <= after) continue
        for (const slot of await cronSlots(route, after, until)) {
          const record = await deliver(route, `schedule:${slot}`, { headers: {}, query: {}, body: {}, triggered_at: slot })
          results.push(record)
          // A failed workflow is settled too; automatic retries would replay effects.
          await writeState(root, key, { last: slot })
        }
        await writeState(root, key, { last: until })
      } finally { await release() }
    }
    return results
  }
  const server = createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    try {
      const url = new URL(req.url, 'http://localhost'), route = routes.get(url.pathname)
      if (!route) return reply(404, { error: 'Unknown event route' })
      if (!equal(req.headers.authorization, `Bearer ${route.token}`)) return reply(401, { error: 'Unauthorized' })
      const method = String(route.entry.data.method ?? 'POST').toUpperCase()
      if (req.method !== method) return reply(405, { error: `Expected ${method}` })
      const id = req.headers['x-event-id']
      if (typeof id !== 'string' || !id) return reply(400, { error: 'X-Event-ID is required for durable deduplication' })
      const chunks=[];let size=0
      for await (const chunk of req) { size+=chunk.length;if(size>1_048_576) throw Object.assign(new Error('Event exceeds 1 MiB; payload was not truncated'),{status:413});chunks.push(chunk) }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      if (route.entry.data.type === 'trigger-plugin') {
        const expected = createHmac('sha256', process.env[route.signature_env]).update(`${id}.${raw}`).digest('hex')
        if (!equal(req.headers['x-event-signature'], expected)) return reply(401, { error: 'Invalid event signature' })
      }
      const body = route.entry.data.content_type === 'text/plain' ? raw : raw ? JSON.parse(raw) : {}
      const envelope = { body, headers: req.headers, query: Object.fromEntries(url.searchParams) }
      // Authentication and delivery headers are not semantic payload fields.
      delete envelope.headers.authorization;delete envelope.headers['x-event-signature'];delete envelope.headers['x-event-id']
      const record = await deliver(route, id, envelope)
      reply(record.status === 'failed' || record.status === 'rejected' ? 422 : Number(route.status_code ?? route.entry.data.status_code ?? 200), record)
    } catch (error) { reply(error.status ?? 400, { error: error.message }) }
  })
  server.requestTimeout = 30_000
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(config.port ?? 0,config.host ?? '127.0.0.1',ok)})
  let ticking = false, closed = false
  const timer = schedules.length ? setInterval(async () => {
    if (ticking || closed) return
    ticking = true
    try { await tick() } catch (error) { process.stderr.write(`Dify schedule delivery failed (no silent retry): ${error.message}\n`) } finally { ticking = false }
  }, Math.max(100, Number(config.poll_ms ?? 30_000))) : undefined
  timer?.unref()
  return { url: `http://${config.host ?? '127.0.0.1'}:${server.address().port}`, deliver, routes, tick, async close() { if (closed) return; closed = true;clearInterval(timer);await new Promise(r=>server.close(r)) } }
}
