import cp from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverEgoLiteCli } from './ego-lite-installer'
import { logEgoLite } from './ego-lite-logging'

export type EgoAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'observe' | 'screenshot' | 'handoff' }
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; value: string }
  | { kind: 'wait'; text: string }

const cliError = 'Ego Lite 操作失败，结果可能未知，请检查浏览器。'
const stopped = 'Ego Lite 已停止派发。'
class EgoRuntimeError extends Error {
  constructor(readonly reason: string, message = cliError) { super(message) }
}
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
  if (signal?.aborted) throw new EgoRuntimeError('cancelled', stopped)
  const bin = await discoverEgoLiteCli()
  if (signal?.aborted) throw new EgoRuntimeError('cancelled', stopped)
  if (!bin) throw new EgoRuntimeError('cli_not_found', '找不到可安全调用的 ego-browser 入口。请在设置中重新检查 Ego Lite。')
  return new Promise((resolve, reject) => {
    const child = cp.spawn(bin, ['nodejs'], { shell: false, windowsHide: true, env: childEnv(), stdio: 'pipe' })
    const chunks: Buffer[] = []
    let size = 0
    let failure: EgoRuntimeError | undefined
    // kill 只请求终止；只有 close 才允许 execute 结束并释放租约。
    function terminate(error: EgoRuntimeError) {
      if (failure) return
      failure = error
      child.kill('SIGKILL')
    }
    const abort = () => terminate(new EgoRuntimeError('cancelled', 'Ego Lite 已停止派发。已送达的写操作结果未知，请检查浏览器。'))
    const timer = setTimeout(() => terminate(new EgoRuntimeError('timeout', 'Ego Lite 超时，结果未知。')), 20_000)
    signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        if (failure) return
        size += chunk.length
        if (size > maxBytes) terminate(new EgoRuntimeError('output_limit', 'Ego Lite 输出超限，结果未知。'))
        else chunks.push(chunk) // Ego CLI 的结构化结果可能经 stderr 输出；仍要求唯一 marker。
      })
    }
    child.on('error', () => terminate(new EgoRuntimeError('cli_process_error')))
    child.stdin.on('error', () => terminate(new EgoRuntimeError('cli_input_error')))
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) return reject(failure ?? new EgoRuntimeError('cli_exit'))
      const lines = Buffer.concat(chunks).toString().split(/\r?\n/).filter(line => line.startsWith(marker))
      try {
        if (lines.length !== 1) throw new Error()
        resolve(JSON.parse(lines[0]!.slice(marker.length)))
      } catch { reject(new EgoRuntimeError('invalid_cli_reply')) }
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
    throw new EgoRuntimeError('profile_missing', mode === 'current'
      ? '未找到可复用的 Ego 当前浏览器配置。请先完成客户端首次引导后重试。'
      : `Ego Lite 缺少工作区专属 Profile。请新建名为 ${name} 的非默认 Profile，或改选“复用当前 Ego 浏览器配置”。`)
  }
  if (reply.profileError === 'conflict') {
    throw new EgoRuntimeError('profile_conflict', mode === 'current'
      ? 'Ego 当前浏览器配置不唯一或不可用，请检查客户端默认 Profile 后重试。'
      : `Ego Lite 工作区 Profile 冲突：${name} 必须唯一且不能是默认 Profile。`)
  }
  throw new EgoRuntimeError('invalid_cli_reply')
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
  if (typeof value !== 'string' || value.length > limit) throw new EgoRuntimeError('invalid_action', '无效的 Ego Lite 参数。')
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
  throw new EgoRuntimeError('invalid_action', '不支持的 Ego Lite 操作或参数。')
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
  const context = { runId: randomUUID(), sessionRef: hash(sessionId), workspaceRef: hash(workspaceId), profileMode }
  const logContext = () => ({ ...context, ...(spaceId === null ? {} : { spaceId }) })
  let attempted = false
  let stopReason: 'requested' | 'cancelled' | 'failure' | 'handoff' | 'concurrent_action' | undefined
  let stopLogged = false
  function stop(reason: NonNullable<typeof stopReason> = 'requested') {
    stopReason ??= reason
    controller.abort()
    if (leased && !busy) { leases.delete(profileName); leased = false }
  }
  function logStop() {
    if (!attempted || busy || !stopReason || stopLogged) return
    stopLogged = true
    logEgoLite('info', 'dispatch_stopped', { ...logContext(), reason: stopReason })
  }
  async function dispatch(action: EgoAction, onOpenAttempt: () => void, signal?: AbortSignal): Promise<string> {
    if (busy) { stop('concurrent_action'); throw new EgoRuntimeError('concurrent_action', stopped) }
    busy = true
    let temp: string | undefined
    const onAbort = () => stop('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted || controller.signal.aborted) throw new EgoRuntimeError('cancelled', stopped)
      if (!isEnabled()) throw new EgoRuntimeError('disabled', stopped)
      if (!leased && leases.has(profileName)) throw new EgoRuntimeError('profile_busy', '工作区 Profile 已被占用。')
      leased = true
      leases.add(profileName)
      if (action.kind === 'screenshot') temp = mkdtempSync(join(tmpdir(), 'proma-ego-'))
      const image = temp ? join(temp, 'page.png') : ''
      const op = operation(action, image)
      if (spaceId === null) onOpenAttempt()
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
if (previous !== null && existing === null) {
  ${emit("{spaceMissing:true}")}
  return;
}
if (previous !== null && previous !== existing) throw Error('space');
const task = existing === null ? await taskSpace(name, {profileId:p.id}) : await taskSpace(existing);
if (!Number.isSafeInteger(task.spaceId) || (existing !== null && task.spaceId !== existing) || await ownedId() !== task.spaceId) throw Error('space');
const page = task.page('p1');
let result = 'ok';
${op}
${emit('{spaceId:task.spaceId,profileId:p.id,created:existing===null,result}')}\n`, profileMode), controller.signal)
      checkProfileError(reply, profileName, profileMode)
      if (reply && typeof reply === 'object' && 'spaceMissing' in reply && reply.spaceMissing === true) throw new EgoRuntimeError('task_space_missing')
      if (!reply || typeof reply !== 'object' || !('spaceId' in reply) || typeof reply.spaceId !== 'number' || !Number.isSafeInteger(reply.spaceId) || !('profileId' in reply) || typeof reply.profileId !== 'string' || !('created' in reply) || typeof reply.created !== 'boolean' || !('result' in reply) || typeof reply.result !== 'string') throw new EgoRuntimeError('invalid_cli_reply')
      const firstOpen = spaceId === null
      spaceId = reply.spaceId
      profileId = reply.profileId
      if (firstOpen) logEgoLite('info', 'task_space_opened', { ...logContext(), action: action.kind, mode: reply.created ? 'created' : 'reused' })
      if (action.kind === 'handoff') stop('handoff')
      if (temp) {
        if (statSync(image).size > 8 * maxBytes) throw new EgoRuntimeError('invalid_screenshot')
        const bytes = readFileSync(image)
        if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new EgoRuntimeError('invalid_screenshot')
        return bytes.toString('base64')
      }
      return reply.result
    } catch (err) {
      const reason = err instanceof EgoRuntimeError ? err.reason : 'unexpected_error'
      stop(reason === 'cancelled' ? 'cancelled' : 'failure')
      if (err instanceof EgoRuntimeError) throw err
      throw new EgoRuntimeError(reason)
    } finally {
      busy = false
      signal?.removeEventListener('abort', onAbort)
      if (controller.signal.aborted) stop()
      if (temp) rmSync(temp, { recursive: true, force: true })
    }
  }
  return {
    async execute(action: EgoAction, signal?: AbortSignal) {
      attempted = true
      const started = performance.now()
      const details = () => ({ ...logContext(), action: action.kind, durationMs: Math.round(performance.now() - started) })
      let opening = false
      try {
        const result = await dispatch(action, () => {
          opening = true
          logEgoLite('info', 'task_space_open_started', details())
        }, signal)
        logEgoLite('info', 'action_succeeded', details())
        return result
      } catch (error) {
        const reason = error instanceof EgoRuntimeError ? error.reason : 'unexpected_error'
        if (opening && spaceId === null) logEgoLite('warn', 'task_space_open_unconfirmed', { ...details(), reason })
        logEgoLite(reason === 'unexpected_error' ? 'error' : 'warn', 'action_failed', { ...details(), reason })
        throw error
      } finally { logStop() }
    },
    stop() { stop(); logStop() },
  }
}
