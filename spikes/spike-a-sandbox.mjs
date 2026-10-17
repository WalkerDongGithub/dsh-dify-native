/**
 * Spike A — 拿来主义最小验证：只挂 dsh 现成的 LocalSandboxProvider，
 * 用 ctx.sandbox.confine(argv, policy) 包一段真实 Dify code 节点逻辑（json 修复），
 * 在 landlock 沙箱里跑，再验证 read-only 模式确实拒绝写。
 *
 * 不用 dsh 的 bash 工具、不自己写沙箱、不改 dsh 源码。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'

const ROOT = '/home/walker/dify-test'
const ws = mkdtempSync(join(ROOT, 'runs/sandbox-a-'))

const ctx = new Context()
await ctx.plugin(LocalSandboxProvider)
console.log('[ctx] sandbox service:', typeof ctx.sandbox?.confine)

async function runConfined(argv, policy, input) {
  const confined = await ctx.sandbox.confine(argv, policy)
  console.log('[confine] mode=%s enforcement=%s', policy.mode, confined.enforcement)
  console.log('[confine] argv[0..2] =', JSON.stringify(confined.argv.slice(0, 3)))
  return new Promise((resolve) => {
    const child = spawn(confined.argv[0], confined.argv.slice(1), {
      cwd: policy.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('close', (code) => resolve({ code, out, err, enforcement: confined.enforcement, argv: confined.argv }))
    if (input !== undefined) child.stdin.end(input)
  })
}

// --- 1) workspace-write: 真实 Dify code 节点（json 修复逻辑） ---
const pyCode = `
import json, re, sys
raw = sys.stdin.read()
fixed = re.sub(r',\\s*([}\\]])', r'\\1', raw)
obj = json.loads(fixed)
print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
`

const writePolicy = { mode: 'workspace-write', workspaceRoot: ws }
const r1 = await runConfined(['python3', '-c', pyCode], writePolicy, '{"a": 1, "b": [1,2,], }')
console.log('[A1] exit=%s', r1.code)
console.log('[A1] stdout=%j', r1.out.trim())
console.log('[A1] stderr=%j', r1.err.trim().slice(0, 300))

// 沙箱写权限：把结果写进 workspaceRoot（应成功）
const pyWrite = `
import sys
open(sys.argv[1], 'w').write('ok')
print('wrote')
`
const r2 = await runConfined(['python3', '-c', pyWrite, join(ws, 'out.txt')], writePolicy)
console.log('[A2 write-in-workspace] exit=%s stdout=%j exists=%s', r2.code, r2.out.trim(), existsSync(join(ws, 'out.txt')))

// --- 2) read-only: 写 workspaceRoot 必须被拒 ---
const roPolicy = { mode: 'read-only', workspaceRoot: ws }
const r3 = await runConfined(['python3', '-c', pyWrite, join(ws, 'denied.txt')], roPolicy)
console.log('[A3 read-only-deny] exit=%s exists=%s', r3.code, existsSync(join(ws, 'denied.txt')))
console.log('[A3] stderr head=%j', r3.err.trim().slice(0, 400))

// --- 3) 全流程: stdin 输入 -> 沙箱 -> 结果写文件 -> 宿主读回 ---
const r4 = await new Promise(async (resolve) => {
  const confined = await ctx.sandbox.confine(['python3', '-c', pyCode], writePolicy)
  const child = spawn(confined.argv[0], confined.argv.slice(1), { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.on('close', (code) => resolve({ code, out }))
  child.stdin.end('{"a": 1, "b": [1,2,], }')
})
console.log('[A4 stdin->confined] exit=%s out=%j', r4.code, r4.out.trim())
writeFileSync(join(ws, 'result.json'), r4.out)
console.log('[A4 host-read-back]', readFileSync(join(ws, 'result.json'), 'utf8').trim())

const ok = r1.code === 0 && r1.out.trim() === '{"a": 1, "b": [1, 2]}' && r2.code === 0 && r3.code !== 0 && !existsSync(join(ws, 'denied.txt'))
console.log(ok ? 'SPIKE A OK' : 'SPIKE A FAILED')
process.exit(ok ? 0 : 1)
