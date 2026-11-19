import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkDependencies, repositoryRoot, startDev } from './start-dev'
import type { DevHost } from './start-dev'

const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'dev-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function fixture(): string {
  const root = mkdtempSync(join(scratch, '中文 空格 '))
  mkdirSync(join(root, 'apps/electron'), { recursive: true })
  mkdirSync(join(root, 'scripts'))
  // 隔离测试数据，不触碰用户配置或真实工程依赖。
  writeFileSync(join(root, 'apps/electron/package.json'), '{}')
  for (const name of ['vite', 'concurrently', 'electronmon', 'esbuild', 'node-pty', '@earendil-works/pi-coding-agent', 'electron']) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), '')
  }
  const electron = join(root, 'node_modules/electron')
  mkdirSync(join(electron, 'dist'))
  writeFileSync(join(electron, 'path.txt'), 'test-electron')
  writeFileSync(join(electron, 'dist/test-electron'), '')
  for (const name of ['start-dev.ts', 'start-dev.ps1', 'start-dev.sh']) {
    copyFileSync(join(repositoryRoot, 'scripts', name), join(root, 'scripts', name))
  }
  return root
}

function host(): DevHost & { calls: string[] } {
  const calls: string[] = []
  return { calls, check: (root) => { calls.push(`check:${root}`) }, run: (root) => { calls.push(`run:${root}`); return 0 }, log: () => {} }
}

describe('Given 开发模式公共启动器', () => {
  test('When 正常启动 Then 先检查再从中文空格路径调度', () => {
    const h = host()
    const root = join(scratch, '中文 空格')
    expect(startDev([], root, h)).toBe(0)
    expect(h.calls).toEqual([`check:${root}`, `run:${root}`])
  })
  test('When --check 或 --help Then 不启动 GUI', () => {
    const h = host()
    expect(startDev(['--check'], scratch, h)).toBe(0)
    expect(h.calls).toEqual([`check:${scratch}`])
    h.calls.length = 0
    expect(startDev(['--help'], scratch, h)).toBe(0)
    expect(h.calls).toEqual([])
  })
  test('When 参数错误 Then 返回 2 且不检查或启动', () => {
    const h = host()
    expect(startDev(['--unknown'], scratch, h)).toBe(2)
    expect(startDev(['--check', '--help'], scratch, h)).toBe(2)
    expect(h.calls).toEqual([])
  })
  test('When 检查或执行异常 Then 返回非零且不静默继续', () => {
    const h = host()
    h.check = () => { throw new Error('缺失依赖') }
    expect(startDev([], scratch, h)).toBe(1)
    expect(h.calls).toEqual([])
    h.check = () => {}
    h.run = () => { throw new Error('无法启动') }
    expect(startDev([], scratch, h)).toBe(1)
  })
  test('When 子进程失败 Then 原样传递退出码', () => {
    const h = host()
    h.run = () => 23
    expect(startDev([], scratch, h)).toBe(23)
  })
  test('When Pi runtime 仅导出 ESM import Then 仍可通过预检', () => {
    const root = fixture()
    writeFileSync(join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), JSON.stringify({
      type: 'module', exports: { '.': { import: './index.js' } },
    }))
    expect(() => checkDependencies(root)).not.toThrow()
  })
  test('When 工程或依赖缺失 Then 明确提示修复命令', () => {
    expect(() => checkDependencies(scratch)).toThrow('完整仓库')
    const root = fixture()
    expect(() => checkDependencies(root)).not.toThrow()
    rmSync(join(root, 'node_modules/vite'), { recursive: true })
    expect(() => checkDependencies(root)).toThrow('bun install')
  })
  test('When Electron 二进制缺失 Then 预检失败', () => {
    const root = fixture()
    rmSync(join(root, 'node_modules/electron/dist'), { recursive: true })
    expect(() => checkDependencies(root)).toThrow('electron/install.js')
  })
  test('When 实际执行 bun run dev Then 工作目录、清理标志与退出码正确', () => {
    const root = fixture()
    const code = 'console.log(process.cwd()); console.log(process.env.PROMA_DEV_SKIP_CLEANUP); process.exit(23)'
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: `bun -e ${JSON.stringify(code)}` } }))
    const result = spawnSync(process.execPath, [join(root, 'scripts/start-dev.ts')], {
      cwd: scratch, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
    })
    expect(result.status).toBe(23)
    expect(result.stdout).toContain(root)
    expect(result.stdout).toMatch(/\r?\n1\r?\n/)
  })
})

describe.skipIf(process.platform !== 'win32')('Given Windows PowerShell 入口', () => {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  function invoke(root: string, args: string[], path = dirname(process.execPath)) {
    return spawnSync(powershell, ['-NoProfile', '-File', join(root, 'scripts/start-dev.ps1'), ...args], {
      cwd: scratch, encoding: 'utf8', env: { ...process.env, PATH: path },
    })
  }
  test('When 从其他目录调用中文空格路径 Then --check 成功', () => {
    const result = invoke(fixture(), ['--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('bun run dev')
  })
  test('When 缺少 Bun Then 返回 127 并提示安装位置', () => {
    const result = invoke(fixture(), ['--check'], scratch)
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('https://bun.sh')
  })
  test('When 依赖缺失或参数无效 Then 保留非零退出码', () => {
    const root = fixture()
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(invoke(root, ['--check']).status).toBe(1)
    expect(invoke(root, ['--unknown']).status).toBe(2)
  })
})

// Unix 使用系统 sh；Windows 可通过 DEV_TEST_SH 指定已有 Git Bash，不安装额外工具。
const shell = process.env.DEV_TEST_SH ?? (process.platform === 'win32' ? undefined : '/bin/sh')
describe.skipIf(!shell)('Given POSIX Shell 入口', () => {
  function invoke(root: string, args: string[], path = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`) {
    return spawnSync(shell!, [join(root, 'scripts/start-dev.sh'), ...args], {
      cwd: scratch, encoding: 'utf8', env: { ...process.env, PATH: path },
    })
  }
  test('When 从其他目录调用中文空格路径 Then --check 成功', () => {
    expect(invoke(fixture(), ['--check']).status).toBe(0)
  })
  test('When 缺少 Bun Then 返回 127 并提示安装位置', () => {
    const result = invoke(fixture(), ['--check'], scratch)
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('https://bun.sh')
  })
  test('When 参数无效 Then 传递非零退出码', () => {
    expect(invoke(fixture(), ['--unknown']).status).toBe(2)
  })
})
