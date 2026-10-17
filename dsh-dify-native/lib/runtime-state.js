/** Small atomic JSON store for local run state. No stale-lock guessing. */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export function stateKey(value) { return createHash('sha256').update(value).digest('hex') }
export function stateRoot(cwd) { return process.env.DIFY_STATE_DIR ?? join(cwd, '.dify-native-state') }
export async function readState(root, key) {
  try { return JSON.parse(await readFile(join(root, `${key}.json`), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
export async function writeState(root, key, value) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temp = join(root, `${key}.${randomUUID()}.tmp`)
  await (await open(temp, 'wx', 0o600)).close()
  const handle = await open(temp, 'w')
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temp, join(root, `${key}.json`))
}
export async function lockState(root, key) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, `${key}.lock`)
  let handle
  try { handle = await open(path, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`State is busy or a previous process stopped: ${path}. Inspect the active run before manually recovering this lock; no automatic replay.`); throw error }
  return async () => { await handle.close(); await unlink(path) }
}
