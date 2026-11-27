import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Bun 是可选组件：这里只在测试里替换 electron 的 app，其余逻辑（PATH 探测、
// spawnSync 校验）都走真实实现，以复现 issue 报告的「system 位置存在但不可执行」。
// net 是给其它测试文件动态导入 local-file-protocol 时用的最小占位导出。
mock.module('electron', () => ({
  app: { isPackaged: false },
  net: { fetch: (): Promise<unknown> => Promise.resolve({}) },
}))

const { detectBunRuntime, getSystemBunPaths, validateBunExecutable } = await import('./bun-finder')

const originalPath = process.env.PATH ?? ''
const tempDir = mkdtempSync(join(tmpdir(), 'proma-bun-finder-'))
const fakeBunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const fakeBunPath = join(tempDir, fakeBunName)
/** 第二个目录用来放「真正可执行」的同名候选。 */
const workingDir = join(tempDir, 'working')
const workingBunPath = join(workingDir, fakeBunName)
mkdirSync(workingDir, { recursive: true })

/** 造一个位于 PATH 中、但内容不是可执行文件的 Bun 候选。 */
function writeBrokenBun(): void {
  writeFileSync(fakeBunPath, '这不是可执行的 Bun 二进制\n')
}

/** 用当前真实的可执行文件造一个可用候选（硬链接优先，跨卷时退回复制）。 */
function writeWorkingBun(): void {
  try {
    linkSync(process.execPath, workingBunPath)
  } catch {
    copyFileSync(process.execPath, workingBunPath)
  }
}

/**
 * 返回剔除「真实安装过 Bun」目录后的 PATH。
 *
 * 测试要在开发者机器上稳定复现「只存在不可执行候选」，所以保留系统目录（供
 * where/which 使用），但排掉真的装了 bun 的目录，避免检测顺带找到可用 Bun。
 */
function pathWithoutBun(): string {
  return originalPath
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, fakeBunName)))
    .join(delimiter)
}

afterEach(() => {
  process.env.PATH = originalPath
  rmSync(fakeBunPath, { force: true })
  rmSync(workingBunPath, { force: true })
})

afterAll(() => {
  process.env.PATH = originalPath
  rmSync(tempDir, { force: true, recursive: true })
  mock.restore()
})

interface ConsoleCapture {
  errors: string[]
  logs: string[]
  warns: string[]
  restore: () => void
}

/** 截获主进程日志，用于区分「候选不可执行」与「未安装」两条分支。 */
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

describe('Bun 可执行文件校验', () => {
  test('Given 路径不存在 When 校验 Then 返回不可访问原因', () => {
    const result = validateBunExecutable(join(tempDir, 'missing-bun'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('路径不存在或不可访问')
  })

  test('Given 文件存在但不是可执行程序 When 校验 Then 返回具体失败原因', () => {
    writeBrokenBun()

    const result = validateBunExecutable(fakeBunPath)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason.trim().length).toBeGreaterThan(0)
  })

  test('Given 真正可执行的二进制 When 校验 Then 返回版本号', () => {
    const result = validateBunExecutable(process.execPath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version.length).toBeGreaterThan(0)
  })
})

describe('Bun 运行时候选诊断', () => {
  test('Given 系统位置存在但无法执行 When 检测 Then 落到候选不可执行分支并给出诊断', async () => {
    writeBrokenBun()
    process.env.PATH = `${tempDir}${delimiter}${pathWithoutBun()}`
    const capture = captureConsole()

    try {
      // 先确认 PATH 探测确实找到了这个候选，否则测的就不是「存在但不可执行」。
      expect(getSystemBunPaths()).toEqual([fakeBunPath])

      const status = await detectBunRuntime()

      expect(status.available).toBe(false)
      expect(status.path).toBeNull()
      expect(status.error).not.toBeNull()
      expect(status.error).toContain('无法执行')
      expect(status.error).toContain(fakeBunPath)

      const unreachableLogs = capture.warns.filter((line) => line.includes('位置的 Bun 无法执行'))
      expect(unreachableLogs).toHaveLength(1)
      expect(unreachableLogs[0]).toContain('system')
      // 该分支不能再顺带打印「未找到 Bun」，否则仍是 issue 报告的误导性重复日志。
      expect(capture.logs.filter((line) => line.includes('未找到 Bun'))).toHaveLength(0)
    } finally {
      capture.restore()
    }
  })

  test('Given PATH 残留多个候选且首个不可执行 When 检测 Then 跳过坏候选并采用可用 Bun', async () => {
    writeBrokenBun()
    writeWorkingBun()
    process.env.PATH = `${tempDir}${delimiter}${workingDir}${delimiter}${pathWithoutBun()}`
    const capture = captureConsole()

    try {
      // where bun 会按 PATH 顺序返回多行，两个候选都必须被发现。
      expect(getSystemBunPaths()).toEqual([fakeBunPath, workingBunPath])

      const status = await detectBunRuntime()

      expect(status.available).toBe(true)
      expect(status.path).toBe(workingBunPath)
      expect(status.source).toBe('system')
      expect(status.error).toBeNull()

      const unreachableLogs = capture.warns.filter((line) => line.includes('位置的 Bun 无法执行'))
      expect(unreachableLogs).toHaveLength(1)
      expect(unreachableLogs[0]).toContain(fakeBunPath)
      expect(capture.logs.filter((line) => line.includes('未找到 Bun'))).toHaveLength(0)
    } finally {
      capture.restore()
    }
  })

  test('Given 系统未安装 Bun When 检测 Then 保持可选组件的非错误日志', async () => {
    // 仅保留空临时目录，where/which 都找不到 bun。
    process.env.PATH = tempDir
    const capture = captureConsole()

    try {
      const status = await detectBunRuntime()

      expect(status.available).toBe(false)
      expect(status.path).toBeNull()
      expect(status.error).toBeNull()
      expect(capture.warns.filter((line) => line.includes('无法执行'))).toHaveLength(0)
      expect(capture.logs.filter((line) => line.includes('未找到 Bun（可选，不影响 Proma 核心功能）'))).toHaveLength(1)
    } finally {
      capture.restore()
    }
  })
})
