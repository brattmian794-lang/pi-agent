import { atom, getDefaultStore } from 'jotai'
import type { DiagnosticLogLevel, DiagnosticState } from '@proma/shared'
import { installDiagnosticConsole, serializeDiagnosticValues } from '../../lib/diagnostic-console'

export const diagnosticStateAtom = atom<DiagnosticState | null>(null)
let initialized = false

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
    try { window.electronAPI.recordDiagnosticLog({ level, values: serializeDiagnosticValues(values) }) }
    catch { /* IPC 关闭或异常对象不能引发新的未处理异常 */ }
  }
  installDiagnosticConsole(console, forward)
  window.addEventListener('error', (event) => forward('error', [event.error ?? event.message]))
  window.addEventListener('unhandledrejection', (event) => forward('error', [event.reason]))
}
