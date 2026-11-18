import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
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
mock.module('electron', () => ({ app: {
  isPackaged: true,
  getVersion: () => '0.19.0',
  getPath: () => process.env.PI_SCRATCH_DIR ?? import.meta.dir,
} }))
const { configureUpdater, initAutoUpdater, cleanupUpdater, installWhenIdle, cancelIdleInstall, checkForUpdates } = await import('./auto-updater')
const window = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  isVisible: () => false,
  webContents: Object.assign(new EventEmitter(), { send: () => undefined, isDestroyed: () => false }),
}) as unknown as BrowserWindow
initAutoUpdater(window)
const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); await Promise.resolve() }
const downloaded = (): void => { updater.emit('update-downloaded', { version: '0.20.0', downloadedFile: '' }) }
afterEach(() => { cancelIdleInstall(); updater.quitAndInstall.mockClear(); updater.checkForUpdates.mockReset() })
afterAll(() => { cleanupUpdater(); mock.restore() })

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
