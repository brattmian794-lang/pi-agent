import cp from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverEgoLiteCli } from './ego-lite-installer'

export type EgoAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'observe' | 'screenshot' | 'handoff' }
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'wait'; text: string }

const cliError = 'Ego Lite 操作失败，结果可能未知，请检查浏览器。'
const stopped = 'Ego Lite 已停止派发。'
const marker = 'PROMA_EGO_RESULT:'
const maxBytes = 1024 * 1024
const leases = new Set<string>()
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const workspaceProfile = (workspaceId: string) => 'Proma-' + hash(workspaceId)

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const keys = process.platform === 'win32'
    ? ['SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP']
    : ['HOME', 'TMPDIR']
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function invoke(source: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error(stopped)
  const bin = await discoverEgoLiteCli()
  if (signal?.aborted) throw new Error(stopped)
  if (!bin) throw new Error('找不到可安全调用的 ego-browser 入口。请在设置中重新检查 Ego Lite。')
  return new Promise((resolve, reject) => {
    const child = cp.spawn(bin, ['nodejs'], { shell: false, windowsHide: true, env: childEnv(), stdio: 'pipe' })
    const chunks: Buffer[] = []
    let size = 0
    let failure: string | undefined
    // kill 只请求终止；只有 close 才允许 execute 结束并释放租约。
    function terminate(reason: string) {
      if (failure) return
      failure = reason
      child.kill('SIGKILL')
    }
    const abort = () => terminate('Ego Lite 已停止派发。已送达的写操作结果未知，请检查浏览器。')
    const timer = setTimeout(() => terminate('Ego Lite 超时，结果未知。'), 20_000)
    signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        if (failure) return
        size += chunk.length
        if (size > maxBytes) terminate('Ego Lite 输出超限，结果未知。')
        else chunks.push(chunk) // Ego CLI 的结构化结果可能经 stderr 输出；仍要求唯一 marker。
      })
    }
    child.on('error', () => terminate(cliError))
    child.stdin.on('error', () => terminate(cliError))
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) return reject(new Error(failure ?? cliError))
      const lines = Buffer.concat(chunks).toString().split(/\r?\n/).filter(line => line.startsWith(marker))
      try {
        if (lines.length !== 1) throw new Error()
        resolve(JSON.parse(lines[0]!.slice(marker.length)))
      } catch { reject(new Error(cliError)) }
    })
    child.stdin.end(source)
  })
}

const emit = (expr: string) => `console.log(${JSON.stringify(marker)} + JSON.stringify(${expr}));`

// 复用模式只读取默认 Profile；独立模式要求唯一的非默认工作区 Profile。
// 不修改 Chromium 的 Local State / Preferences，也不创建或清除浏览器数据。
function withProfile(name: string, body: string, mode: 'current' | 'workspace'): string {
  return `
const profileName = ${JSON.stringify(name)};
const profileMode = ${JSON.stringify(mode)};
const available = await profiles();
const matches = profileMode === 'current'
  ? available.filter(p => p.isDefault === true)
  : available.filter(p => typeof p.name === 'string' && p.name.trim().toLowerCase() === profileName.toLowerCase());
const p = matches[0];
if (!matches.length) {
  ${emit("{profileError:'missing'}")}
} else if (matches.length !== 1 || (profileMode === 'current' ? p.isDefault !== true : p.name !== profileName || p.isDefault !== false) || typeof p.id !== 'string' || !p.id.trim() || (profileMode === 'workspace' && p.id.trim().toLowerCase() === 'default') || available.filter(other => other.id === p.id).length !== 1) {
  ${emit("{profileError:'conflict'}")}
} else {
${body}
}`
}

function checkProfileError(reply: unknown, name: string, mode: 'current' | 'workspace'): void {
  if (!reply || typeof reply !== 'object' || !('profileError' in reply)) return
  if (reply.profileError === 'missing') {
    throw new Error(mode === 'current'
      ? '未找到可复用的 Ego 当前浏览器配置。请先完成客户端首次引导后重试。'
      : `Ego Lite 缺少工作区专属 Profile。请新建名为 ${name} 的非默认 Profile，或改选“复用当前 Ego 浏览器配置”。`)
  }
  if (reply.profileError === 'conflict') {
    throw new Error(mode === 'current'
      ? 'Ego 当前浏览器配置不唯一或不可用，请检查客户端默认 Profile 后重试。'
      : `Ego Lite 工作区 Profile 冲突：${name} 必须唯一且不能是默认 Profile。`)
  }
  throw new Error(cliError)
}

export async function ensureEgoLiteProfile(workspaceId: string, signal: AbortSignal, mode: 'current' | 'workspace' = 'workspace'): Promise<void> {
  if (!workspaceId) throw new Error('缺少工作区。')
  const name = workspaceProfile(workspaceId)
  const reply = await invoke(withProfile(name, emit('true'), mode), signal)
  if (signal.aborted) throw new Error(stopped)
  checkProfileError(reply, name, mode)
  if (reply !== true) throw new Error(cliError)
}

export async function probeEgoLite(signal?: AbortSignal): Promise<string> {
  let value: unknown
  try {
    value = await invoke(emit('(await ego.getBrowserVersion()).currentVersion'), signal)
  } catch (error) {
    if (error instanceof Error && error.message === cliError) {
      throw new Error('Ego Lite 连接检查失败：无法通过 CLI 读取浏览器版本。请确认首次引导已完成，再点击“重试准备”。')
    }
    throw error
  }
  if (typeof value !== 'string' || !/^\d{1,5}(\.\d{1,5}){1,3}$/.test(value)) throw new Error(cliError)
  return value
}

function literal(value: string, limit = 65536) {
  if (typeof value !== 'string' || value.length > limit) throw new Error('无效的 Ego Lite 参数。')
  return JSON.stringify(value)
}

function operation(action: EgoAction, image: string): string {
  switch (action.kind) {
    case 'navigate': {
      const url = URL.canParse(action.url) && new URL(action.url)
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) break
      return `await page.goto(${literal(url.href, 8192)});`
    }
    case 'observe': return 'result = await page.snapshot();'
    case 'click': case 'fill': {
      if (typeof action.ref !== 'string' || !/^(?:@|ref=)\d{1,12}$/.test(action.ref)) break
      return action.kind === 'click' ? `await page.click(${literal(action.ref)});` : `await page.fill(${literal(action.ref)}, ${literal(action.value)});`
    }
    case 'wait': return `await page.waitForSelector('text=' + JSON.stringify(${literal(action.text, 4096)}), {state:'visible'});`
    case 'handoff': return 'await task.handOff();'
    case 'screenshot': return `await page.screenshot({path:${literal(image)}});`
  }
  throw new Error('不支持的 Ego Lite 操作或参数。')
}

export function createEgoLiteRun(workspaceId: string, sessionId: string, isEnabled: () => boolean, profileMode: 'current' | 'workspace' = 'workspace') {
  if (!workspaceId || !sessionId) throw new Error('缺少工作区或会话。')
  const profileName = workspaceProfile(workspaceId)
  const spaceName = 'Proma-' + hash(JSON.stringify([workspaceId, sessionId]))
  const controller = new AbortController()
  let spaceId: number | null = null
  let profileId: string | null = null
  let leased = false
  let busy = false
  function stop() {
    controller.abort()
    if (leased && !busy) { leases.delete(profileName); leased = false }
  }
  async function execute(action: EgoAction, signal?: AbortSignal): Promise<string> {
    if (busy) { stop(); throw new Error(stopped) }
    busy = true
    let temp: string | undefined
    signal?.addEventListener('abort', stop, { once: true })
    try {
      if (signal?.aborted || controller.signal.aborted || !isEnabled()) throw new Error(stopped)
      if (!leased && leases.has(profileName)) throw new Error('工作区 Profile 已被占用。')
      leased = true
      leases.add(profileName)
      if (action.kind === 'screenshot') temp = mkdtempSync(join(tmpdir(), 'proma-ego-'))
      const image = temp ? join(temp, 'page.png') : ''
      const op = operation(action, image)
      const reply = await invoke(withProfile(profileName, `
const previousProfile = ${JSON.stringify(profileId)};
if (previousProfile !== null && p.id !== previousProfile) throw Error('profile');
const name = ${literal(spaceName)};
const previous = ${JSON.stringify(spaceId)};
// 具名调用只创建；已有同名空间只按数字 ID 恢复。
const ownedId = async () => {
  const entries = (await listTaskSpaces()).filter(s => s.name === name);
  if (!entries.length) return null;
  const entry = entries[0];
  if (entries.length !== 1 || !Number.isSafeInteger(entry.id) || entry.id < 0 || entry.profileId !== p.id || entry.ownership !== 'agent') throw Error('ownership');
  return entry.id;
};
const existing = await ownedId();
if (previous !== null && previous !== existing) throw Error('space');
const task = existing === null ? await taskSpace(name, {profileId:p.id}) : await taskSpace(existing);
if (!Number.isSafeInteger(task.spaceId) || (existing !== null && task.spaceId !== existing) || await ownedId() !== task.spaceId) throw Error('space');
const page = task.page('p1');
let result = 'ok';
${op}
${emit('{spaceId:task.spaceId,profileId:p.id,result}')}\n`, profileMode), controller.signal)
      checkProfileError(reply, profileName, profileMode)
      if (!reply || typeof reply !== 'object' || !('spaceId' in reply) || typeof reply.spaceId !== 'number' || !Number.isSafeInteger(reply.spaceId) || !('profileId' in reply) || typeof reply.profileId !== 'string' || !('result' in reply) || typeof reply.result !== 'string') throw new Error(cliError)
      spaceId = reply.spaceId
      profileId = reply.profileId
      if (action.kind === 'handoff') stop()
      if (temp) {
        if (statSync(image).size > 8 * maxBytes) throw new Error(cliError)
        const bytes = readFileSync(image)
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(cliError)
        return bytes.toString('base64')
      }
      return reply.result
    } catch (err) {
      stop()
      // 文件路径、CLI 输出、页面数据和填充值均不进入诊断。
      if (err instanceof Error && /^(?:Ego Lite|找不到可安全调用的 ego-browser|工作区 Profile|不支持的 Ego Lite|无效的 Ego Lite)/.test(err.message)) throw err
      throw new Error(cliError)
    } finally {
      busy = false
      signal?.removeEventListener('abort', stop)
      if (controller.signal.aborted) stop()
      if (temp) rmSync(temp, { recursive: true, force: true })
    }
  }
  return { execute, stop }
}
