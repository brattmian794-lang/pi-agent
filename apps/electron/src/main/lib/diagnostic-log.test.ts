import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from './diagnostic-log'

const metadata = { version: '1.0.0', platform: 'test', arch: 'x64' }
let root: string
let directory: string
let destination: string

beforeEach(() => {
  // realpath 避免 macOS 的系统临时目录链接被安全检查拒绝。
  root = realpathSync(mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'diagnostic-log-')))
  directory = join(root, 'logs')
  destination = join(root, 'export.txt')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function readCurrent(): string { return readFileSync(join(directory, 'diagnostic-0.log'), 'utf8') }

describe('诊断日志核心', () => {
  test('Given 默认关闭 When 写入 Then 不创建目录；开启后记录来源等级且关闭保留历史', () => {
    const log = new DiagnosticLog(directory)
    expect(log.isEnabled()).toBe(false)
    expect(log.getDirectory()).toBe(directory)
    log.write('main', 'log', ['忽略'])
    expect(existsSync(directory)).toBe(false)
    log.setEnabled(true)
    log.write('main', 'info', ['历史记录'])
    log.write('renderer', 'warn', ['渲染器'])
    const before = readCurrent()
    expect(before).toContain('[main] [info]')
    expect(before).toContain('[renderer] [warn]')
    log.setEnabled(false)
    log.write('renderer', 'error', ['关闭后忽略'])
    expect(readCurrent()).toBe(before)
    expect(log.exportTo(destination, metadata)).toBe('exported')
    expect(readFileSync(destination, 'utf8')).toContain('历史记录')
  })

  test('Given 重启后的实例 When 外部恢复开关 Then 默认不继续写且可显式初始化', () => {
    new DiagnosticLog(directory, { enabled: true }).write('main', 'log', ['之前'])
    const restarted = new DiagnosticLog(directory)
    restarted.write('main', 'log', ['忽略'])
    expect(readCurrent()).not.toContain('忽略')
    restarted.setEnabled(true)
    restarted.write('main', 'log', ['之后'])
    expect(readCurrent()).toContain('之前')
    expect(readCurrent()).toContain('之后')
  })

  test('Given 小尺寸三个文件 When 连续写入轮转 Then 仅保留最新三个且每文件不超限', () => {
    const log = new DiagnosticLog(directory, { enabled: true, maxFiles: 3, maxFileBytes: 180 })
    for (let index = 0; index < 10; index++) log.write('main', 'info', [`记录-${index} ${'x'.repeat(85)}`])
    expect(readdirSync(directory).sort()).toEqual(['diagnostic-0.log', 'diagnostic-1.log', 'diagnostic-2.log'])
    for (const name of readdirSync(directory)) expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(180)
    expect(readCurrent()).toContain('记录-9')
    expect(log.exportTo(destination, metadata)).toBe('exported')
    const output = readFileSync(destination, 'utf8')
    expect(output).not.toContain('记录-6')
    expect(output.indexOf('记录-7')).toBeLessThan(output.indexOf('记录-8'))
    expect(output.indexOf('记录-8')).toBeLessThan(output.indexOf('记录-9'))
  })

  test('Given 超长中英文和 emoji When 默认或自定义截断 Then UTF8 完整且含换行不超条目上限', () => {
    const log = new DiagnosticLog(directory, { enabled: true })
    log.write('renderer', 'log', ['中文😀'.repeat(10000)])
    expect(Buffer.byteLength(readCurrent())).toBeLessThanOrEqual(16 * 1024)
    expect(readCurrent()).not.toContain('\ufffd')
    expect(readCurrent()).toEndWith('[Truncated]\n')
    const smallDirectory = join(root, 'small')
    new DiagnosticLog(smallDirectory, { enabled: true, maxEntryBytes: 128 }).write('main', 'log', ['😀'.repeat(1000)])
    const small = readFileSync(join(smallDirectory, 'diagnostic-0.log'), 'utf8')
    expect(Buffer.byteLength(small)).toBeLessThanOrEqual(128)
    expect(small).not.toContain('\ufffd')
  })

  test('Given 循环深层对象 BigInt getter 与 Error cause When 序列化 Then 安全并保留错误诊断字段', () => {
    const value: Record<string, unknown> = { bigint: 12n }
    value.self = value
    Object.defineProperty(value, 'bad', { enumerable: true, get() { throw new Error('不可调用') } })
    const error = new Error('外层 apiKey=outer-secret', { cause: new Error('内层 password=inner-secret') })
    const log = new DiagnosticLog(directory, { enabled: true })
    log.write('main', 'error', [value, error])
    const output = readCurrent()
    expect(output).toContain('[Circular]')
    expect(output).toContain('[Getter]')
    expect(output).toContain('12n')
    expect(output).toContain('外层')
    expect(output).toContain('内层')
    expect(output).toContain('stack')
    expect(output).toContain('cause')
    expect(output).not.toContain('outer-secret')
    expect(output).not.toContain('inner-secret')
    const deep: Record<string, unknown> = {}
    let child = deep
    for (let index = 0; index < 1000; index++) {
      const next: Record<string, unknown> = {}
      child.next = next
      child = next
    }
    log.write('main', 'log', [deep])
    expect(readCurrent()).toContain('[MaxDepth]')
    expect(log.getLastError()).toBeNull()
  })

  test('Given 结构化与字符串凭证 URL 和自由文本 key When 写入 Then 秘密被脱敏而诊断信息保留', () => {
    const log = new DiagnosticLog(directory, { enabled: true })
    log.write('renderer', 'error', [
      { key: 'struct-secret', apiKey: 'api-secret', nested: { password: 'pass-secret', accessToken: 'token-secret', authorization: 'auth-secret', bearer: 'bearer-secret' }, status: 503 },
      'authorization: Bearer header-secret; Bearer bare-secret key=text-secret token=query-secret password=pw-secret',
      'https://url-user:url-pass@example.test/path?access_token=url-token&ok=1 sk-proj-free-secret',
    ])
    const output = readCurrent()
    for (const secret of ['struct-secret', 'api-secret', 'pass-secret', 'token-secret', 'auth-secret', 'bearer-secret', 'header-secret', 'bare-secret', 'text-secret', 'query-secret', 'pw-secret', 'url-user', 'url-pass', 'url-token', 'sk-proj-free-secret']) expect(output).not.toContain(secret)
    expect(output).toContain('503')
    expect(output).toContain('example.test/path')
    expect(output).toContain('[REDACTED]')
  })

  test('Given 未创建或空日志 When 导出 Then 返回 empty 且不覆盖目标', () => {
    const log = new DiagnosticLog(directory)
    writeFileSync(destination, '保留目标')
    expect(log.exportTo(destination, metadata)).toBe('empty')
    mkdirSync(directory)
    writeFileSync(join(directory, 'diagnostic-0.log'), '')
    expect(log.exportTo(destination, metadata)).toBe('empty')
    expect(readFileSync(destination, 'utf8')).toBe('保留目标')
  })

  test('Given 遗留日志与敏感元信息 When 导出 Then 二次脱敏且不包含其他配置会话文件', () => {
    mkdirSync(directory)
    writeFileSync(join(directory, 'diagnostic-0.log'), 'legacy password=legacy-secret sk-old-secret')
    writeFileSync(join(directory, 'config.json'), 'config-secret')
    writeFileSync(join(directory, 'session.jsonl'), 'session-secret')
    writeFileSync(join(directory, 'diagnostic-99.log'), 'unretained-secret')
    const log = new DiagnosticLog(directory)
    expect(log.exportTo(destination, { ...metadata, version: 'apiKey=metadata-secret' })).toBe('exported')
    const output = readFileSync(destination, 'utf8')
    for (const secret of ['legacy-secret', 'sk-old-secret', 'metadata-secret', 'config-secret', 'session-secret', 'unretained-secret']) expect(output).not.toContain(secret)
    expect(output).toContain('platform: test')
    expect(output).toContain('arch: x64')
    expect(output).toContain('version:')
  })

  test('Given 有日志但目标不可写 When 导出 Then 抛出可处理 IO 异常且不覆盖源文件', () => {
    const log = new DiagnosticLog(directory, { enabled: true })
    log.write('main', 'log', ['保留'])
    expect(() => log.exportTo(join(root, 'missing', 'export.txt'), metadata)).toThrow()
    expect(() => log.exportTo(join(directory, 'diagnostic-0.log'), metadata)).toThrow()
    if (process.platform === 'win32') expect(() => log.exportTo(join(directory, 'DIAGNOSTIC-0.LOG'), metadata)).toThrow()
    expect(readCurrent()).toContain('保留')
  })

  test('Given 日志目录被普通文件占用 When 写入 Then 不崩溃并记录存储错误且恢复后清除', () => {
    writeFileSync(directory, '阻塞')
    const log = new DiagnosticLog(directory, { enabled: true })
    expect(() => log.write('main', 'warn', ['不能写入'])).not.toThrow()
    expect(log.getLastError()).not.toBeNull()
    rmSync(directory)
    log.write('main', 'warn', ['恢复'])
    expect(log.getLastError()).toBeNull()
    expect(readCurrent()).toContain('恢复')
  })

  test('Given 日志目录链接 When 写入或导出 Then 不读取或修改外部文件', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'diagnostic-0.log'), 'external-secret')
    symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
    const log = new DiagnosticLog(directory, { enabled: true })
    log.write('main', 'log', ['禁止'])
    expect(log.getLastError()).not.toBeNull()
    expect(() => log.exportTo(destination, metadata)).toThrow()
    expect(existsSync(destination)).toBe(false)
    expect(readFileSync(join(outside, 'diagnostic-0.log'), 'utf8')).toBe('external-secret')
  })

  test('Given 固定源文件链接 When 写入或导出 Then 不跟随到外部文件', () => {
    mkdirSync(directory)
    // 用目录 junction 同样覆盖固定源路径 lstat 检查，Windows 无需符号链接权限。
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(directory, 'diagnostic-0.log'), process.platform === 'win32' ? 'junction' : 'dir')
    const log = new DiagnosticLog(directory, { enabled: true })
    expect(() => log.exportTo(destination, metadata)).toThrow()
    log.write('main', 'log', ['禁止'])
    expect(log.getLastError()).not.toBeNull()
    expect(readdirSync(outside)).toEqual([])
  })

  test('Given 非法尺寸选项 When 初始化 Then 明确拒绝无效配置', () => {
    expect(() => new DiagnosticLog(directory, { maxFiles: 0 })).toThrow(RangeError)
    expect(() => new DiagnosticLog(directory, { maxFileBytes: NaN })).toThrow(RangeError)
    expect(() => new DiagnosticLog(directory, { maxEntryBytes: -1 })).toThrow(RangeError)
  })
})
