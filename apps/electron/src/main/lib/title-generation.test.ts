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

describe('安全标题归一化与本地回退', () => {
  test('Given 推理和最终文本混合 When 归一化 Then 只保留明确的最终文本块', () => {
    expect(sanitizeGeneratedTitle([
      { type: 'thinking', text: '推理过程' },
      { type: 'reasoning', text: '分析过程' },
      { type: 'text', text: '真实' },
      { type: 'output_text', text: '标题' },
      { type: 'tool_use', text: '工具内容' },
    ])).toBe('真实标题')
    expect(sanitizeGeneratedTitle({ type: 'thinking', text: '不可见' })).toBeNull()
    expect(sanitizeGeneratedTitle([{ text: '未声明类型' }])).toBeNull()
    expect(sanitizeGeneratedTitle('<think>推理过程</think>最终标题')).toBe('最终标题')
    expect(sanitizeGeneratedTitle('<think>尚未完成的推理')).toBeNull()
  })

  test('Given 普通中英文与多行消息 When 回退 Then 保留首行正文并清理 Markdown', () => {
    expect(createFallbackTitle('修复自动标题')).toBe('修复自动标题')
    expect(createFallbackTitle('Fix session title\nsecond line')).toBe('Fix session title')
    expect(createFallbackTitle('修复 API/UI 标题')).toBe('修复 API/UI 标题')
    expect(createFallbackTitle('\n## 设计标题\n第二行')).toBe('设计标题')
  })

  test('Given 编码文件引用与邻接正文 When 回退 Then 选择正文且不截断原始引用', () => {
    expect(createFallbackTitle('请检查指定的 @file:D%3A%5CWorkspace%5Creport.pdf')).toBe('请检查指定的')
    expect(createFallbackTitle('@file:D%3A%5CWorkspace%5Creport.pdf修复标题')).toBe('修复标题')
    expect(createFallbackTitle('@file:notes%2Fbrief.md\n总结这份报告')).toBe('总结这份报告')
  })

  test('Given 只有文件或路径 When 回退 Then 最多保留解码后的文件名', () => {
    for (const input of [
      '@file:D%3A%5CWorkspace%5C%E6%8A%A5%E5%91%8A.pdf',
      'D:\\Workspace\\报告.pdf',
      '/Users/me/报告.pdf',
      '/Users/me/My Docs/报告.pdf',
      'C:\\My Files\\报告.pdf',
      '@C:\\Workspace\\报告.pdf',
      '@file:"C:\\My Files\\报告.pdf"',
      '`C:\\My Files\\报告.pdf`',
      '\\\\server\\share\\报告.pdf',
      '@file:报告.pdf',
      'notes/报告.pdf',
      'notes\\报告.pdf',
      'D%3A%5CWorkspace%5C%E6%8A%A5%E5%91%8A.pdf',
    ]) expect(createFallbackTitle(input)).toBe('报告.pdf')
  })

  test('Given URL 或混合正文 When 回退 Then 不暴露或截断链接', () => {
    expect(createFallbackTitle('https://example.com/private/path?q=secret')).toBeNull()
    expect(createFallbackTitle('http://192.168.1.2:8080/page')).toBeNull()
    expect(createFallbackTitle('[](https://example.com/private)')).toBeNull()
    expect(createFallbackTitle('![附件](attachment://image-123)')).toBeNull()
    expect(createFallbackTitle('请只检查页面 http://192.168.1.2:8080/page')).toBe('请只检查页面')
    expect(createFallbackTitle('修复 [预览页面](https://example.com/secret) 的问题')).toBe('修复 预览页面 的问题')
    expect(createFallbackTitle('请修复 C:\\Workspace\\report.pdf 的格式')).toBe('请修复 的格式')
  })

  test('Given 附件块或损坏引用 When 回退 Then 不把标记当作主题', () => {
    expect(createFallbackTitle('<attached_files>\n<file path="D:\\private\\secret.pdf" />\n</attached_files>\n分析报告')).toBe('分析报告')
    expect(createFallbackTitle('![附件](attachment://image-123)\n描述图片')).toBe('描述图片')
    expect(createFallbackTitle('@file:D%3A%5Cbad%ZZ.pdf')).toBeNull()
    expect(createFallbackTitle('@file:')).toBeNull()
    expect(createFallbackTitle('  \n  ')).toBeNull()
  })

  test('Given 超长多字节标题 When 截断 Then 不拆开代理字符且不超过二十个字符', () => {
    const title = '中'.repeat(19) + '😀结束'
    for (const result of [createFallbackTitle(title), sanitizeGeneratedTitle(title)]) {
      expect(result).toBe('中'.repeat(19) + '😀')
      expect(Array.from(result ?? '')).toHaveLength(20)
      expect(result?.isWellFormed()).toBe(true)
    }
  })
})
