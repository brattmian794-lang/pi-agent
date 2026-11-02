/** 本地开发者诊断；不包含任意源路径或网络上传能力。 */
export const DIAGNOSTIC_IPC_CHANNELS = {
  GET_STATE: 'diagnostics:get-state',
  SET_ENABLED: 'diagnostics:set-enabled',
  OPEN_DEVTOOLS: 'diagnostics:open-devtools',
  OPEN_DIRECTORY: 'diagnostics:open-directory',
  EXPORT: 'diagnostics:export',
  RECORD: 'diagnostics:record',
  STATE_CHANGED: 'diagnostics:state-changed',
} as const

export type DiagnosticLogLevel = 'log' | 'info' | 'warn' | 'error'

export interface DiagnosticState {
  enabled: boolean
  directory: string
  lastError: string | null
}

export interface DiagnosticRecordInput {
  level: DiagnosticLogLevel
  /** 前端已进行有界序列化；主进程仍负责校验和脱敏。 */
  values: string[]
}

export interface DiagnosticExportResult {
  status: 'exported' | 'cancelled' | 'empty'
}
