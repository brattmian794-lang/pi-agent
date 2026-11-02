import { app, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DIAGNOSTIC_IPC_CHANNELS } from '@proma/shared'
import { DiagnosticLog } from './diagnostic-log'
import { DiagnosticController, isDiagnosticSender } from './diagnostic-controller'
import { getSettings, updateSettings } from './settings-service'
import { getMainWindow } from './main-window-store'
import { installDiagnosticConsole } from '../../lib/diagnostic-console'

let controller: DiagnosticController | undefined

/** 在 app ready 后初始化；日志独立于构建模式，不改变 userData。 */
export function initializeDiagnostics(): void {
  if (controller) return
  const log = new DiagnosticLog(join(app.getPath('logs'), 'diagnostics'))
  controller = new DiagnosticController({
    log,
    readEnabled: () => getSettings().diagnosticLoggingEnabled === true,
    saveEnabled: (enabled) => { updateSettings({ diagnosticLoggingEnabled: enabled }) },
    notify: (state) => {
      const window = getMainWindow()
      if (window && !window.isDestroyed()) window.webContents.send(DIAGNOSTIC_IPC_CHANNELS.STATE_CHANGED, state)
    },
    chooseDestination: async () => {
      const window = getMainWindow()
      if (!window) throw new Error('主窗口不可用')
      const result = await dialog.showSaveDialog(window, {
        title: '导出诊断日志（分享前请检查敏感内容）',
        defaultPath: `pi-agent-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
        filters: [{ name: '诊断日志', extensions: ['log'] }],
      })
      return result.canceled ? undefined : result.filePath
    },
    metadata: { version: app.getVersion(), platform: process.platform, arch: process.arch },
  })
  installDiagnosticConsole(console, (level, values) => log.write('main', level, values))
}

function getController(): DiagnosticController {
  if (!controller) initializeDiagnostics()
  if (!controller) throw new Error('诊断服务未就绪')
  return controller
}

function assertSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  const window = getMainWindow()
  if (!isDiagnosticSender(event.sender.id, window?.webContents.id, event.senderFrame === window?.webContents.mainFrame)) {
    throw new Error('仅主窗口主界面可以使用开发者诊断')
  }
}

export function registerDiagnosticIpc(): void {
  ipcMain.handle(DIAGNOSTIC_IPC_CHANNELS.GET_STATE, (event) => {
    assertSender(event)
    return getController().getState()
  })
  ipcMain.handle(DIAGNOSTIC_IPC_CHANNELS.SET_ENABLED, (event, enabled: unknown) => {
    assertSender(event)
    return getController().setEnabled(enabled)
  })
  ipcMain.handle(DIAGNOSTIC_IPC_CHANNELS.OPEN_DEVTOOLS, (event) => {
    assertSender(event)
    getMainWindow()?.webContents.openDevTools({ mode: 'detach' })
  })
  ipcMain.handle(DIAGNOSTIC_IPC_CHANNELS.OPEN_DIRECTORY, async (event) => {
    assertSender(event)
    const directory = getController().getState().directory
    mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(`打开诊断目录失败：${error}`)
  })
  ipcMain.handle(DIAGNOSTIC_IPC_CHANNELS.EXPORT, async (event) => {
    assertSender(event)
    try {
      return await getController().exportLogs()
    } catch {
      throw new Error('导出诊断日志失败，请检查保存位置权限和磁盘空间')
    }
  })
  // send 不返回 Promise；拒绝不可信来源时直接忽略，不能抛出导致主进程异常。
  let intervalStart = 0
  let records = 0
  ipcMain.on(DIAGNOSTIC_IPC_CHANNELS.RECORD, (event, input: unknown) => {
    try {
      assertSender(event)
      const now = Date.now()
      if (now - intervalStart >= 1000) { intervalStart = now; records = 0 }
      if (++records > 200) return
      getController().record(input)
    } catch { /* 诊断链路不能影响应用 */ }
  })
}
