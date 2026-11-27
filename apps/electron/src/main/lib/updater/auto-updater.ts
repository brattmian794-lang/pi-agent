/**
 * 自动更新核心模块
 *
 * 检测新版本 → 自动后台下载 → 用户选择立即或空闲时重启安装。
 * 自动更新仅在打包后的生产环境中启用。
 */

import { autoUpdater } from 'electron-updater'
import type { NsisUpdater } from 'electron-updater'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { createIdleInstallScheduler } from './idle-install-scheduler'
import { isNewerVersion } from './version'
import { createUpdateCacheCleanup, getDefaultUpdaterBaseCacheDirectory, shouldDeferUpdateCacheCleanup } from './update-cache-cleanup'

/** 当前更新状态 */
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用 */
let win: BrowserWindow | null = null

/** 定时检查定时器 */
let checkInterval: ReturnType<typeof setInterval> | null = null

/** 新版窗口稳定后执行的更新缓存清理定时器。 */
let appliedUpdateCacheCleanupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 已下载更新时仍会定期检查最新 Release。保留该快照可以在“更新源版本
 * 未变化”或检查失败时继续展示已就绪更新，也不会打断已经安排的空闲安装。
 */
let downloadedStatusDuringCheck: Extract<UpdateStatus, { status: 'downloaded' }> | null = null

/** 当前主动下载的版本，用于合并 electron-updater 的 error 事件和 Promise rejection。 */
let activeDownloadVersion: string | null = null

/** 由 Agent 服务注入，覆盖所有窗口/后台 Agent 的运行状态。 */
let hasActiveAgents = (): boolean => false
let prepareForInstall: (() => Promise<void>) | undefined
let checkInProgress = false
let installInProgress = false
let preparingInstall = false

/** 本轮检查的标识，用于把 updater logger、error 回调与检查入口的日志关联到同一次事件。 */
let activeCheckId: string | null = null
let checkAttemptSeq = 0
/** 同一次检查内重复上报的同一错误只记录一次，避免三层日志各刷一条。 */
let lastFailureSignature: string | null = null

/** 网络超时/断连属于可重试失败，与配置错误、签名错误等终态区分。 */
function isRetryableUpdaterError(message: string): boolean {
  return /ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ETIMEDOUT|ENOTFOUND|timeout/i.test(message)
}

/** 上报来源：updater 内部 logger、error 事件回调、检查入口的 Promise rejection。 */
type UpdaterFailureStage = 'logger' | 'check' | 'download'

/**
 * 把各层上报的同一错误归一成稳定签名。
 *
 * updater logger 收到的是 `Error: <message>` 加堆栈，而 error 事件与 Promise rejection
 * 收到的是原始 message，只有去掉前缀和堆栈才能识别成同一次失败。
 */
function failureSignature(message: string): string {
  const firstLine = message.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  return firstLine.replace(/^(?:Error:\s*)+/i, '').trim()
}

/**
 * 记录一次更新失败并返回统一的错误信息。
 *
 * electron-updater 会同时通过 logger、error 事件和 Promise rejection 报告同一次失败，
 * 这里按「检查轮次 + 归一后的消息」去重：首条保留错误级并带上检查编号，其余降级为
 * 一行说明，使诊断中同一事件只算一次失败、且能按检查编号关联。
 */
function reportUpdaterFailure(stage: UpdaterFailureStage, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const checkId = activeCheckId ?? '启动'
  const signature = `${checkId}:${failureSignature(message)}`
  if (lastFailureSignature === signature) {
    console.log(`[更新][${checkId}] 同一失败已记录，跳过重复错误日志（来源=${stage}）`)
  } else {
    lastFailureSignature = signature
    console.error(`[更新][${checkId}] 更新失败（来源=${stage}，可重试=${isRetryableUpdaterError(message)}）:`, err)
  }
  return message
}

/** 已安装更新包的延后清理：新版窗口稳定后才执行，避免安装链路中途删包。 */
const APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS = 15_000
/** Windows Defender、索引器等短暂占用缓存文件时的异步重试策略。 */
const APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS = 1_000
const APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES = 2

/**
 * 用户选择「空闲时更新」后，等待所有 Agent 结束再安装。
 *
 * 状态检查留在主进程，避免渲染进程漏掉后台运行或其他窗口中的 Agent。
 */
const idleInstallScheduler = createIdleInstallScheduler({
  canInstall: () => currentStatus.status === 'downloaded' && !hasActiveAgents()
    && !checkInProgress && !preparingInstall && !installInProgress,
  install: () => { setImmediate(() => { void quitAndInstall() }) },
})

/** 更新状态并推送给渲染进程 */
function setStatus(status: UpdateStatus): void {
  currentStatus = status
  if (status.status !== 'downloaded') {
    idleInstallScheduler.cancel()
  }
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
  }
}

/**
 * 处理主动下载的失败。electron-updater 可能同时发出 error 事件并 reject
 * downloadUpdate Promise，因此由 activeDownloadVersion 确保状态只恢复一次。
 */
function handleDownloadFailure(err: unknown): void {
  if (!activeDownloadVersion) return

  activeDownloadVersion = null
  const message = reportUpdaterFailure('download', err)

  // electron-updater 可能在下载新版本时清理旧 pending 工件；不能只恢复 UI
  // 状态，否则会把不可安装的旧版本伪装成“更新已就绪”。下个检查周期会重试。
  setStatus({
    status: 'error',
    error: message,
    retryable: isRetryableUpdaterError(message),
  })
}

/** 开始下载已确认需要替换的最新更新。 */
function downloadAvailableUpdate(): void {
  void autoUpdater.downloadUpdate().catch(handleDownloadFailure)
}

/**
 * 绑定更新器所需的主窗口与 Agent 状态。
 */
export function configureUpdater(
  mainWindow: BrowserWindow,
  options?: { hasActiveAgents?: () => boolean; prepareForInstall?: () => Promise<void> },
): void {
  hasActiveAgents = options?.hasActiveAgents ?? hasActiveAgents
  prepareForInstall = options?.prepareForInstall ?? prepareForInstall
  win = mainWindow
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

/** 手动触发检查更新 */
export async function checkForUpdates(): Promise<void> {
  // 安装器与下载共用 pending 工件，不能在提交安装时替换文件。
  if (checkInProgress || activeDownloadVersion || preparingInstall || installInProgress) return
  checkInProgress = true
  checkAttemptSeq += 1
  activeCheckId = `检查#${checkAttemptSeq}`
  console.log(`[更新][${activeCheckId}] 开始检查更新`)

  downloadedStatusDuringCheck = currentStatus.status === 'downloaded' ? currentStatus : null

  try {
    // 已有下载完成的更新时保持它在界面中可见，也保留用户已安排的空闲安装。
    if (!downloadedStatusDuringCheck) {
      setStatus({ status: 'checking' })
    }
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = reportUpdaterFailure('check', err)
    if (downloadedStatusDuringCheck) {
      console.warn(`[更新][${activeCheckId}] 保留已下载更新，稍后继续检查是否有新版`)
      downloadedStatusDuringCheck = null
      return
    }
    setStatus({
      status: 'error',
      error: message,
      retryable: isRetryableUpdaterError(message),
    })
  } finally {
    checkInProgress = false
  }
}

/**
 * 请求在没有运行中 Agent 时安装已下载的更新。
 *
 * @returns 是否已接受请求；仅 downloaded 状态可排队。
 */
export function installWhenIdle(): boolean {
  if (currentStatus.status !== 'downloaded' || installInProgress) {
    console.warn('[更新] 跳过空闲安装：当前没有已下载的更新')
    return false
  }

  console.log('[更新] 已请求空闲安装，等待所有 Agent 结束')
  setStatus({ ...currentStatus, installScheduled: true })
  idleInstallScheduler.request()
  return true
}

/** 取消尚未执行的空闲安装请求。 */
export function cancelIdleInstall(): void {
  idleInstallScheduler.cancel()
  if (currentStatus.status === 'downloaded' && currentStatus.installScheduled) {
    setStatus({ ...currentStatus, installScheduled: false })
  }
  console.log('[更新] 已取消空闲安装请求')
}

/** 先等待后台命令退出，避免 Windows 安装器与旧进程争用应用文件。 */
async function quitAndInstall(): Promise<void> {
  if (!app.isPackaged || preparingInstall || installInProgress) return
  if (currentStatus.status !== 'downloaded' || !currentStatus.installScheduled) return
  if (checkInProgress || hasActiveAgents()) {
    idleInstallScheduler.request()
    return
  }

  preparingInstall = true
  try {
    await prepareForInstall?.()
  } catch (error) {
    console.error('[更新] 安装前清理失败:', error)
    cancelIdleInstall()
    return
  } finally {
    preparingInstall = false
  }

  // 等待期间用户可能取消，也可能有新的 Agent 开始运行。
  if (currentStatus.status !== 'downloaded' || !currentStatus.installScheduled) return
  if (hasActiveAgents()) {
    idleInstallScheduler.request()
    return
  }
  installInProgress = true
  console.log(`[更新] 开始安装 v${currentStatus.version}`)
  autoUpdater.quitAndInstall(true, true)
}

/** 清理更新器资源（定时器等） */
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
  if (appliedUpdateCacheCleanupTimer) {
    clearTimeout(appliedUpdateCacheCleanupTimer)
    appliedUpdateCacheCleanupTimer = null
  }
  downloadedStatusDuringCheck = null
  activeDownloadVersion = null
  idleInstallScheduler.dispose()
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  configureUpdater(mainWindow)

  const updateCacheCleanup = createUpdateCacheCleanup({
    stateFilePath: join(app.getPath('userData'), 'updater-cache-state.json'),
    baseCacheDirectory: getDefaultUpdaterBaseCacheDirectory(),
  })

  // 不在刚启动时立即删包：只有主窗口实际可展示且连续稳定 15 秒，才视为基础健康检查通过。
  // Renderer 加载失败或进程崩溃时，保留安装包供重试与诊断；不以错误页的 did-finish-load 为健康信号。
  let rendererFailedDuringHealthCheck = false
  const cancelAppliedUpdateCacheCleanup = () => {
    rendererFailedDuringHealthCheck = true
    if (appliedUpdateCacheCleanupTimer) {
      clearTimeout(appliedUpdateCacheCleanupTimer)
      appliedUpdateCacheCleanupTimer = null
    }
  }
  let cleanupRetryCount = 0
  const runAppliedUpdateCacheCleanup = () => {
    appliedUpdateCacheCleanupTimer = null
    if (rendererFailedDuringHealthCheck || mainWindow.isDestroyed()) return
    // pending 是 electron-updater 的共享下载目录；任何下载进行中都不能与清理并发。
    if (shouldDeferUpdateCacheCleanup(activeDownloadVersion !== null, currentStatus.status === 'downloading')) {
      console.log('[更新缓存] 有更新正在下载，跳过本次已安装包清理')
      return
    }
    const result = updateCacheCleanup.cleanupForRunningVersion(app.getVersion())
    if (result.status === 'skipped-unsafe') {
      console.warn('[更新缓存] 跳过了未通过路径安全校验的缓存清理')
    } else if (result.status === 'failed') {
      if (cleanupRetryCount < APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES) {
        cleanupRetryCount += 1
        console.warn(`[更新缓存] 清理未完成，${APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS / 1_000} 秒后重试（${cleanupRetryCount}/${APPLIED_UPDATE_CACHE_CLEANUP_MAX_RETRIES}）`)
        appliedUpdateCacheCleanupTimer = setTimeout(runAppliedUpdateCacheCleanup, APPLIED_UPDATE_CACHE_CLEANUP_RETRY_DELAY_MS)
      } else {
        console.warn('[更新缓存] 缓存清理多次失败，将在下次启动时重试')
      }
    }
  }
  const cleanupAppliedUpdateCache = () => {
    if (rendererFailedDuringHealthCheck || mainWindow.isDestroyed()) return
    if (appliedUpdateCacheCleanupTimer) clearTimeout(appliedUpdateCacheCleanupTimer)
    cleanupRetryCount = 0
    appliedUpdateCacheCleanupTimer = setTimeout(runAppliedUpdateCacheCleanup, APPLIED_UPDATE_CACHE_CLEANUP_DELAY_MS)
  }
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) cancelAppliedUpdateCacheCleanup()
  })
  mainWindow.webContents.once('render-process-gone', cancelAppliedUpdateCacheCleanup)
  if (mainWindow.isVisible()) {
    cleanupAppliedUpdateCache()
  } else {
    mainWindow.once('ready-to-show', cleanupAppliedUpdateCache)
  }

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log(`[更新-updater][${activeCheckId ?? '空闲'}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[更新-updater][${activeCheckId ?? '空闲'}]`, ...args),
    // electron-updater 内部的 error 监听会先写一条 logger.error，再发 error 事件；
    // 与 error 回调共用同一去重器，避免一次失败留下两条错误级记录。
    error: (...args: unknown[]) => {
      reportUpdaterFailure('logger', args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(' '))
    },
    debug: (...args: unknown[]) => console.log(`[更新-updater:debug][${activeCheckId ?? '空闲'}]`, ...args),
  }

  // 手动开始下载，确保重新检查时只在 Release 比已下载版本更新时替换安装包。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  if (process.platform === 'win32') {
    // Windows 发布产物不含 .exe.blockmap（electron-builder nsis.differentialPackage: false），
    // 显式关闭差分下载，避免先请求缺失的 blockmap 再回退全量下载。
    // macOS 产物仍带 zip/dmg blockmap，保留差分更新以节省带宽。
    autoUpdater.disableDifferentialDownload = true
    const nsisUpdater = autoUpdater as NsisUpdater
    // 注册表可能保留另一处安装路径。覆盖当前运行的副本，避免重开仍是旧版。
    nsisUpdater.installDirectory = dirname(app.getPath('exe'))
    // 发布策略固定使用完整 NSIS 安装包更新，显式关闭 web 安装器以固定行为。
    nsisUpdater.disableWebInstaller = true
  }

  // 监听更新事件
  autoUpdater.on('checking-for-update', () => {
    console.log('[更新] 正在检查更新...')
    if (!downloadedStatusDuringCheck) {
      setStatus({ status: 'checking' })
    }
  })

  autoUpdater.on('update-available', (info) => {
    const downloadedStatus = downloadedStatusDuringCheck
      ?? (currentStatus.status === 'downloaded' ? currentStatus : null)

    if (downloadedStatus && !isNewerVersion(info.version, downloadedStatus.version)) {
      console.log(`[更新] 最新 Release v${info.version} 未超过已下载版本 v${downloadedStatus.version}，保留现有安装包`)
      downloadedStatusDuringCheck = null
      return
    }

    downloadedStatusDuringCheck = null
    activeDownloadVersion = info.version
    console.log('[更新] 发现新版本:', info.version)
    setStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined,
    })
    downloadAvailableUpdate()
  })

  autoUpdater.on('download-progress', (progress) => {
    downloadedStatusDuringCheck = null
    setStatus({
      status: 'downloading',
      version: (currentStatus as { version?: string }).version || '',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    downloadedStatusDuringCheck = null
    activeDownloadVersion = null
    updateCacheCleanup.recordDownloadedUpdate(info.version, info.downloadedFile)
    console.log('[更新] 下载完成:', info.version)
    setStatus({
      status: 'downloaded',
      version: info.version,
      installScheduled: false,
    })
  })

  autoUpdater.on('update-not-available', () => {
    if (downloadedStatusDuringCheck) {
      console.log('[更新] 已下载版本仍是最新，保留现有安装包')
      downloadedStatusDuringCheck = null
      return
    }
    console.log('[更新] 已是最新版本')
    setStatus({ status: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    installInProgress = false
    if (activeDownloadVersion) {
      handleDownloadFailure(err)
      return
    }

    const message = reportUpdaterFailure('check', err)
    if (downloadedStatusDuringCheck) {
      console.warn(`[更新][${activeCheckId ?? '启动'}] 保留已下载更新，稍后继续检查是否有新版`)
      downloadedStatusDuringCheck = null
      return
    }
    setStatus({
      status: 'error',
      error: message,
      retryable: isRetryableUpdaterError(message),
    })
  })

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    void checkForUpdates()
  }, 10_000)

  // 每 4 小时自动检查一次；已下载版本也会检查，发现更高版本即自动替换下载。
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    void checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // 窗口关闭时清理定时器
  mainWindow.on('closed', () => {
    cancelAppliedUpdateCacheCleanup()
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    if (appliedUpdateCacheCleanupTimer) {
      clearTimeout(appliedUpdateCacheCleanupTimer)
      appliedUpdateCacheCleanupTimer = null
    }
    downloadedStatusDuringCheck = null
    activeDownloadVersion = null
    idleInstallScheduler.dispose()
    win = null
  })

  console.log('[更新] 自动更新模块已初始化（自动下载最新版本，支持空闲时安装）')
}
