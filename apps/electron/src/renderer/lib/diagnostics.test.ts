import { describe, expect, test } from 'bun:test'
import type { DiagnosticLogLevel } from '@proma/shared'
import { initializeDiagnosticCapture, rewriteResizeObserverLoop } from './diagnostics'

const VIEW = '/agent/session-1#bottom'
const CONTEXT = '视图=/agent/session-1#bottom 标题=会话 可见性=visible'
const LOOP_TEXT = ['ResizeObserver loop completed with undelivered notifications.']

describe('ResizeObserver 循环通知去重', () => {
  test('Given 同一视图连续四条同源通知 When 转发诊断 Then 只保留一条 warn 并附带视图上下文', () => {
    const reported = new Set<string>()
    const first = rewriteResizeObserverLoop('error', LOOP_TEXT, VIEW, CONTEXT, reported)
    expect(first).not.toBeNull()
    expect(first?.level).toBe('warn')
    expect(first?.values[0]).toContain('[渲染布局]')
    expect(first?.values[0]).toContain('ResizeObserver loop completed with undelivered notifications.')
    expect(first?.values[0]).toContain('同一视图只提示一次')
    expect(first?.values[1]).toBe(CONTEXT)
    // 标题与可见性用于定位触发布局循环的界面
    expect(first?.values[1]).toContain('标题=')
    expect(first?.values[1]).toContain('可见性=')

    for (let index = 0; index < 3; index++) {
      expect(rewriteResizeObserverLoop('error', LOOP_TEXT, VIEW, CONTEXT, reported)).toBeNull()
    }
    expect(reported.size).toBe(1)
  })

  test('Given 同一条通知来自不同视图 When 转发诊断 Then 每个视图各保留一条', () => {
    const reported = new Set<string>()
    const first = rewriteResizeObserverLoop('error', LOOP_TEXT, '/agent/a', '视图=/agent/a', reported)
    const second = rewriteResizeObserverLoop('error', LOOP_TEXT, '/agent/b', '视图=/agent/b', reported)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second?.values[1]).toBe('视图=/agent/b')
  })

  test('Given 同一视图出现不同来源的布局通知 When 转发诊断 Then 按文本分别保留', () => {
    const reported = new Set<string>()
    const first = rewriteResizeObserverLoop('error', LOOP_TEXT, VIEW, CONTEXT, reported)
    const second = rewriteResizeObserverLoop(
      'error',
      ['ResizeObserver loop limit exceeded (composer)'],
      VIEW,
      CONTEXT,
      reported,
    )
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second?.values[0]).toContain('ResizeObserver loop limit exceeded (composer)')
  })

  test('Given 同一视图同一通知但序列化栈信息不同 When 转发 Then 仍只保留一条', () => {
    const reported = new Set<string>()
    const first = rewriteResizeObserverLoop(
      'error',
      ['ResizeObserver loop completed with undelivered notifications. at MessageList@/app.js:10:2'],
      VIEW,
      CONTEXT,
      reported,
    )
    const second = rewriteResizeObserverLoop(
      'error',
      ['ResizeObserver loop completed with undelivered notifications. at Composer@/app.js:99:7'],
      VIEW,
      CONTEXT,
      reported,
    )
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(reported.size).toBe(1)
  })

  test('Given 与布局无关的诊断 When 转发 Then 保持原级别与内容不变', () => {
    const reported = new Set<string>()
    const rewrite = rewriteResizeObserverLoop('log', ['[Agent] 普通进度'], VIEW, CONTEXT, reported)
    expect(rewrite).toEqual({ level: 'log', values: ['[Agent] 普通进度'] })
    expect(reported.size).toBe(0)
  })

  test('Given 定位文本超长 When 重写 Then 只保留前 500 字符片段且前缀完整', () => {
    const reported = new Set<string>()
    const longText = `ResizeObserver loop ${'细'.repeat(800)}`
    const rewrite = rewriteResizeObserverLoop('error', [longText], VIEW, CONTEXT, reported)
    const message = rewrite?.values[0] ?? ''
    // 前缀说明 + 最多 500 字符原文，避免把整段布局文本塞进诊断日志。
    expect(message.startsWith('[渲染布局]')).toBe(true)
    expect(message).toContain(longText.slice(0, 500))
    expect(message).not.toContain(longText.slice(0, 501))
    expect(message.length).toBeLessThan(600)
  })

  test('Given 去重表已满 When 出现新视图通知 Then 清空后继续记录而不是永久丢弃', () => {
    const reported = new Set<string>()
    for (let index = 0; index < 50; index++) {
      rewriteResizeObserverLoop('error', [`ResizeObserver loop ${index}`], `/view-${index}`, CONTEXT, reported)
    }
    expect(reported.size).toBe(50)
    const rewrite = rewriteResizeObserverLoop('error', ['ResizeObserver loop overflow'], '/view-new', CONTEXT, reported)
    expect(rewrite).not.toBeNull()
    expect(reported.size).toBe(1)
  })
})

describe('渲染层诊断采集链路', () => {
  test('Given 诊断已开启 When 浏览器连续抛出四条 ResizeObserver 循环错误 Then 仅向主进程转发一条 warn', async () => {
    const records: Array<{ level: DiagnosticLogLevel; values: string[] }> = []
    const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    const globals = globalThis as unknown as Record<string, unknown>
    const previousWindow = globals.window
    const previousDocument = globals.document
    // 静音原始输出避免测试刷屏；初始化后的包装层仍会透传到这里。
    console.log = () => {}
    console.info = () => {}
    console.warn = () => {}
    console.error = () => {}
    globals.window = {
      location: { pathname: '/agent/session-1', hash: '#bottom' },
      addEventListener: () => {},
      electronAPI: {
        onDiagnosticStateChanged: () => () => {},
        getDiagnosticState: async () => ({ enabled: true }),
        recordDiagnosticLog: (input: { level: DiagnosticLogLevel; values: string[] }) => { records.push(input) },
      },
    }
    globals.document = { title: '会话', visibilityState: 'visible' }
    try {
      initializeDiagnosticCapture()
      // 等待开关快照落库，否则转发会因 enabled 未就绪被丢弃。
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const loop = new Error('ResizeObserver loop completed with undelivered notifications.')
      for (let index = 0; index < 4; index++) console.error(loop)
      expect(records).toHaveLength(1)
      expect(records[0]?.level).toBe('warn')
      expect(records[0]?.values[0]).toContain('[渲染布局]')
      expect(records[0]?.values[1]).toContain('视图=/agent/session-1#bottom')
      expect(records[0]?.values[1]).toContain('标题=会话')
    } finally {
      Object.assign(console, originalConsole)
      globals.window = previousWindow
      globals.document = previousDocument
    }
  })
})
