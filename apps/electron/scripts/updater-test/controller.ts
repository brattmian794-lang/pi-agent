import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { writeJsonFileAtomic } from '../../src/main/lib/safe-file'
import { rmSyncWithRetry } from '../../src/main/lib/fs-retry'
import type { UpdaterTestCommand } from '../../src/main/lib/updater/update-test-harness'
import type { InstanceState, UpdaterTestReport } from './types'

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

export function writeCommand(root: string, command: UpdaterTestCommand, active?: boolean): void {
  const target = join(root, 'commands', `${randomUUID()}.json`)
  const temporary = `${target}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify({ command, active }), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, target)
}

export async function waitFor<T>(read: () => Promise<T | null> | T | null, description: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== null) return result
    await delay(100)
  }
  throw new Error(`等待超时：${description}`)
}

export function createOwnedTestRoot(parent = join(tmpdir(), 'proma-updater-tests')): string {
  mkdirSync(parent, { recursive: true })
  const root = realpathSync(mkdtempSync(join(parent, 'run-')))
  writeJsonFileAtomic(join(root, '.proma-updater-test-owned.json'), { schemaVersion: 1, createdByPid: process.pid })
  mkdirSync(join(root, 'commands'), { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  mkdirSync(join(root, 'temp'), { recursive: true })
  return root
}

export function removeOwnedTestRoot(root: string): void {
  const resolved = resolve(root)
  const marker = join(resolved, '.proma-updater-test-owned.json')
  if (!existsSync(marker) || lstatSync(resolved).isSymbolicLink()) throw new Error('拒绝清理未由控制器拥有的更新测试目录')
  const owner = JSON.parse(readFileSync(marker, 'utf8')) as { schemaVersion?: number }
  if (owner.schemaVersion !== 1 || basename(dirname(resolved)) !== 'proma-updater-tests') throw new Error('拒绝清理边界外的目录')
  rmSyncWithRetry(resolved, { recursive: true, force: false }, 10)
}

export interface ControllerOptions {
  root: string
  feedUrl: string
  executable: string
  fault?: 'disk-full'
  requireSignature?: boolean
  startupFailure?: boolean
}

/** 父进程控制器：安装退出之后仍能读取状态、日志并启动新的测试进程。 */
export class UpdaterInstanceController {
  private child: ChildProcess | null = null
  constructor(private readonly options: ControllerOptions, private readonly report: UpdaterTestReport) {}

  async start(): Promise<InstanceState> {
    const logPath = join(this.options.root, 'logs', `instance-${randomUUID()}.log`)
    const descriptor = openSync(logPath, 'a', 0o600)
    const root = realpathSync(this.options.root)
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      // 只传递测试 GUI 所需的显示环境，不继承用户凭据。
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      APPDATA: join(root, 'app-data'),
      LOCALAPPDATA: join(root, 'local-app-data'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
      TEMP: join(root, 'temp'),
      TMP: join(root, 'temp'),
      PROMA_UPDATE_TEST_ROOT: root,
      PROMA_UPDATE_TEST_FEED_URL: this.options.feedUrl,
      PROMA_AGENT_RUNTIME: 'off',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      APPIMAGE_EXTRACT_AND_RUN: process.platform === 'linux' ? '1' : undefined,
      ...(this.options.fault ? { PROMA_UPDATE_TEST_FAULT: this.options.fault } : {}),
      ...(this.options.requireSignature ? { PROMA_UPDATE_TEST_REQUIRE_SIGNATURE: '1' } : {}),
      ...(this.options.startupFailure ? { PROMA_UPDATE_TEST_STARTUP_FAILURE: '1' } : {}),
    }
    const child = spawn(this.options.executable, process.platform === 'linux' ? ['--no-sandbox'] : [], {
      env: environment,
      stdio: ['ignore', descriptor, descriptor],
      windowsHide: true,
    })
    closeSync(descriptor)
    this.child = child
    child.on('exit', (code, signal) => {
      this.report.exits.push({ pid: child.pid ?? -1, code, signal })
      writeJsonFileAtomic(join(this.options.root, 'report.json'), this.report)
    })
    if (this.options.startupFailure) {
      const exit = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
      if (exit !== 23) throw new Error(`启动故障注入退出码异常：${exit}`)
      return this.readState()
    }
    return waitFor(() => {
      const state = this.readState(false)
      return state && state.pid === child.pid ? state : null
    }, '测试实例报告启动版本')
  }

  get executable(): string { return this.options.executable }

  readState(required?: true): InstanceState
  readState(required: false): InstanceState | undefined
  readState(required = true): InstanceState | undefined {
    const path = join(this.options.root, 'instance-state.json')
    if (!existsSync(path)) {
      if (required) throw new Error('测试实例状态文件不存在')
      return undefined
    }
    try { return JSON.parse(readFileSync(path, 'utf8')) as InstanceState } catch {
      if (required) throw new Error('测试实例状态不可读取')
      return undefined
    }
  }

  command(command: UpdaterTestCommand, active?: boolean): void { writeCommand(this.options.root, command, active) }

  async stop(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return
    this.command('shutdown')
    await Promise.race([
      new Promise<void>((resolveExit) => this.child?.once('exit', () => resolveExit())),
      delay(5_000).then(() => { if (this.child && this.child.exitCode === null) this.child.kill() }),
    ])
  }
}

export function findFile(root: string, extension: string): string {
  if (!existsSync(root)) throw new Error(`测试路径不存在：${root}`)
  const pending = [root]
  while (pending.length) {
    const current = pending.shift()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory() && entry.name.endsWith(extension)) return path
      if (entry.isDirectory()) pending.push(path)
      else if (entry.name.endsWith(extension)) return path
    }
  }
  throw new Error(`未找到 ${extension} 测试工件：${root}`)
}

export async function installOldVersion(installer: string, root: string): Promise<string> {
  const install = join(root, 'install')
  mkdirSync(install, { recursive: true })
  if (process.platform === 'win32') {
    // 连续场景可能遇到 NSIS 旧测试安装卸载失败（退出码 2），只对此做有限重试。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const descriptor = openSync(join(root, 'logs', 'initial-installer.log'), 'a', 0o600)
      const child = spawn(installer, ['/S', `/D=${install}`], { stdio: ['ignore', descriptor, descriptor], windowsHide: true })
      closeSync(descriptor)
      const exitCode = await new Promise<number | null>((resolveInstall, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('旧版安装超时')) }, 240_000)
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('exit', (code) => { clearTimeout(timer); resolveInstall(code) })
      })
      if (exitCode === 0) return join(install, 'PromaUpdaterTest.exe')
      if (exitCode !== 2 || attempt === 2) throw new Error(`旧版安装退出码：${exitCode}`)
      console.warn(`[更新测试] 旧测试安装卸载失败，稍后重试（${attempt + 1}/2）`)
      await delay(2_000)
    }
    throw new Error('旧版安装未完成')
  }
  if (process.platform === 'darwin') {
    const result = spawn('ditto', ['-x', '-k', installer, install], { stdio: 'inherit' })
    return new Promise<string>((resolveInstall, reject) => result.once('exit', (code) => {
      if (code !== 0) reject(new Error(`macOS 测试包解压失败：${code}`))
      else resolveInstall(join(findFile(install, '.app'), 'Contents', 'MacOS', 'PromaUpdaterTest'))
    }))
  }
  const executable = join(install, basename(installer))
  copyFileSync(installer, executable)
  chmodSync(executable, 0o700)
  return executable
}
