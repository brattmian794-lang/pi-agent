import { describe, expect, mock, test } from 'bun:test'
import type { SDKMessage } from '@proma/shared'

// agent-session-manager 在模块顶层引用 electron 能力；截断逻辑本身与它们无关。
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => process.cwd() },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

const { sanitizeOversizedMessage } = await import('./agent-session-manager')
const { validateToolInput } = await import('./agent-tool-input-validator')

const MAX_SDK_MESSAGE_LENGTH = 256 * 1024

describe('工具参数缺失诊断', () => {
  test('Given Edit 缺少 old_string/new_string When 校验 Then 报出全部缺失字段名', () => {
    const failure = validateToolInput('Edit', { file_path: 'src/main.ts', old_string: '' })
    expect(failure?.behavior).toBe('deny')
    expect(failure?.missingParams).toEqual(['old_string', 'new_string'])
    expect(failure?.message).toContain('old_string')
  })

  test('Given 参数完整或工具未知 When 校验 Then 放行', () => {
    expect(validateToolInput('Edit', { file_path: 'a', old_string: 'b', new_string: 'c' })).toBeNull()
    expect(validateToolInput('UnknownTool', {})).toBeNull()
  })

  test('Given Edit 缺少参数且已带文件正文 When 校验 Then 只报字段名并给出可重试的指引', () => {
    const failure = validateToolInput('Edit', {
      file_path: 'src/secret.ts',
      content: '这是绝不能进入日志的文件正文',
    })
    expect(failure?.missingParams).toEqual(['old_string', 'new_string'])
    expect(failure?.message).toContain('old_string')
    expect(failure?.message).toContain('new_string')
    expect(failure?.message).toContain('retry with all required parameters')
    expect(failure?.message).not.toContain('这是绝不能进入日志的文件正文')
  })
})

describe('超大 SDKMessage 存储截断', () => {
  test('Given 多段中等长度内容叠加超限 When 截断 Then 写入行回到存储上限内', () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      type: 'text',
      text: `片段${index}:` + '内'.repeat(5000),
    }))
    const message = {
      type: 'assistant',
      uuid: 'uuid-1',
      session_id: 'session-1',
      message: { role: 'assistant', content: blocks },
    } as unknown as SDKMessage
    const originalLength = JSON.stringify(message).length
    expect(originalLength).toBeGreaterThan(MAX_SDK_MESSAGE_LENGTH)

    const serialized = JSON.stringify(sanitizeOversizedMessage(message, originalLength))
    expect(serialized.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
    expect(serialized).toContain('uuid-1')
  })

  test('Given 结构与超长字符串都无法收敛 When 截断 Then 降级为占位消息且保留可识别字段', () => {
    const message = {
      type: 'assistant',
      uuid: 'uuid-2',
      session_id: 'session-2',
      payload: Object.fromEntries(
        Array.from({ length: 2000 }, (_, index) => [`key${index}`, 'x'.repeat(4000)]),
      ),
    } as unknown as SDKMessage
    const originalLength = JSON.stringify(message).length
    const serialized = JSON.stringify(sanitizeOversizedMessage(message, originalLength))
    expect(serialized.length).toBeLessThanOrEqual(MAX_SDK_MESSAGE_LENGTH)
    expect(serialized).toContain('uuid-2')
    expect(serialized).toContain('_truncated')
  })

  test('Given 未超限消息 When 截断 Then 内容保持不变', () => {
    const message = {
      type: 'user',
      uuid: 'uuid-3',
      message: { role: 'user', content: [{ type: 'text', text: '短内容' }] },
    } as unknown as SDKMessage
    const serialized = JSON.stringify(sanitizeOversizedMessage(message, 120))
    expect(serialized).toContain('短内容')
    expect(serialized).not.toContain('_truncated')
  })
})
