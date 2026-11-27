import { atom, getDefaultStore } from 'jotai'
import type { DiagnosticLogLevel, DiagnosticState } from '@proma/shared'
import { installDiagnosticConsole, serializeDiagnosticValues } from '../../lib/diagnostic-console'

export const diagnosticStateAtom = atom<DiagnosticState | null>(null)
let initialized = false

/**
 * ResizeObserver 的「loop completed with undelivered notifications」是浏览器在
 * 一帧内多次触发布局时自行恢复的良性提示，不是业务异常；按视图去重后降级为 warn，
 * 避免同一视图反复刷屏，同时保留可定位的视图上下文。
 */
const RESIZE_OBSERVER_LOOP_PATTERN = /ResizeObserver loop/i
/** 只保留通知类型本身作为去重键，忽略 Error 序列化后附带的可变栈信息。 */
const RESIZE_OBSERVER_LOOP_KEY_PATTERN = /ResizeObserver loop[^"\\\n]*/i
const MAX_TRACKED_RESIZE_LOOPS = 50
const reportedResizeObserverLoops = new Set<string>()

function describeViewContext(): string {
  const { pathname, hash } = window.location
  return `视图=${pathname}${hash} 标题=${document.title || '未命名'} 可见性=${document.visibilityState}`
}

export interface ResizeObserverRewrite {
  level: DiagnosticLogLevel
  values: string[]
}

/**
 * 纯函数便于单测：命中 ResizeObserver 循环通知时按「视图 + 文本」去重并降级为 warn。
 * 返回 null 表示同一视图已提示过，应直接丢弃；未命中则原样返回。
 */
export function rewriteResizeObserverLoop(
  level: DiagnosticLogLevel,
  serialized: string[],
  viewKey: string,
  viewContext: string,
  reported: Set<string>,
): ResizeObserverRewrite | null {
  const text = serialized.join(' ')
  if (!RESIZE_OBSERVER_LOOP_PATTERN.test(text)) return { level, values: serialized }
  const matched = RESIZE_OBSERVER_LOOP_KEY_PATTERN.exec(text)?.[0] ?? text.slice(0, 200)
  const stackAt = matched.indexOf(' at ')
  const keyText = (stackAt >= 0 ? matched.slice(0, stackAt) : matched).trim()
  const dedupeKey = `${viewKey}:${keyText}`
  if (reported.has(dedupeKey)) return null
  if (reported.size >= MAX_TRACKED_RESIZE_LOOPS) reported.clear()
  reported.add(dedupeKey)
  return {
    level: 'warn',
    values: [
      `[渲染布局] ResizeObserver 循环通知（浏览器已自行恢复，不影响功能；同一视图只提示一次）: ${text.slice(0, 500)}`,
      viewContext,
    ],
  }
}

/** 仅主应用页面初始化；不采集 webview、外部页面或独立子窗口。 */
export function initializeDiagnosticCapture(): void {
  if (initialized) return
  initialized = true
  const store = getDefaultStore()
  // 先订阅再读取，避免开关变化丢失；若有更新事件则不应用旧的初始快照。
  let changed = false
  window.electronAPI.onDiagnosticStateChanged((state) => {
    changed = true
    store.set(diagnosticStateAtom, state)
  })
  void window.electronAPI.getDiagnosticState().then((state) => {
    if (!changed) store.set(diagnosticStateAtom, state)
  }).catch(() => { /* 非主窗口不能使用诊断 API */ })
  const forward = (level: DiagnosticLogLevel, values: unknown[]): void => {
    if (!store.get(diagnosticStateAtom)?.enabled) return
    const rewritten = rewriteResizeObserverLoop(
      level,
      serializeDiagnosticValues(values),
      `${window.location.pathname}${window.location.hash}`,
      describeViewContext(),
      reportedResizeObserverLoops,
    )
    if (!rewritten) return
    try { window.electronAPI.recordDiagnosticLog(rewritten) }
    catch { /* IPC 关闭或异常对象不能引发新的未处理异常 */ }
  }
  installDiagnosticConsole(console, forward)
  window.addEventListener('error', (event) => forward('error', [event.error ?? event.message]))
  window.addEventListener('unhandledrejection', (event) => forward('error', [event.reason]))
}
