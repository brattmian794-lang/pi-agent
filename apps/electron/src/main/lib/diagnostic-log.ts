import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { redactSensitiveLogText } from './bridge-log-redaction'
import { writeTextFileAtomic } from './safe-file'

export interface DiagnosticLogOptions {
  enabled?: boolean
  maxFileBytes?: number
  maxFiles?: number
  maxEntryBytes?: number
}

export interface DiagnosticLogMetadata {
  version: string
  platform: string
  arch: string
}

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /key|authorization|authentication|bearer|token|password|secret|credential|webhook/i

/** 在写入和导出两个边界都执行脱敏，不依赖 Electron 或配置存储。 */
function redact(text: string): string {
  return redactSensitiveLogText(text)
    .replace(/(\b(?:key|bearer)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, `$1${REDACTED}`)
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\bsk-[a-z0-9_-]+/gi, REDACTED)
}

/** 不调用用户 toJSON/getter；限制深度、节点和字符串，避免循环或异常对象阻断日志。 */
function serialize(values: unknown[], stringLimit: number): string {
  const seen = new WeakSet<object>()
  let remaining = 2000
  function visit(value: unknown, depth: number): unknown {
    if (--remaining < 0) return '[Truncated]'
    if (typeof value === 'string') return truncateUtf8(redact(value), stringLimit)
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'function') return '[Function]'
    if (typeof value === 'symbol') return String(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    if (depth >= 12) return '[MaxDepth]'
    seen.add(value)
    try {
      if (value instanceof Error) {
        return {
          name: visit(value.name, depth + 1),
          message: visit(value.message, depth + 1),
          stack: visit(value.stack, depth + 1),
          cause: visit(value.cause, depth + 1),
        }
      }
      if (Array.isArray(value)) {
        const result: unknown[] = []
        for (let index = 0; index < value.length && remaining > 0; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          result.push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]')
        }
        return result
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(value)) {
        if (remaining <= 0) break
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        result[truncateUtf8(redact(key), stringLimit)] = SENSITIVE_KEY.test(key)
          ? REDACTED
          : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]'
      }
      return result
    } catch {
      return '[Unserializable]'
    }
  }
  return JSON.stringify(visit(values, 0)) ?? '[Unserializable]'
}

function truncateUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  const suffix = ' [Truncated]'
  let end = Math.max(0, bytes - Buffer.byteLength(suffix))
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8') + suffix
}

function positiveInteger(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError('诊断日志尺寸选项无效')
  return value
}

function statIfPresent(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export class DiagnosticLog {
  private enabled: boolean
  private readonly directory: string
  private readonly maxFileBytes: number
  private readonly maxFiles: number
  private readonly maxEntryBytes: number
  private lastError: string | null = null

  constructor(directory: string, options: DiagnosticLogOptions = {}) {
    this.directory = resolve(directory)
    this.enabled = options.enabled ?? false
    this.maxFileBytes = positiveInteger(options.maxFileBytes, 5 * 1024 * 1024, 128)
    this.maxFiles = positiveInteger(options.maxFiles, 5)
    this.maxEntryBytes = Math.min(positiveInteger(options.maxEntryBytes, 16 * 1024, 128), this.maxFileBytes)
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled }
  isEnabled(): boolean { return this.enabled }
  getDirectory(): string { return this.directory }
  getLastError(): string | null { return this.lastError }

  private file(index: number): string { return join(this.directory, `diagnostic-${index}.log`) }

  /** 检查整个目录链，防止父目录链接绕过固定源文件检查。 */
  private checkDirectory(): void {
    let current = this.directory
    for (;;) {
      const stat = statIfPresent(current)
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('诊断日志目录不是安全目录')
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  private checkFiles(): void {
    this.checkDirectory()
    for (let index = 0; index < this.maxFiles; index++) {
      const stat = statIfPresent(this.file(index))
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('诊断日志源文件不是安全普通文件')
    }
  }

  write(source: 'main' | 'renderer', level: 'log' | 'info' | 'warn' | 'error', values: unknown[]): void {
    if (!this.enabled) return
    try {
      this.checkFiles()
      mkdirSync(this.directory, { recursive: true })
      const prefix = `${new Date().toISOString()} [${source}] [${level}] `
      const entry = truncateUtf8(prefix + serialize(values, this.maxEntryBytes), this.maxEntryBytes - 1) + '\n'
      const current = statIfPresent(this.file(0))
      if (current && current.size + Buffer.byteLength(entry) > this.maxFileBytes) {
        for (let index = this.maxFiles - 1; index >= 0; index--) {
          const path = this.file(index)
          if (!statIfPresent(path)) continue
          if (index === this.maxFiles - 1) unlinkSync(path)
          else renameSync(path, this.file(index + 1))
        }
      }
      appendFileSync(this.file(0), entry, { encoding: 'utf8', mode: 0o600 })
      this.lastError = null
    } catch (error) {
      // 绝不 console：调用方可能正在捕获 console，递归会导致崩溃。
      try { this.lastError = redact(error instanceof Error ? error.message : '诊断日志写入失败') } catch { this.lastError = '诊断日志写入失败' }
    }
  }

  /** 仅导出固定保留文件；错误交给调用方显示，不读取配置或会话。 */
  exportTo(destination: string, metadata: DiagnosticLogMetadata): 'exported' | 'empty' {
    this.checkFiles()
    const target = resolve(destination)
    const comparable = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
    for (let index = 0; index < this.maxFiles; index++) {
      if (comparable(target) === comparable(this.file(index))) throw new Error('不能覆盖诊断日志源文件')
    }
    const sections: string[] = []
    for (let index = this.maxFiles - 1; index >= 0; index--) {
      const path = this.file(index)
      const stat = statIfPresent(path)
      if (!stat || stat.size === 0) continue
      if (stat.size > this.maxFileBytes) throw new Error('诊断日志源文件超过尺寸限制')
      sections.push(`--- diagnostic-${index}.log ---\n${redact(readFileSync(path, 'utf8'))}`)
    }
    if (sections.length === 0) return 'empty'
    const header = redact(`Proma 诊断日志\nversion: ${metadata.version}\nplatform: ${metadata.platform}\narch: ${metadata.arch}\n`)
    writeTextFileAtomic(target, `${header}\n${sections.join('\n')}`)
    return 'exported'
  }
}
