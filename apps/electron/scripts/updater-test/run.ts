import { randomUUID } from 'node:crypto'
import { extractFile } from '@electron/asar'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOwnedTestRoot, findFile, installOldVersion, removeOwnedTestRoot, UpdaterInstanceController, waitFor, writeCommand } from './controller'
import { LocalUpdateFeed, prepareNoUpdateFeed, sha256File } from './local-feed'
import { writeJsonFileAtomic } from '../../src/main/lib/safe-file'
import type { UpdaterTestReport, UpdaterTestScenario } from './types'
import type { UpdaterTestCommand } from '../../src/main/lib/updater/update-test-harness'
import { resolveUpdaterTestFeedUrl } from '../../src/main/lib/updater/update-test-config'

const scenarios: UpdaterTestScenario[] = ['normal', 'interrupted', 'corrupt', 'invalid-signature', 'offline', 'disk-full', 'no-update', 'agent-guard', 'cancel-install', 'install-failure', 'startup-recovery', 'cleanup']

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function step(report: UpdaterTestReport, name: string, detail?: string): void {
  report.steps.push({ name, status: 'passed', at: new Date().toISOString(), detail })
  writeJsonFileAtomic(join(report.paths.root, 'report.json'), report)
  console.log(`[更新测试] ${name}${detail ? `：${detail}` : ''}`)
}

async function stopObserved(root: string, currentPid: number): Promise<void> {
  writeCommand(root, 'shutdown')
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { process.kill(currentPid, 0) } catch { return }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('本次测试实例未按命令退出')
}

/** 由外部观察进程存活与心跳，拒绝把退出后遗留的状态文件当作保护成功。 */
async function observeRunningInstance(controller: UpdaterInstanceController, pid: number, agentActive: boolean): Promise<void> {
  const initialHeartbeat = controller.readState().updatedAt
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { throw new Error('保护观察期内旧实例已退出') }
    const state = controller.readState()
    if (state.pid !== pid || state.agentActive !== agentActive) throw new Error('保护观察期内实例或 Agent 状态发生意外变化')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  if (controller.readState().updatedAt === initialHeartbeat) throw new Error('旧实例心跳停止，不能确认保护成功')
}
async function runScenario(scenario: UpdaterTestScenario): Promise<UpdaterTestReport> {
  const oldInstaller = argument('old-installer')
  const feedDirectory = argument('feed-dir')
  if (!oldInstaller || !feedDirectory) throw new Error('必须指定 --old-installer 与 --feed-dir')
  if (argument('staging-url') && process.env.PROMA_STAGING_TEST_ACK !== 'isolated-staging-only') {
    throw new Error('真实 staging 测试必须显式设置 PROMA_STAGING_TEST_ACK=isolated-staging-only')
  }
  const root = createOwnedTestRoot(argument('root-parent'))
  const startVersion = argument('start-version') ?? '0.19.0-test.1'
  const targetVersion = argument('target-version') ?? '0.20.0-test.1'
  const newPackage = findFile(feedDirectory, process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.zip' : '.AppImage')
  const report: UpdaterTestReport = {
    schemaVersion: 1, runId: randomUUID(), scenario,
    mode: argument('staging-url') ? 'staging' : 'local-feed', platform: process.platform, arch: process.arch,
    startedAt: new Date().toISOString(), status: 'running', startVersion, targetVersion,
    packageHashes: { [newPackage]: sha256File(newPackage), [oldInstaller]: sha256File(oldInstaller) },
    exits: [], errors: [], steps: [],
    paths: { root, logs: join(root, 'logs'), events: join(root, 'events.jsonl'), state: join(root, 'instance-state.json') },
  }
  const save = (): void => { writeJsonFileAtomic(join(root, 'report.json'), report) }
  save()
  const actualFeedDirectory = scenario === 'no-update' ? join(root, 'old-feed') : feedDirectory
  if (scenario === 'no-update') prepareNoUpdateFeed(feedDirectory, actualFeedDirectory, startVersion)
  const feed = new LocalUpdateFeed(actualFeedDirectory)
  if (scenario === 'interrupted') feed.fault = 'interrupted'
  if (scenario === 'corrupt') feed.fault = 'corrupt'
  if (scenario === 'offline') feed.fault = 'offline'
  if (scenario === 'invalid-signature') feed.invalidSignature = true
  let activeController: UpdaterInstanceController | undefined
  try {
    await feed.start()
    if (scenario === 'offline') await feed.close()
    const feedUrl = argument('staging-url') ?? feed.url
    if (process.platform === 'win32') writeJsonFileAtomic(join(root, 'relaunch.json'), { feedUrl })
    const controller = new UpdaterInstanceController({
      root,
      feedUrl,
      executable: await installOldVersion(oldInstaller, root, feedUrl),
      ...(scenario === 'disk-full' ? { fault: 'disk-full' as const } : {}),
      ...(scenario === 'invalid-signature' ? { requireSignature: true } : {}),
    }, report)
    activeController = controller
    const started = await controller.start()
    if (started.version !== startVersion) throw new Error(`启动版本不符：${started.version}`)
    step(report, '隔离实例启动', `v${started.version}，PID ${started.pid}`)
    controller.command('check')

    if (['interrupted', 'corrupt', 'invalid-signature', 'offline', 'disk-full'].includes(scenario)) {
      const error = await waitFor(() => {
        const status = controller.readState(false)?.updateStatus
        return status?.status === 'error' ? status.error : null
      }, '预期的下载/检查错误', 90_000)
      step(report, `${scenario} 故障被拒绝`, error)
      if (scenario === 'invalid-signature' && !/sha512|checksum|签名|signature|signed/i.test(error)) throw new Error(`签名校验错误不符合预期：${error}`)
      if (scenario === 'disk-full' && !error.includes('ENOSPC')) throw new Error('磁盘不足未呈现 ENOSPC')
      await observeRunningInstance(controller, started.pid, false)
      if (controller.readState().updateStatus.status !== 'error') throw new Error('下载失败后更新状态异常')
    } else if (scenario === 'no-update') {
      await waitFor(() => controller.readState(false)?.updateStatus.status === 'not-available' ? true : null, '无新版状态')
      step(report, '无新版不被安装')
    } else {
      const downloaded = await waitFor(() => {
        const status = controller.readState(false)?.updateStatus
        return status?.status === 'downloaded' ? status : null
      }, '更新包下载与校验完成', 180_000)
      if (downloaded.version !== targetVersion) throw new Error(`下载版本不符：${downloaded.version}`)
      step(report, '真实 electron-updater 下载完成', `v${downloaded.version}`)
      const cacheRoot = process.platform === 'win32' ? join(root, 'local-app-data') : process.platform === 'darwin' ? join(root, 'home', 'Library', 'Caches') : join(root, 'xdg-cache')
      const cachedPackage = findFile(cacheRoot, process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.zip' : '.AppImage')
      if (sha256File(cachedPackage) !== report.packageHashes[newPackage]) throw new Error('feed 实际下载包与报告锁定的包哈希不一致')
      step(report, '下载包 SHA-256 与测试清单一致')

      if (scenario === 'agent-guard') {
        controller.command('set-agent-active', true)
        await waitFor(() => controller.readState(false)?.agentActive ? true : null, 'Agent 忙碌状态')
        controller.command('install-when-idle')
        await waitFor(() => {
          const state = controller.readState(false)
          return state?.updateStatus.status === 'downloaded' && state.updateStatus.installScheduled ? true : null
        }, '空闲安装排队')
        await observeRunningInstance(controller, started.pid, true)
        step(report, 'Agent 运行期间保持运行')
        controller.command('set-agent-active', false)
      } else if (scenario === 'cancel-install') {
        controller.command('set-agent-active', true)
        await waitFor(() => controller.readState(false)?.agentActive ? true : null, 'Agent 忙碌状态')
        controller.command('install-when-idle')
        await waitFor(() => controller.readState(false)?.lastCommand === 'install-when-idle' ? true : null, '安装请求')
        controller.command('cancel-install')
        await waitFor(() => {
          const state = controller.readState(false)
          const status = state?.updateStatus
          return state?.lastCommand === 'cancel-install' && status?.status === 'downloaded' && !status.installScheduled ? true : null
        }, '取消完成')
        controller.command('set-agent-active', false)
        await waitFor(() => controller.readState(false)?.agentActive === false ? true : null, 'Agent 空闲状态')
        await observeRunningInstance(controller, started.pid, false)
        step(report, '取消空闲安装后不再安装')
      } else {
        if (scenario === 'install-failure') {
          const cached = findFile(join(root, 'local-app-data'), '.exe')
          writeFileSync(cached, 'not an executable')
          step(report, '注入安装器启动失败')
        }
        controller.command('install-when-idle')
      }

      if (scenario !== 'cancel-install' && scenario !== 'cleanup') {
        const updatedExecutable = process.platform === 'linux' ? join(root, 'install', newPackage.split(/[\\/]/).pop() ?? '') : controller.executable
        const restarted = await waitFor(() => {
          const state = controller.readState(false)
          return state?.version === targetVersion && state.pid !== started.pid && state.rendererUrl ? state : null
        }, '安装器自动拉起新版并加载渲染入口', scenario === 'install-failure' ? 15_000 : process.platform === 'win32' ? 240_000 : 10_000).catch(async (error: unknown) => {
          if (scenario === 'install-failure') return null
          if (process.platform === 'win32') throw error
          await waitFor(() => existsSync(updatedExecutable) ? true : null, '安装后的测试工件', 120_000)
          const supervisor = new UpdaterInstanceController({ root, feedUrl, executable: updatedExecutable }, report)
          return supervisor.start()
        })
        if (scenario === 'install-failure') {
          if (restarted) throw new Error('损坏安装器不应完成升级')
          const recovered = await controller.start()
          if (recovered.version !== startVersion) throw new Error('安装失败后无法恢复原测试实例')
          step(report, '安装失败后恢复旧实例', `v${recovered.version}`)
          await controller.stop()
        } else {
          if (!restarted) throw new Error('新版启动状态缺失')
          if (restarted.version !== targetVersion) throw new Error(`重启版本不符：期望 ${targetVersion}，实际 ${restarted.version}`)
          if (restarted.pid === started.pid) throw new Error('更新后仍报告旧实例 PID')
          if (process.platform === 'win32') {
            if (!report.exits.some(({ pid, code }) => pid === started.pid && code === 0)) throw new Error('未观察到旧进程正常退出')
            const asarPath = join(root, 'install', 'resources', 'app.asar')
            const expectedUrl = pathToFileURL(join(asarPath, 'dist', 'renderer', 'index.html')).href
            if (restarted.exePath !== updatedExecutable || restarted.appPath !== asarPath || restarted.rendererUrl !== expectedUrl) {
              throw new Error(`新版进程或渲染资源不在预期安装目录：${JSON.stringify(restarted)}`)
            }
            const metadata = JSON.parse(extractFile(asarPath, 'package.json').toString('utf8')) as { version?: string }
            if (metadata.version !== targetVersion) throw new Error(`安装目录 ASAR 版本不符：${metadata.version}`)
            step(report, '安装器自动重启并加载新版渲染入口', `旧 PID ${started.pid}，新 PID ${restarted.pid}，v${restarted.version}，${restarted.exePath}，${restarted.rendererUrl}`)
            await waitFor(() => existsSync(cachedPackage) ? null : true, '新版稳定启动后清理更新缓存', 25_000)
            step(report, '新版稳定启动后已回收安装包')
          } else {
            step(report, '安装退出并由外部控制器确认新版', `v${restarted.version}，PID ${restarted.pid}`)
          }
          report.restartedVersion = restarted.version
          if (scenario === 'startup-recovery') {
            await stopObserved(root, restarted.pid)
            const failing = new UpdaterInstanceController({ root, feedUrl: feed.url, executable: updatedExecutable, startupFailure: true }, report)
            await failing.start()
            if (!existsSync(report.paths.state)) throw new Error('新版启动失败后状态不可恢复')
            step(report, '新版启动失败后报告仍可读取')
            const recovery = new UpdaterInstanceController({ root, feedUrl: feed.url, executable: updatedExecutable }, report)
            const recovered = await recovery.start()
            if (recovered.version !== targetVersion) throw new Error('新版启动失败后无法恢复新版实例')
            await recovery.stop()
            step(report, '清除故障后恢复新版实例', recovered.version)
          } else {
            await stopObserved(root, restarted.pid)
          }
        }
      } else await controller.stop()
    }
    if (!['normal', 'agent-guard', 'startup-recovery'].includes(scenario)) {
      const state = controller.readState(false)
      if (state) await stopObserved(root, state.pid).catch(() => controller.stop())
    }
    if (scenario === 'cleanup') {
      const sentinel = join(root, 'sentinel.txt')
      writeFileSync(sentinel, '本次测试数据')
      await controller.stop()
      const protectedFile = join(root, '..', 'do-not-delete.txt')
      writeFileSync(protectedFile, '其他实例')
      removeOwnedTestRoot(root)
      if (existsSync(root) || !existsSync(protectedFile)) throw new Error('清理范围不符合隔离要求')
      report.status = 'passed'
      report.finishedAt = new Date().toISOString()
      report.steps.push({ name: '仅清理本次测试目录', status: 'passed', at: new Date().toISOString() })
      writeFileSync(protectedFile.replace('.txt', '.json'), JSON.stringify(report, null, 2))
      return report
    }
    report.status = 'passed'
    step(report, '场景完成')
    return report
  } catch (error) {
    report.status = 'failed'
    report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
    report.steps.push({ name: '场景失败', status: 'failed', at: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) })
    await activeController?.stop().catch(() => undefined)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    if (existsSync(root)) save()
    await feed.close()
    console.log(`[更新测试] 报告：${existsSync(root) ? join(root, 'report.json') : join(root, '..', 'do-not-delete.json')}`)
  }
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? 'normal'
  if (scenario === 'create') {
    console.log(JSON.stringify({ root: createOwnedTestRoot(argument('root-parent')) }))
    return
  }
  if (scenario === 'start') {
    const root = argument('root')
    const executable = argument('executable')
    const feedUrl = argument('feed-url') ?? argument('staging-url')
    if (!root || !executable || !feedUrl || !existsSync(join(root, '.proma-updater-test-owned.json'))) throw new Error('start 需要本次测试 --root、--executable 和 --feed-url')
    const now = new Date().toISOString()
    const report: UpdaterTestReport = {
      schemaVersion: 1, runId: randomUUID(), scenario: 'normal', mode: argument('staging-url') ? 'staging' : 'local-feed',
      platform: process.platform, arch: process.arch, startedAt: now, status: 'running',
      startVersion: argument('start-version') ?? 'unknown', targetVersion: argument('target-version') ?? 'unknown',
      packageHashes: {}, exits: [], errors: [], steps: [],
      paths: { root, logs: join(root, 'logs'), events: join(root, 'events.jsonl'), state: join(root, 'instance-state.json') },
    }
    const controller = new UpdaterInstanceController({ root, executable, feedUrl: resolveUpdaterTestFeedUrl(feedUrl) }, report)
    const state = await controller.start()
    writeJsonFileAtomic(join(root, 'report.json'), report)
    console.log(JSON.stringify(state, null, 2))
    return
  }
  if (scenario === 'report') {
    const root = argument('root')
    if (!root) throw new Error('report 需要 --root')
    console.log(JSON.stringify({
      report: JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as unknown,
      instance: JSON.parse(readFileSync(join(root, 'instance-state.json'), 'utf8')) as unknown,
    }, null, 2))
    return
  }
  if (scenario === 'command') {
    const root = argument('root')
    const command = argument('name') as UpdaterTestCommand
    if (!root || !['check', 'install-when-idle', 'cancel-install', 'set-agent-active', 'shutdown'].includes(command)) throw new Error('仅支持受限更新测试命令')
    writeCommand(root, command, argument('active') === 'true')
    console.log(readFileSync(join(root, 'instance-state.json'), 'utf8'))
    return
  }
  const selected = scenarios.find((value) => value === scenario)
  if (selected === 'install-failure' && process.platform !== 'win32') throw new Error('安装器损坏注入目前仅支持 Windows，其他平台必须单独验证安装恢复')
  if (!selected) throw new Error(`场景必须是 ${scenarios.join(', ')}`)
  await runScenario(selected)
}

await main()
