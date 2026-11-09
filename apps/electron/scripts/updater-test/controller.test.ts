import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnedTestRoot, removeOwnedTestRoot, waitFor, writeCommand } from './controller'
import { isUpdaterTestBuildMetadata, resolveUpdaterTestFeedUrl } from '../../src/main/lib/updater/update-test-config'

const parent = join(process.env.PI_SCRATCH_DIR ?? process.cwd(), 'proma-updater-tests')
mkdirSync(parent, { recursive: true })

describe('更新测试控制器', () => {
  test('Given 独立测试目录 When 写入检查命令 Then 使用完整受限 JSON', () => {
    const root = createOwnedTestRoot(parent)
    try {
      writeCommand(root, 'check')
      const entries = (require('node:fs').readdirSync(join(root, 'commands')) as string[])
      const entry = entries[0]
      expect(entry).toBeDefined()
      expect(JSON.parse(readFileSync(join(root, 'commands', entry!), 'utf8'))).toEqual({ command: 'check' })
    } finally { removeOwnedTestRoot(root) }
  })

  test('Given 条件稍后成立 When 外部控制器等待 Then 不依赖应用内 Agent 汇报', async () => {
    let ready = false
    setTimeout(() => { ready = true }, 20)
    expect(await waitFor(() => ready ? { version: '0.20.0-test.1' } : null, '重启版本')).toEqual({ version: '0.20.0-test.1' })
  })

  test('Given 本次目录和其他文件 When 清理 Then 只删除本次目录', () => {
    const root = createOwnedTestRoot(parent)
    const protectedFile = join(parent, 'protected-user-file')
    writeFileSync(protectedFile, 'keep')
    removeOwnedTestRoot(root)
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(protectedFile, 'utf8')).toBe('keep')
  })

  test('Given 未授权目录 When 清理 Then 拒绝', () => {
    expect(() => removeOwnedTestRoot(parent)).toThrow('拒绝清理')
  })

  test('Given 测试目录链接指向其他实例 When 清理 Then 拒绝且保留目标数据', () => {
    const root = createOwnedTestRoot(parent)
    const link = join(parent, `linked-${Date.now()}`)
    try {
      symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => removeOwnedTestRoot(link)).toThrow('拒绝清理')
      expect(existsSync(join(root, '.proma-updater-test-owned.json'))).toBe(true)
    } finally {
      if (existsSync(link)) unlinkSync(link)
      removeOwnedTestRoot(root)
    }
  })

  test.skipIf(process.platform !== 'win32')('Given 安装准备失败 When 执行场景 Then 输出失败报告而非遗留运行状态', () => {
    const root = createOwnedTestRoot(parent)
    try {
      const feed = join(root, 'feed')
      const reports = join(root, 'proma-updater-tests')
      const installer = join(root, 'invalid-installer.exe')
      mkdirSync(feed)
      writeFileSync(installer, '故意无效的测试安装器', 'utf8')
      writeFileSync(join(feed, 'fixture.exe'), '测试新版工件', 'utf8')
      const result = spawnSync(process.execPath, ['run', join(import.meta.dir, 'run.ts'), 'normal', '--old-installer', installer, '--feed-dir', feed, '--root-parent', reports], { encoding: 'utf8', timeout: 15_000 })
      expect(result.status).not.toBe(0)
      const run = readdirSync(reports).find((name) => name.startsWith('run-'))
      expect(run).toBeDefined()
      const report = JSON.parse(readFileSync(join(reports, run!, 'report.json'), 'utf8')) as { status: string; errors: string[]; steps: Array<{ status: string }> }
      expect(report.status).toBe('failed')
      expect(report.errors.length).toBeGreaterThan(0)
      expect(report.steps.some((step) => step.status === 'failed')).toBe(true)
    } finally { removeOwnedTestRoot(root) }
  })
})

describe('更新测试源白名单', () => {
  test('Given 回环 feed When 配置 Then 接受；Given 正式 GitHub feed Then 拒绝', () => {
    expect(resolveUpdaterTestFeedUrl('http://127.0.0.1:12345')).toBe('http://127.0.0.1:12345')
    expect(() => resolveUpdaterTestFeedUrl('https://github.com/owner/repo/releases')).toThrow('独立 staging')
    expect(() => resolveUpdaterTestFeedUrl('http://example.com')).toThrow('独立 staging')
    expect(resolveUpdaterTestFeedUrl('https://updates.staging.example.com')).toBe('https://updates.staging.example.com')
  })

  test('Given 正式包元数据 When 检查测试桥 Then 拒绝；Given 专用测试包 Then 允许', () => {
    expect(isUpdaterTestBuildMetadata({ proma: {} })).toBe(false)
    expect(isUpdaterTestBuildMetadata({ proma: { updaterTest: true } })).toBe(true)
  })
})
