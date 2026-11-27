import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import type { BrowserWindow } from 'electron'

const updater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  installDirectory: '',
  logger: console,
  checkForUpdates: mock(async (): Promise<void> => undefined),
  downloadUpdate: mock(async () => [] as string[]),
  quitAndInstall: mock(() => undefined),
})
mock.module('electron-updater', () => ({ autoUpdater: updater }))
// bun test 在同一进程内共享模块 mock：其他测试文件会动态导入 local-file-protocol
// 等依赖 electron.net 的模块，缺这个导出会让它们在换用本文件的 mock 时报错。
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.19.0',
    getPath: () => process.env.PI_SCRATCH_DIR ?? import.meta.dir,
  },
  net: { fetch: (): Promise<unknown> => Promise.resolve({}) },
}))
const { configureUpdater, initAutoUpdater, cleanupUpdater, installWhenIdle, cancelIdleInstall, checkForUpdates } = await import('./auto-updater')
/** 主进程推送给 renderer 的更新状态，用于断言 retryable 等诊断字段。 */
const sentStatuses: Array<Record<string, unknown>> = []
const window = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  isVisible: () => false,
  webContents: Object.assign(new EventEmitter(), {
    send: (_channel: string, payload: unknown) => { sentStatuses.push(payload as Record<string, unknown>) },
    isDestroyed: () => false,
  }),
}) as unknown as BrowserWindow
initAutoUpdater(window)
const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); await Promise.resolve() }
const downloaded = (): void => { updater.emit('update-downloaded', { version: '0.20.0', downloadedFile: '' }) }
const lastSentStatus = (): Record<string, unknown> => sentStatuses[sentStatuses.length - 1] ?? {}

interface ConsoleCapture {
  errors: string[]
  logs: string[]
  warns: string[]
  restore: () => void
}

/** 截获主进程日志，用于验证同一次失败是否仍刷多条错误级记录。 */
function captureConsole(): ConsoleCapture {
  const originals = { error: console.error, log: console.log, warn: console.warn }
  const collect = (bucket: string[]) => (...args: unknown[]): void => {
    bucket.push(args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(' '))
  }
  const capture: ConsoleCapture = {
    errors: [],
    logs: [],
    warns: [],
    restore: () => {
      console.error = originals.error
      console.log = originals.log
      console.warn = originals.warn
    },
  }
  console.error = collect(capture.errors)
  console.log = collect(capture.logs)
  console.warn = collect(capture.warns)
  return capture
}
afterEach(() => { cancelIdleInstall(); updater.quitAndInstall.mockClear(); updater.checkForUpdates.mockReset() })
afterAll(() => { cleanupUpdater(); mock.restore() })

describe('检查失败的可关联诊断', () => {
  test('Given 一次超时被 logger、error 事件与 Promise rejection 三层上报 When 检查更新 Then 只留一条带检查编号的错误记录', async () => {
    const capture = captureConsole()
    try {
      const timeout = new Error('net::ERR_TIMED_OUT')
      updater.checkForUpdates.mockImplementationOnce(async () => {
        // 复现 electron-updater 的真实时序：内部 error 监听先写 logger，再发 error 事件，最后 reject。
        updater.logger.error(`Error: ${timeout.message}\n    at AppUpdater.checkForUpdates`)
        updater.emit('error', timeout, 'Cannot check for updates: net::ERR_TIMED_OUT')
        throw timeout
      })

      await checkForUpdates()

      const errorRecords = capture.errors.filter((line) => line.includes('更新失败'))
      expect(errorRecords).toHaveLength(1)
      expect(errorRecords[0]).toContain('检查#')
      expect(errorRecords[0]).toContain('可重试=true')
      // 另外两层降级为可关联说明，不再计入失败次数。
      expect(capture.logs.filter((line) => line.includes('同一失败已记录'))).toHaveLength(2)
      expect(lastSentStatus()).toMatchObject({ status: 'error', retryable: true })
    } finally {
      capture.restore()
    }
  })

  test('Given 签名校验失败 When 检查更新失败 Then 透传不可重试状态', async () => {
    const capture = captureConsole()
    try {
      updater.checkForUpdates.mockImplementationOnce(async () => {
        throw new Error('sha512 checksum mismatch')
      })

      await checkForUpdates()

      expect(lastSentStatus()).toMatchObject({ status: 'error', retryable: false })
    } finally {
      capture.restore()
    }
  })

  test('Given 下载失败同时来自 logger 与 Promise rejection When 下载更新 Then 同样只留一条错误记录', async () => {
    const capture = captureConsole()
    try {
      const disconnected = new Error('net::ERR_INTERNET_DISCONNECTED')
      updater.downloadUpdate.mockImplementationOnce(async () => {
        updater.logger.error(`Error: ${disconnected.message}\n    at NsisUpdater.downloadUpdate`)
        throw disconnected
      })

      updater.emit('update-available', { version: '0.21.0', releaseNotes: '' })
      await settle()

      const errorRecords = capture.errors.filter((line) => line.includes('更新失败'))
      expect(errorRecords).toHaveLength(1)
      expect(errorRecords[0]).toContain('来源=logger')
      expect(capture.logs.filter((line) => line.includes('同一失败已记录'))).toHaveLength(1)
      expect(lastSentStatus()).toMatchObject({ status: 'error', retryable: true })
    } finally {
      capture.restore()
    }
  })
})

describe('后台更新安装调度', () => {
  test('Given 已下载更新 When 安排后立即取消 Then 不启动安装器', async () => {
    configureUpdater(window, { hasActiveAgents: () => false, prepareForInstall: async () => undefined })
    downloaded()
    expect(installWhenIdle()).toBe(true)
    cancelIdleInstall()
    await settle()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('Given Agent 仍运行 When 请求安装 Then 保留旧进程且不启动安装器', async () => {
    configureUpdater(window, { hasActiveAgents: () => true })
    downloaded()
    expect(installWhenIdle()).toBe(true)
    await settle()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('Given 安装前清理未完成 When 用户取消 Then 清理完成后仍不安装', async () => {
    let finish: () => void = () => undefined
    configureUpdater(window, { hasActiveAgents: () => false, prepareForInstall: () => new Promise<void>((resolve) => { finish = resolve }) })
    downloaded()
    installWhenIdle()
    await settle()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    cancelIdleInstall()
    finish()
    await settle()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('Given 已下载更新正在重新检查 When 请求安装 Then 检查结束前不使用共享缓存', async () => {
    let finish: () => void = () => undefined
    configureUpdater(window, { hasActiveAgents: () => false, prepareForInstall: async () => undefined })
    downloaded()
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const checking = checkForUpdates()
    installWhenIdle()
    await settle()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.emit('update-not-available')
    cancelIdleInstall()
    finish()
    await checking
  })

  test('Given 下载失败 When 用户请求安装 Then 拒绝且不启动安装器', () => {
    updater.emit('error', new Error('sha512 checksum mismatch'))
    expect(installWhenIdle()).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('Given 已下载且空闲 When 清理完成 Then 只启动一次静默安装并要求重启', async () => {
    const preparation = mock(async () => undefined)
    configureUpdater(window, { hasActiveAgents: () => false, prepareForInstall: preparation })
    downloaded()
    installWhenIdle()
    await settle()
    expect(preparation).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(installWhenIdle()).toBe(false)
  })
})

describe('更新器下载策略配置', () => {
  test('Given Windows 发布产物不含 blockmap When 初始化更新器 Then 关闭差分下载只走全量', () => {
    const configured = updater as unknown as { disableDifferentialDownload?: boolean }
    // 只有 Windows 缺 blockmap；macOS 仍生成 zip/dmg blockmap，保留差分更新。
    expect(configured.disableDifferentialDownload ?? false).toBe(process.platform === 'win32')
  })

  test('Given Windows 使用 NSIS 安装包 When 初始化更新器 Then 显式关闭 Web 安装器并锁定安装目录', () => {
    if (process.platform !== 'win32') return
    const configured = updater as unknown as { disableWebInstaller?: boolean; installDirectory?: string }
    expect(configured.disableWebInstaller).toBe(true)
    // 安装目录固定为当前 exe 所在目录：静默安装若换目录写新版本，重启后仍会启动旧版本。
    expect(configured.installDirectory).toBe(dirname(process.env.PI_SCRATCH_DIR ?? import.meta.dir))
  })
})
