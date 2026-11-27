import type { DiagnosticLogLevel } from '@proma/shared'

const LEVELS: DiagnosticLogLevel[] = ['log', 'info', 'warn', 'error']
type DiagnosticConsole = Pick<Console, DiagnosticLogLevel>

/** 不改变原有 Console 行为；采集异常与重入不影响应用。返回卸载函数方便测试。 */
export function installDiagnosticConsole(
  target: DiagnosticConsole,
  record: (level: DiagnosticLogLevel, values: unknown[]) => void,
): () => void {
  const originals = new Map<DiagnosticLogLevel, DiagnosticConsole[DiagnosticLogLevel]>()
  let writing = false
  for (const level of LEVELS) {
    const original = target[level]
    originals.set(level, original)
    target[level] = (...values: unknown[]): void => {
      if (!writing) {
        writing = true
        try { record(level, values) } catch { /* 诊断不可影响原日志 */ } finally { writing = false }
      }
      original.apply(target, values)
    }
  }
  return () => { for (const [level, original] of originals) target[level] = original }
}

/** 浏览器端有界序列化，避免 getters、循环对象和超大值拖慢 IPC。 */
export function serializeDiagnosticValues(values: unknown[]): string[] {
  let nodes = 0
  const seen = new WeakSet<object>()
  const normalize = (value: unknown, depth = 0): unknown => {
    if (++nodes > 200 || depth > 6) return '[已截断]'
    if (typeof value === 'string') return value.slice(0, 16384)
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (value instanceof Error) return {
      name: value.name, message: normalize(value.message, depth + 1),
      stack: normalize(value.stack, depth + 1), cause: normalize(value.cause, depth + 1),
    }
    if (Array.isArray(value)) return value.slice(0, 30).map((item) => normalize(item, depth + 1))
    const result: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value).slice(0, 30)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      result[key] = descriptor && 'value' in descriptor ? normalize(descriptor.value, depth + 1) : '[Getter]'
    }
    return result
  }
  let remaining = 16384
  const result: string[] = []
  for (const value of values.slice(0, 20)) {
    if (remaining <= 0) break
    let text: string
    try { text = typeof value === 'string' ? value : JSON.stringify(normalize(value)) ?? String(value) }
    catch { text = '[无法序列化]' }
    const limited = text.slice(0, remaining)
    result.push(limited)
    remaining -= limited.length
  }
  return result
}

const TRANSPORT_CHANNEL_PATTERN = /\[ws\]|websocket/i
const TRANSPORT_TIMEOUT_PATTERN = /(?:timeout of|timed out after)\s+(\d+)\s*ms/i

/** 去掉日志里的凭据片段：URL 中的 key/token 参数与 Authorization 头。 */
export function scrubCredentialFragments(text: string): string {
  return text
    .replace(/([?&](?:api_?key|key|token|access_token|signature|sig|secret|password)=)[^&\s"']+/gi, '$1[已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [已隐藏]')
}

/**
 * 底层库（如 Pi SDK 的 WS 通道）用 console.log 写出传输层超时，
 * 这里提升为可筛选的告警级，并补齐不含凭据的连接上下文与重连状态说明。
 */
export function refineTransportLog(
  level: DiagnosticLogLevel,
  values: unknown[],
): { level: DiagnosticLogLevel; values: unknown[] } {
  if (level === 'warn' || level === 'error') return { level, values }
  const text = serializeDiagnosticValues(values).join(' ')
  if (!TRANSPORT_CHANNEL_PATTERN.test(text) || !TRANSPORT_TIMEOUT_PATTERN.test(text)) return { level, values }
  const timeoutMs = TRANSPORT_TIMEOUT_PATTERN.exec(text)?.[1] ?? '未知'
  const note = `[传输层] WebSocket 请求超时（${timeoutMs}ms）：本次连接结果未知，是否已重连需由后续运行时事件确认`
  return {
    level: 'warn',
    values: [note, ...values.map((value) => (typeof value === 'string' ? scrubCredentialFragments(value) : value))],
  }
}
