import { describe, expect, test } from 'bun:test'
import { createFallbackTitle, sanitizeGeneratedTitle } from './title-generation'

describe('Agent 会话自动标题规则', () => {
  test('Given 模型未返回可用标题 When 使用首条有效消息兜底 Then 清理 Markdown 并截取首行', () => {
    expect(createFallbackTitle('## 设计自动命名\n后续内容')).toBe('设计自动命名')
  })

  test('Given 模型返回有效标题 When 清理标题 Then 保留模型生成结果', () => {
    expect(sanitizeGeneratedTitle('  "模型标题"  ')).toBe('模型标题')
  })

  test('Given 空白消息 When 生成兜底标题 Then 返回 null', () => {
    expect(createFallbackTitle('  \n  ')).toBeNull()
  })
})
