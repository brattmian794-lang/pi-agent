import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { access, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Transform } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable } from 'node:stream'

export type EgoLiteInstallStage = 'detecting' | 'downloading' | 'installing' | 'starting'
type Report = (stage: EgoLiteInstallStage, message: string, percent?: number) => void
interface Release { url: string; bytes: number; sha256: string }
type Target = 'mac-arm64' | 'mac-x64' | 'win-x64'

// 官网 /download 的 CDN 资源。没有找到官方独立 SHA-256 清单；这里固定审阅过的 HTTPS 样本。
// URL 是滚动发布入口；文件变动后须重新校验官方产物并同时更新长度和摘要，不能自动接受新内容。
export const egoLiteReleases: Readonly<Record<Target, Release>> = {
  'mac-arm64': { url: 'https://cdn.ego.app/setup/macos/arm64/egolite.dmg', bytes: 149089310, sha256: '96fc876664d191f593ef90566e32a575166d78c0b942e6eb1014d905bfb261cc' },
  'mac-x64': { url: 'https://cdn.ego.app/setup/macos/x64/egolite.dmg', bytes: 167776176, sha256: 'cb2f5de2ba596c659121d52ec3ba73c9018f7252a177a3bf6e2ba691c8f4f78b' },
  'win-x64': { url: 'https://cdn.ego.app/setup/windows/x64/egoliteSetup.exe', bytes: 19251800, sha256: '0141c57275285da833e63d9ad0488b341bfe2227c3979db78e62dc0315d7f2ee' },
}

interface InstallerOptions {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  home: string
  temp: string
  systemApplications?: string
  fetch: typeof globalThis.fetch
  run: (exe: string, args: string[], env?: NodeJS.ProcessEnv, timeout?: number) => Promise<string>
  launch: (exe: string, args: string[]) => Promise<void>
  releases?: Readonly<Record<Target, Release>>
  onboardingMs?: number
  pollMs?: number
}

const appName = 'ego lite.app'
const macHelper = join('Contents', 'Frameworks', 'ego Framework.framework', 'Versions', 'Current', 'Helpers', 'ego-browser')
const windowsId = '{712B23BF-E734-4038-BE42-D5736B6D9570}'
const publisher = 'CN=CITRO LABS PTE. LIMITED,'
const cancelled = '已取消 Ego Lite 准备；重试将检测并复用已完成的安装。'
const onboarding = '请在 Ego Lite 中完成首次引导。无需导入已有浏览器数据或更改默认浏览器。'
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const check = (signal: AbortSignal) => { if (signal.aborted) throw new Error(cancelled) }

async function fileEntry(path: string) {
  try { return await lstat(path) } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(errno(error) ?? '')) throw error
  }
}

async function executable(path: string, mac: boolean) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, mac ? constants.X_OK : constants.R_OK)
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errno(error) ?? '')) return false
    throw error
  }
}

function defaultOptions(): InstallerOptions {
  return {
    platform: process.platform, arch: process.arch, env: process.env, home: homedir(), temp: tmpdir(),
    fetch: globalThis.fetch,
    run: (exe, args, env, timeout = 20_000) => new Promise((resolve, reject) => {
      execFile(exe, args, { env, timeout, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    }),
    launch: (exe, args) => new Promise((resolve, reject) => {
      const child = spawn(exe, args, { shell: false, detached: true, stdio: 'ignore', cwd: dirname(exe) })
      child.on('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    }),
  }
}

export function createEgoLiteInstaller(options: InstallerOptions) {
  const { env, platform, home, run } = options
  const mac = platform === 'darwin'
  const win = platform === 'win32'
  const systemApps = options.systemApplications ?? '/Applications'
  const userApps = join(home, 'Applications')
  const macRoots = [systemApps, userApps]
  const cliName = win ? 'ego-browser.exe' : 'ego-browser'
  const validPath = (value: string | undefined): value is string => Boolean(value && isAbsolute(value))
  const systemTool = (name: string) => {
    if (!validPath(env.SystemRoot)) throw new Error('无法定位 Windows 系统工具。')
    return join(env.SystemRoot, 'System32', name)
  }

  async function registry(key: string, value: string | null, view = '/reg:64') {
    try {
      const output = await run(systemTool('reg.exe'), ['query', key, ...(value ? ['/v', value] : ['/ve']), view])
      const raw = /^\s*[^\r\n]+?\s+REG_(?:SZ|EXPAND_SZ)\s+([^\r\n]+)$/im.exec(output)?.[1]?.trim()
      return raw?.replace(/%([^%]+)%/g, (token, name: string) =>
        env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? ''] ?? token)
    } catch (error) {
      if (String(errno(error)) === '1') return undefined // reg.exe：未找到该项/值
      throw error
    }
  }

  async function macCli(bundle: string) {
    if (!(await fileEntry(bundle))?.isDirectory()) return
    // 只接纳 bundle 内的 helper；Current 在 Chromium bundle 中通常是符号链接。
    const root = await realpath(bundle)
    const inside = async (candidate: string) => {
      if (!(await executable(candidate, true))) return false
      const rel = relative(root, await realpath(candidate))
      return Boolean(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    }
    const known = join(bundle, macHelper)
    if (await inside(known)) return known
    let budget = 8_000
    async function search(dir: string, depth: number): Promise<string | undefined> {
      if (depth > 10) return
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (--budget <= 0) return
          const candidate = join(dir, entry.name)
          if (entry.name === cliName && (entry.isFile() || entry.isSymbolicLink()) && await inside(candidate)) return candidate
          if (entry.isDirectory()) {
            const found = await search(candidate, depth + 1)
            if (found) return found
          }
        }
      } catch (error) { if (errno(error) !== 'ENOENT') throw error }
    }
    return search(join(bundle, 'Contents'), 0)
  }

  async function windowsCli(paths: string[]) {
    for (const dir of paths) {
      if (!validPath(dir) || dir.includes(delimiter)) continue
      const candidate = join(dir, cliName)
      if (await executable(candidate, false)) return candidate
    }
  }

  /** 准备和运行共用这套查找规则，不依赖准备阶段修改 PATH。 */
  async function discoverCli(bundle?: string) {
    if (mac) {
      const fixed = join(systemApps, appName, macHelper)
      if (await fileEntry(fixed)) {
        if (!(await executable(fixed, true))) throw new Error('系统 Applications 中的 Ego Lite CLI 不可用；请修复该安装后重试。')
        return fixed
      }
    }
    if (win) {
      const active = await windowsCli([join(home, '.local', 'share', 'ego', 'active_version_dir')])
      if (active) return active
    }
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!validPath(dir)) continue
      const candidate = join(dir, cliName)
      if (!await fileEntry(candidate)) continue
      if (!await executable(candidate, mac)) throw new Error('PATH 中优先匹配的 Ego Lite CLI 不可用；请修复该入口后重试。')
      return candidate
    }
    if (mac) {
      for (const app of bundle ? [bundle] : macRoots.map(root => join(root, appName))) {
        const cli = await macCli(app)
        if (cli) return cli
      }
      const local = join(home, '.local', 'bin', cliName)
      if (await executable(local, true)) return local
    }
    if (win) {
      const userPath = await registry('HKCU\\Environment', 'Path')
      const machinePath = await registry('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path')
      const fromPath = await windowsCli([...(userPath ?? '').split(delimiter), ...(machinePath ?? '').split(delimiter)])
      if (fromPath) return fromPath
      const app = bundle ?? await discoverApp()
      return app ? windowsCli([dirname(app)]) : undefined
    }
  }

  async function discoverApp() {
    if (mac) {
      for (const root of macRoots) {
        const bundle = join(root, appName)
        if (await fileEntry(bundle)) return bundle // 不把损坏/不完整的安装当成空位
      }
    }
    if (win) {
      const fromRegistry: string[] = []
      for (const scope of ['HKCU', 'HKLM']) {
        for (const view of ['/reg:64', '/reg:32']) {
          const appPath = await registry(`${scope}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ego.exe`, null, view)
          const location = await registry(`${scope}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${windowsId}`, 'InstallLocation', view)
          if (appPath) fromRegistry.push(appPath.replace(/^"(.*)"$/, '$1'))
          if (validPath(location)) fromRegistry.push(join(location, 'ego.exe'), join(location, 'Application', 'ego.exe'))
        }
      }
      for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
        if (!validPath(root)) continue
        for (const product of ['ego', 'ego lite']) {
          const dir = join(root, 'Citro Labs', product)
          fromRegistry.push(join(dir, 'Application', 'ego.exe'), join(dir, 'ego.exe'))
        }
      }
      for (const candidate of new Set(fromRegistry)) {
        if (validPath(candidate) && await executable(candidate, false)) return candidate
      }
    }
  }

  async function authenticode(file: string) {
    // 固定本地命令；路径作为环境变量传递，不拼进 PowerShell 源码。
    const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:PROMA_EGO_VERIFY_FILE; if ($s.Status -ne "Valid" -or !$s.SignerCertificate) { exit 1 }; $s.SignerCertificate.Subject'
    const result = await run(systemTool('WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { ...env, PROMA_EGO_VERIFY_FILE: file })
    if (!result.trim().startsWith(publisher)) throw new Error('Ego Lite 发布者签名不匹配。')
  }

  async function download(release: Release, path: string, signal: AbortSignal, report: Report) {
    if (!release.url.startsWith('https://cdn.ego.app/setup/')) throw new Error('不受信任的 Ego Lite 下载地址。')
    report('downloading', '正在从 Ego Lite 官方 CDN 下载…', 0)
    check(signal)
    const transfer = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
    const hash = createHash('sha256')
    let received = 0
    let previous = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      received += chunk.length
      if (received > release.bytes) return done(new Error('Ego Lite 安装包大小与已审阅版本不符。'))
      hash.update(chunk)
      const percent = Math.floor(received / release.bytes * 100)
      if (percent >= previous + 5 && percent < 100) {
        previous = percent
        try { check(signal); report('downloading', '正在下载 Ego Lite…', percent) } catch (error) { return done(error as Error) }
      }
      done(null, chunk)
    } })
    try {
      const response = await options.fetch(release.url, { redirect: 'error', credentials: 'omit', signal: transfer })
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw new Error('Ego Lite 官方下载暂时不可用，请检查网络后重试。')
      }
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) !== release.bytes) {
        await response.body.cancel()
        throw new Error('Ego Lite 安装包大小与已审阅版本不符。请更新 Proma，或从官网手动安装。')
      }
        await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), meter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: transfer })
    } catch (error) {
      check(signal)
      if (error instanceof TypeError || transfer.aborted || ['ECONNRESET', 'ETIMEDOUT'].includes(errno(error) ?? '')) {
        throw new Error('Ego Lite 下载失败：请检查网络、证书或代理设置后重试。')
      }
      throw error
    }
    if (received !== release.bytes || hash.digest('hex') !== release.sha256) {
      throw new Error('Ego Lite 安装包校验失败。请更新 Proma，或从官网手动安装。')
    }
    report('downloading', '官方安装包已下载并通过 SHA-256 校验。', 100)
  }

  async function installMac(release: Release, signal: AbortSignal, report: Report) {
    const temp = await mkdtemp(join(options.temp, 'proma-ego-'))
    const dmg = join(temp, 'ego-lite.dmg')
    const mount = join(temp, 'mount')
    let stage: string | undefined
    let attaching = false
    try {
      await download(release, dmg, signal, report)
      check(signal)
      report('installing', '正在验证 macOS 应用并准备用户级安装…')
      await mkdir(mount, { mode: 0o700 })
      check(signal)
      attaching = true
      await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount], undefined, 90_000)
      check(signal)
      const source = (await readdir(mount, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.toLowerCase() === appName)
      if (!source) throw new Error('官方磁盘映像未提供可直接复制的应用；不会运行需要管理员权限的 PKG。')
      const current = await discoverApp()
      if (current) return current
      await mkdir(userApps, { mode: 0o755, recursive: true })
      stage = await mkdtemp(join(userApps, '.proma-ego-'))
      const candidate = join(stage, appName)
      await run('/usr/bin/ditto', [join(mount, source.name), candidate], undefined, 120_000)
      check(signal)
      try {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate], undefined, 90_000)
        await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', candidate], undefined, 90_000)
      } catch { throw new Error('Ego Lite 签名或 Gatekeeper 校验未通过；不会启动。') }
      if (!await macCli(candidate)) throw new Error('已验证的 Ego Lite 应用缺少原生 CLI。')
      // Node 的 HTTPS 下载不会附加隔离标记。保留系统的首次启动检查，不移除隔离属性。
      await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Proma;`, candidate])
      const raced = await discoverApp()
      if (raced) return raced
      check(signal)
      // 目标为父目录，BSD mv -n 不会替换同名的现有应用；暂存目录和目标在同一文件系统。
      await run('/bin/mv', ['-n', candidate, userApps])
      const installed = await discoverApp()
      if (!installed) throw new Error('未找到安装后的 Ego Lite；请检查用户 Applications 目录权限。')
      return installed
    } finally {
      if (attaching) await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => undefined)
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
      // 卸载失败时绝不递归清理挂载点。
      await rm(dmg, { force: true }).catch(() => undefined)
      await rmdir(mount).catch(() => undefined)
      await rmdir(temp).catch(() => undefined)
    }
  }

  async function handoffWindows(release: Release, signal: AbortSignal, report: Report) {
    if (!validPath(env.LOCALAPPDATA)) throw new Error('无法定位 Windows 当前用户的本地应用目录。')
    const cache = join(env.LOCALAPPDATA, 'Proma', 'optional-installers', `ego-lite-${release.sha256}`)
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const installer = join(cache, 'egoliteSetup.exe')
    const existing = await fileEntry(installer)
    if (!existing) {
      const temp = await mkdtemp(join(cache, '.download-'))
      const staged = join(temp, 'egoliteSetup.exe')
      try {
        await download(release, staged, signal, report)
        check(signal)
        // 保留 Windows 下载文件的 SmartScreen/MOTW 检查。
        await writeFile(`${staged}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${release.url}\r\n`, { flag: 'wx' })
        try { await link(staged, installer) } catch (error) { if (errno(error) !== 'EEXIST') throw error }
      } finally { await rm(temp, { recursive: true, force: true }).catch(() => undefined) }
    }
    const entry = await fileEntry(installer)
    if (!entry?.isFile() || entry.size !== release.bytes) throw new Error('缓存的 Ego Lite 安装器不匹配；不会覆盖或运行它。请从官网手动安装。')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(installer, { signal })) hash.update(chunk)
    if (hash.digest('hex') !== release.sha256) throw new Error('缓存的 Ego Lite 安装器摘要不匹配；不会覆盖或运行它。请从官网手动安装。')
    check(signal)
    try { await authenticode(installer) } catch { throw new Error('Ego Lite 安装器未通过 Windows Authenticode 发布者校验。') }
    if (await discoverApp() || await discoverCli()) return
    check(signal)
    report('installing', '安装器已启动，请按安装界面提示完成安装。')
    check(signal)
    // 仅启动已通过哈希和发布者校验的官方安装器，不猜测静默安装参数。
    await options.launch(installer, [])
  }

  async function ensure(signal: AbortSignal, report: Report) {
    check(signal)
    report('detecting', '正在检测已安装的 Ego Lite 和原生 CLI…')
    if (!(mac && ['arm64', 'x64'].includes(options.arch)) && !(win && options.arch === 'x64')) {
      throw new Error('仅支持 macOS Intel / Apple Silicon 和 Windows x64。')
    }
    let app = await discoverApp()
    let cli = await discoverCli(app)
    let launched = false
    if (!app && !cli) {
      check(signal)
      const rosetta = mac && options.arch === 'x64' &&
        await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).then(value => value.trim() === '1', () => false)
      const target: Target = mac ? (options.arch === 'arm64' || rosetta ? 'mac-arm64' : 'mac-x64') : 'win-x64'
      const release = (options.releases ?? egoLiteReleases)[target]
      if (mac) app = await installMac(release, signal, report)
      else await handoffWindows(release, signal, report)
    }
    const deadline = Date.now() + (options.onboardingMs ?? 5 * 60_000)
    do {
      check(signal)
      app ??= await discoverApp()
      cli ??= await discoverCli(app)
      if (app && !launched) {
        report('starting', onboarding)
        if (mac) {
          if (!await macCli(app)) throw new Error('检测到已有的 Ego Lite 应用，但其 CLI 缺失；不会覆盖，请通过官网修复。')
          check(signal)
          try { await run('/usr/bin/open', [app]) } catch { throw new Error('无法启动 Ego Lite；请检查系统隐私与安全提示，并手动打开应用后重试。') }
        } else {
          try { await authenticode(app) } catch { throw new Error('检测到的 ego.exe 未通过发布者校验；请通过官网修复。') }
          check(signal)
          await options.launch(app, [])
        }
        launched = true
      }
      if (cli) {
        check(signal)
        report('starting', `已找到运行时可用的原生 ${cliName}。${onboarding}`)
        return
      }
      if (Date.now() >= deadline) break
      await delay(options.pollMs ?? 2_500, undefined, { signal })
    } while (true)
    throw new Error(`尚未检测到原生 ${cliName}。${onboarding}完成后重试；Windows 如仍不可用，请退出并重新打开 Proma。`)
  }

  // 主进程已有 Electron 单实例锁。拒绝同实例的并发请求，直到当前任务清理完成。
  let active = false
  return {
    discoverCli,
    async ensure(signal: AbortSignal, report: Report) {
      check(signal)
      if (active) throw new Error('Ego Lite 准备正在进行，请等待当前任务结束。')
      active = true
      try { await ensure(signal, report) } catch (error) {
        check(signal)
        if (['EACCES', 'EPERM', 'EROFS'].includes(errno(error) ?? '')) throw new Error('权限不足：无法读取或写入 Ego Lite 所需文件。请检查当前用户目录权限。')
        if (errno(error) === 'ENOSPC') throw new Error('磁盘空间不足，无法准备 Ego Lite。')
        if (error instanceof Error && error.message.startsWith('Command failed:')) throw new Error('系统安装工具未能完成 Ego Lite 准备；请检查系统权限后重试，或通过官网手动安装。')
        throw error
      } finally { active = false }
    },
  }
}

let production: ReturnType<typeof createEgoLiteInstaller> | undefined
const installer = () => production ??= createEgoLiteInstaller(defaultOptions())
export function discoverEgoLiteCli(): Promise<string | undefined> { return installer().discoverCli() }
export function ensureEgoLiteInstalled(signal: AbortSignal, report: Report): Promise<void> {
  return installer().ensure(signal, report)
}
