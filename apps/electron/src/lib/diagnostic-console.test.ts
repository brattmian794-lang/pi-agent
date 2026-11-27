import { describe, expect, test } from 'bun:test'
import { installDiagnosticConsole, refineTransportLog, scrubCredentialFragments, serializeDiagnosticValues } from './diagnostic-console'

describe('诊断 Console 采集', () => {
  test('Given 原始 Console When 采集四种级别 Then 保留原输出并传递 Error 对象', () => {
    const original: unknown[][] = []
    const captured: unknown[][] = []
    const output = (...values: unknown[]): void => { original.push(values) }
    const target = { log: output, info: output, warn: output, error: output }
    const uninstall = installDiagnosticConsole(target, (level, values) => { captured.push([level, ...values]) })
    const error = new Error('请求失败')
    target.log('日志'); target.info('信息'); target.warn('警告'); target.error(error)
    expect(captured.map((entry) => entry[0])).toEqual(['log', 'info', 'warn', 'error'])
    expect(captured[3]?.[1]).toBe(error)
    expect(original.length).toBe(4)
    uninstall()
    target.log('恢复')
    expect(captured.length).toBe(4)
    expect(original.length).toBe(5)
  })

  test('Given 采集器抛出或重入 When 输出日志 Then 不递归且继续原输出', () => {
    let calls = 0
    const output = (..._values: unknown[]): void => { calls++ }
    const target = { log: output, info: output, warn: output, error: output }
    installDiagnosticConsole(target, () => { target.error('内部失败'); throw new Error('写入失败') })
    expect(() => target.log()).not.toThrow()
    expect(calls).toBe(2)
  })

  test('Given 循环、Error、getter 与超大对象 When 前端序列化 Then 保留栈且限定大小', () => {
    const object: Record<string, unknown> = { error: new Error('通道失败', { cause: new Error('网络异常') }) }
    object.self = object
    Object.defineProperty(object, 'secretGetter', { get: () => { throw new Error('不应访问') } })
    const result = serializeDiagnosticValues([object])
    expect(result.join('')).toContain('通道失败')
    expect(result.join('')).toContain('网络异常')
    expect(result.join('')).toContain('stack')
    expect(result.join('')).toContain('[Circular]')
    expect(result.join('')).toContain('[Getter]')
    const large = serializeDiagnosticValues(['字'.repeat(50000), '尾部'])
    expect(large.join('').length).toBeLessThanOrEqual(16384)
    expect(serializeDiagnosticValues([1n, undefined])).toEqual(['"1"', 'undefined'])
  })
})

describe('传输层超时日志分级', () => {
  test('Given WS 通道用普通级别输出 15 秒超时 When 写入诊断日志 Then 提升为告警并补齐超时与重连状态', () => {
    const refined = refineTransportLog('log', ['[ws]', 'timeout of 15000ms exceeded'])
    expect(refined.level).toBe('warn')
    const text = refined.values.join(' ')
    expect(text).toContain('[传输层]')
    expect(text).toContain('15000ms')
    expect(text).toContain('结果未知')
    expect(text).toContain('重连')
  })

  test('Given 已是告警或与传输无关的普通日志 When 分级 Then 保持原级别与内容', () => {
    expect(refineTransportLog('warn', ['[ws]', 'timeout of 15000ms exceeded']).level).toBe('warn')
    const unrelated = refineTransportLog('log', ['[Agent] 普通进度'])
    expect(unrelated.level).toBe('log')
    expect(unrelated.values).toEqual(['[Agent] 普通进度'])
  })

  test('Given 日志含 key/token 与 Authorization When 脱敏 Then 仅保留参数名', () => {
    const scrubbed = scrubCredentialFragments('wss://host/ws?api_key=sk-secret&token=abc Bearer eyJhbGciOi.xx')
    expect(scrubbed).not.toContain('sk-secret')
    expect(scrubbed).not.toContain('abc')
    expect(scrubbed).not.toContain('eyJhbGciOi')
    expect(scrubbed).toContain('api_key=[已隐藏]')
  })
})
