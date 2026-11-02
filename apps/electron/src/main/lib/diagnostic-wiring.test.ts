import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DIAGNOSTIC_IPC_CHANNELS } from '@proma/shared'

const source = (relative: string): string => readFileSync(resolve(import.meta.dir, '../..', relative), 'utf8')

describe('开发者诊断入口接线', () => {
  test('Given 共享 IPC 契约 When 检查主进程与 preload Then 操作通道均显式接入且应用注册服务', () => {
    const main = source('main/lib/diagnostic-service.ts')
    const preload = source('preload/index.ts')
    for (const key of Object.keys(DIAGNOSTIC_IPC_CHANNELS)) {
      expect(main).toContain(`DIAGNOSTIC_IPC_CHANNELS.${key}`)
      expect(preload).toContain(`DIAGNOSTIC_IPC_CHANNELS.${key}`)
    }
    expect(main.match(/assertSender\(event\)/g)?.length).toBe(6)
    expect(source('main/ipc.ts')).toContain('registerDiagnosticIpc()')
    expect(source('main/index.ts')).toContain("safeRun('initializeDiagnostics', initializeDiagnostics)")
    expect(source('main/lib/settings-service.ts')).toContain('writeJsonFileAtomic(filePath, updated)')
  })

  test('Given 关于页 When 检查入口与前端初始化 Then 提供四项操作、隐私提示和主窗口限定', () => {
    expect(source('renderer/components/settings/AboutSettings.tsx')).toContain('<DiagnosticSettingsCard />')
    const card = source('renderer/components/settings/DiagnosticSettingsCard.tsx')
    for (const label of ['开发者与诊断', '诊断日志', '打开开发者工具', '打开日志目录', '导出日志', '不自动上传', '分享前请检查']) expect(card).toContain(label)
    expect(card).toContain('role="alert"')
    expect(card).toContain('role="status"')
    expect(source('renderer/main.tsx')).toContain('if (isMainWindow) initializeDiagnosticCapture()')
    expect(source('renderer/lib/diagnostics.ts')).toContain("if (!store.get(diagnosticStateAtom)?.enabled) return")
    expect(source('renderer/components/settings/primitives/SettingsToggle.tsx')).toContain('aria-label={label}')
  })
})
