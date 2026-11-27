import type { BrowserOperationStatus } from '@proma/shared'

export const BROWSER_CDP_COMMAND_TIMEOUT_MS = 8_000
export const BROWSER_OBSERVE_TIMEOUT_MS = 5_000
export const BROWSER_OBSERVE_AX_DEPTH = 8
export const BROWSER_OBSERVE_EXTENDED_AX_DEPTH = 16

/**
 * 高预算 Observe 不应仍被浅层 AX tree 截断；默认值保持紧凑，
 * 只有明确请求超过默认容量时才读取更深层的树，避免常规页面观察退化。
 */
export function resolveBrowserObserveAxDepth(maxElements: number): number {
  return maxElements > 240 ? BROWSER_OBSERVE_EXTENDED_AX_DEPTH : BROWSER_OBSERVE_AX_DEPTH
}

export class BrowserCdpTimeoutError extends Error {
  /** 超时的 DevTools 命令，便于调用方区分命令超时与页面自身加载失败。 */
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`浏览器页面未在 ${Math.ceil(timeoutMs / 1_000)} 秒内响应 ${method}：命令已超时，结果未知（页面可能仍在加载或执行）。`)
    this.name = 'BrowserCdpTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

/** 已发出的 DevTools 命令无法撤销；该错误只保证不再执行后续页面动作。 */
export class BrowserOperationAbortedError extends Error {
  constructor() {
    super('浏览器操作已停止。已发送的页面指令可能已执行，页面状态请重新观察确认。')
    this.name = 'BrowserOperationAbortedError'
  }
}

export function throwIfBrowserOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserOperationAbortedError()
}

/**
 * Electron Debugger 的 sendCommand 在目标页面卡死或 DevTools 通道异常时可能永不 settle。
 * 超时/中止只负责让调用方继续执行；底层 command 后续 settle 时会被安全忽略。
 */
export function withBrowserCdpTimeout<T>(command: () => Promise<T>, method: string, timeoutMs = BROWSER_CDP_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => settle(() => reject(new BrowserOperationAbortedError()))
    const timer = setTimeout(() => settle(() => reject(new BrowserCdpTimeoutError(method, timeoutMs))), timeoutMs)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    void Promise.resolve()
      .then(command)
      .then((value) => settle(() => resolve(value)))
      .catch((error: unknown) => settle(() => reject(error)))
  })
}

/** 一段可写入 trace/账本的失败描述；status 决定 UI 与后续 Agent 判断的依据。 */
export interface BrowserFailureTraceEntry {
  summary: string
  status: BrowserOperationStatus
}

/**
 * 导航失败的三分类：命令超时与主动停止都只代表“结果未知”，
 * 只有页面自身明确拒绝/加载失败才是已确认的 failed。
 */
export function describeBrowserNavigationFailure(host: string, error: unknown): BrowserFailureTraceEntry {
  if (error instanceof BrowserOperationAbortedError) return { summary: `打开 ${host} 已停止，结果未知`, status: 'unknown' }
  if (error instanceof BrowserCdpTimeoutError) return { summary: `打开 ${host} 超时：命令已超时，页面可能仍在加载，请重新观察确认`, status: 'unknown' }
  return { summary: `无法打开 ${host}`, status: 'failed' }
}

/**
 * Runtime.evaluate 类操作的失败分类；超时不代表页面脚本失败，也不能当成执行成功。
 * label 是动作名（如“页面 JavaScript 执行”），用于拼出可读的 trace 摘要。
 */
export function describeBrowserScriptFailure(label: string, error: unknown): BrowserFailureTraceEntry {
  if (error instanceof BrowserOperationAbortedError) return { summary: `${label}已停止，结果未知`, status: 'unknown' }
  if (error instanceof BrowserCdpTimeoutError) return { summary: `${label}超时：命令已超时，结果未知，请重新观察确认`, status: 'unknown' }
  return { summary: `${label}失败`, status: 'failed' }
}

/** 把错误折叠成去重键；不带堆栈，仅保留可读的 name/message。 */
export function formatBrowserFailureReason(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error)
}

/**
 * 同一失败原因只提示一次（如高亮依赖的 CDP 域不可用会随每个动作重复出现）。
 * 超过上限后清空，避免长期会话里无限增长，也让新出现的错误仍能被记录。
 */
export class BrowserFailureDeduper {
  private readonly seen = new Set<string>()

  constructor(private readonly limit = 20) {}

  /** 首次出现返回 true；同一原因再次出现返回 false。 */
  shouldReport(error: unknown): boolean {
    const reason = formatBrowserFailureReason(error)
    if (this.seen.has(reason)) return false
    if (this.seen.size >= this.limit) this.seen.clear()
    this.seen.add(reason)
    return true
  }
}
