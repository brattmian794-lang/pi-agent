import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonFileAtomic } from '../../src/main/lib/safe-file'
import type { UpdaterTestScenario } from './types'

const scenarios: UpdaterTestScenario[] = ['normal', 'interrupted', 'corrupt', 'offline', 'disk-full', 'no-update', 'agent-guard', 'cancel-install', 'install-failure', 'startup-recovery', 'cleanup']
if (process.platform === 'win32') scenarios.splice(3, 0, 'invalid-signature')
const rootParent = process.argv[2] ?? join(process.cwd(), 'out', 'proma-updater-tests')
const oldInstaller = process.argv[3]
const feedDirectory = process.argv[4]
if (!oldInstaller || !feedDirectory) throw new Error('用法：run-suite.ts <报告父目录> <旧版安装包> <新版 feed 目录>')
mkdirSync(rootParent, { recursive: true })
const results: Array<{ scenario: UpdaterTestScenario; status: 'passed' | 'failed' | 'skipped'; exitCode?: number; reason?: string }> = []
for (const scenario of scenarios) {
  if (scenario === 'install-failure' && process.platform !== 'win32') {
    results.push({ scenario, status: 'skipped', reason: '安装器损坏注入目前仅支持 Windows，未验证此平台的安装失败恢复' })
    writeJsonFileAtomic(join(rootParent, 'suite-report.json'), { schemaVersion: 1, platform: process.platform, arch: process.arch, results })
    continue
  }
  const exitCode = await new Promise<number>((resolveRun) => {
    const child = spawn(process.execPath, ['run', 'scripts/updater-test/run.ts', scenario, '--old-installer', oldInstaller, '--feed-dir', feedDirectory, '--root-parent', rootParent], {
      cwd: process.cwd(),
      env: { ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
      stdio: 'inherit',
    })
    child.once('exit', (code) => resolveRun(code ?? 1))
  })
  results.push({ scenario, status: exitCode === 0 ? 'passed' : 'failed', exitCode })
  writeJsonFileAtomic(join(rootParent, 'suite-report.json'), { schemaVersion: 1, platform: process.platform, arch: process.arch, results })
}
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.status === 'failed')) process.exitCode = 1
