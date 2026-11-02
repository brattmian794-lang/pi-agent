import type { DiagnosticExportResult, DiagnosticRecordInput, DiagnosticState } from '@proma/shared'
import type { DiagnosticLog } from './diagnostic-log'

interface DiagnosticDependencies {
  log: DiagnosticLog
  readEnabled: () => boolean
  saveEnabled: (enabled: boolean) => void
  notify: (state: DiagnosticState) => void
  chooseDestination: () => Promise<string | undefined>
  metadata: { version: string; platform: string; arch: string }
}

/** 可测试的控制层：先持久化成功再改变运行状态，避免 UI 与磁盘分歧。 */
export class DiagnosticController {
  constructor(private readonly dependencies: DiagnosticDependencies) {
    dependencies.log.setEnabled(dependencies.readEnabled())
  }

  getState(): DiagnosticState {
    const { log } = this.dependencies
    return { enabled: log.isEnabled(), directory: log.getDirectory(), lastError: log.getLastError() }
  }

  setEnabled(enabled: unknown): DiagnosticState {
    if (typeof enabled !== 'boolean') throw new Error('诊断开关必须为布尔值')
    this.dependencies.saveEnabled(enabled)
    this.dependencies.log.setEnabled(enabled)
    const state = this.getState()
    this.dependencies.notify(state)
    return state
  }

  record(input: unknown): void {
    if (!this.dependencies.log.isEnabled() || !isDiagnosticRecord(input)) return
    this.dependencies.log.write('renderer', input.level, input.values)
  }

  async exportLogs(): Promise<DiagnosticExportResult> {
    const destination = await this.dependencies.chooseDestination()
    if (!destination) return { status: 'cancelled' }
    return { status: this.dependencies.log.exportTo(destination, this.dependencies.metadata) }
  }
}

/** 前端只可发送有限的文本，不能指定日志来源、文件路径或无限大的对象。 */
export function isDiagnosticRecord(input: unknown): input is DiagnosticRecordInput {
  if (!input || typeof input !== 'object') return false
  const record = input as Partial<DiagnosticRecordInput>
  return ['log', 'info', 'warn', 'error'].includes(record.level ?? '')
    && Array.isArray(record.values)
    && record.values.length <= 20
    && record.values.every((value) => typeof value === 'string' && value.length <= 16384)
    && record.values.reduce((size, value) => size + value.length, 0) <= 16384
}

/** 主窗口主 frame 身份双重校验；webview/iframe/其他窗口不能调用诊断 API。 */
export function isDiagnosticSender(senderId: number, mainSenderId: number | undefined, isMainFrame: boolean): boolean {
  return mainSenderId !== undefined && senderId === mainSenderId && isMainFrame
}
