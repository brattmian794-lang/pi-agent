/**
 * 仅供外部自动更新测试控制器使用的受限桥接。
 * 不执行 shell，不接收任意路径；只有带专用元数据的打包测试实例提供隔离目录后才会启用。
 */
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { NsisUpdater } from 'electron-updater'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { autoUpdater } from 'electron-updater'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isUpdaterTestBuildMetadata, resolveUpdaterTestFeedUrl } from './update-test-config'
import { writeJsonFileAtomic } from '../safe-file'
import type { UpdateStatus } from './updater-types'
import { cancelIdleInstall, checkForUpdates, configureUpdater, getUpdateStatus, initAutoUpdater, installWhenIdle } from './auto-updater'

export type UpdaterTestCommand = 'check' | 'install-when-idle' | 'cancel-install' | 'set-agent-active' | 'shutdown'

export interface UpdaterTestState {
  schemaVersion: 1
  version: string
  pid: number
  startedAt: string
  updatedAt: string
  agentActive: boolean
  updateStatus: UpdateStatus
  exePath: string
  appPath: string
  rendererUrl?: string
  lastCommand?: string
  error?: string
}

export function isUpdaterTestEnabled(): boolean {
  if (!app.isPackaged) return false
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    return isUpdaterTestBuildMetadata(metadata)
  } catch {
    return false
  }
}

/** NSIS 可经 Explorer 启动新版，因此重启时不能依赖旧进程的环境变量。 */
function restoreWindowsTestContext(): void {
  if (process.platform !== 'win32' || !process.argv.includes('--updated')) return
  const install = dirname(realpathSync(app.getPath('exe')))
  if (basename(install) !== 'install') return
  const root = dirname(install)
  const owner = JSON.parse(readFileSync(join(root, '.proma-updater-test-owned.json'), 'utf8')) as { schemaVersion?: number }
  if (owner.schemaVersion !== 1) return
  const context = JSON.parse(readFileSync(join(root, 'relaunch.json'), 'utf8')) as { feedUrl?: string }
  process.env.PROMA_UPDATE_TEST_FEED_URL = resolveUpdaterTestFeedUrl(context.feedUrl)
  process.env.PROMA_UPDATE_TEST_ROOT = root
}

function getTestRoot(): string {
  const root = process.env.PROMA_UPDATE_TEST_ROOT
  if (!root) throw new Error('更新测试桥只允许显式配置的打包实例')
  return root
}

/** 由应用入口在任何读取用户配置的模块初始化前调用。 */
export function isolateUpdaterTestProcess(): void {
  if (!isUpdaterTestEnabled()) return
  if (!process.env.PROMA_UPDATE_TEST_ROOT) restoreWindowsTestContext()
  process.env.PROMA_AGENT_RUNTIME = 'off'
  const root = getTestRoot()
  for (const [key, value] of Object.entries({
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'app-data'),
    LOCALAPPDATA: join(root, 'local-app-data'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    TEMP: join(root, 'temp'),
    TMP: join(root, 'temp'),
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  })) process.env[key] = value
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC|OPENAI|GITHUB|GH)_/i.test(key)) delete process.env[key]
  }
  app.commandLine.appendSwitch('no-proxy-server')
  app.setName(`proma-updater-test-${process.pid}`)
  app.setPath('userData', join(root, 'user-data'))
  app.setPath('cache', join(root, 'cache'))
  app.setPath('temp', join(root, 'temp'))
  app.setPath('crashDumps', join(root, 'crash-dumps'))
  app.disableHardwareAcceleration()
}

export function createUpdaterTestHarness(window: BrowserWindow, rendererPath: string): { setAgentActive(active: boolean): void; dispose(): void } {
  const root = getTestRoot()
  const commandsDir = join(root, 'commands')
  const statePath = join(root, 'instance-state.json')
  mkdirSync(commandsDir, { recursive: true })
  const feedUrl = resolveUpdaterTestFeedUrl(process.env.PROMA_UPDATE_TEST_FEED_URL)
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, channel: 'latest' })
  autoUpdater.disableDifferentialDownload = true
  // 仅专用 updater 测试构建可显式注入签名拒绝；不替代产品/生产 Authenticode 校验。
  if (process.platform === 'win32' && process.env.PROMA_UPDATE_TEST_FAULT === 'invalid-signature') {
    (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = async (publisherNames, filePath) =>
      `publisherNames: ${publisherNames.join(' | ')}, raw info: ${JSON.stringify({ Status: 2, StatusMessage: 'Injected unsigned test installer', Path: filePath })}`
  }
  if (process.env.PROMA_UPDATE_TEST_REQUIRE_SIGNATURE === '1') {
    const configPath = join(root, 'test-app-update.yml')
    writeFileSync(configPath, `provider: generic\nurl: ${feedUrl}\nchannel: latest\nupdaterCacheDirName: proma-updater-test\npublisherName: Proma Updater Test Only\n`, 'utf8')
    autoUpdater.updateConfigPath = configPath
  }
  if (process.env.PROMA_UPDATE_TEST_FAULT === 'disk-full') {
    autoUpdater.downloadUpdate = async () => { throw new Error('ENOSPC: 测试注入：更新缓存磁盘空间不足') }
  }
  let agentActive = false
  let state: UpdaterTestState = {
    schemaVersion: 1,
    version: app.getVersion(),
    pid: process.pid,
    exePath: app.getPath('exe'),
    appPath: app.getAppPath(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agentActive,
    updateStatus: { status: 'idle' },
  }
  const report = (): void => {
    state = { ...state, updatedAt: new Date().toISOString(), agentActive, updateStatus: getUpdateStatus() }
    writeJsonFileAtomic(statePath, state)
  }
  const event = (name: string, detail?: unknown): void => {
    appendFileSync(join(root, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: app.getVersion(), name, detail })}\n`, 'utf8')
    report()
  }
  const rendererUrl = pathToFileURL(rendererPath).href
  window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL() !== rendererUrl) return
    state.rendererUrl = rendererUrl
    event('renderer-loaded', rendererUrl)
  })
  configureUpdater(window, { hasActiveAgents: () => agentActive })
  initAutoUpdater(window)
  report()
  const reportTimer = setInterval(report, 100)
  const commandTimer = setInterval(() => {
    for (const name of readdirSync(commandsDir).filter((entry) => entry.endsWith('.json')).sort()) {
      const commandPath = join(commandsDir, name)
      try {
        const input = JSON.parse(readFileSync(commandPath, 'utf8')) as { command?: UpdaterTestCommand; active?: boolean }
        state.lastCommand = input.command
        event('command', input.command)
        switch (input.command) {
          case 'check': void checkForUpdates().then(() => event('check-finished')).catch((error: unknown) => event('check-error', String(error))); break
          case 'install-when-idle': installWhenIdle(); break
          case 'cancel-install': cancelIdleInstall(); break
          case 'set-agent-active': agentActive = input.active === true; break
          case 'shutdown': app.exit(0); break
          default: throw new Error('不支持的测试命令')
        }
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error)
        event('command-error', state.error)
      } finally {
        unlinkSync(commandPath)
      }
    }
  }, 50)
  reportTimer.unref()
  commandTimer.unref()
  event('instance-ready')
  return {
    setAgentActive(active) { agentActive = active; report() },
    dispose() { clearInterval(reportTimer); clearInterval(commandTimer); report() },
  }
}

/** 控制器写命令使用临时文件后重命名，实例永远只读取完整 JSON。 */
export function writeUpdaterTestCommand(root: string, command: UpdaterTestCommand, id: string, active?: boolean): void {
  const target = join(root, 'commands', `${id}.json`)
  const temporary = `${target}.tmp`
  writeJsonFileAtomic(temporary, { command, active })
  renameSync(temporary, target)
}

export function isUpdaterTestCommandFile(filePath: string): boolean {
  return existsSync(filePath)
}
