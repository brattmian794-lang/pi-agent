import { describe, expect, it } from 'bun:test'
import {
  WRITE_CONTENT_TOKEN_THRESHOLD,
  estimateTokenCount,
  evaluateWriteSizeLimit,
} from './agent-tool-token-estimator'

describe('Write 单次写入上限判定', () => {
  it('Given issue #29 的 82,900 字符 Write 载荷 When 判定 Then 拒绝并说明上限与分段写入方式', () => {
    // 复现 #29：一次 Write 生成约 82,900 字符的文件正文。
    const content = 'a'.repeat(82_900)
    const rejection = evaluateWriteSizeLimit('Write', { file_path: 'src/generated.ts', content })

    expect(rejection).not.toBeNull()
    expect(rejection!.chars).toBe(82_900)
    expect(rejection!.estimatedTokens).toBeGreaterThan(WRITE_CONTENT_TOKEN_THRESHOLD)
    expect(rejection!.limit).toBe(16_000)
    // 阈值、实际值与拒绝结论必须同时出现，避免「警告但已写入」的歧义。
    expect(rejection!.message).toContain('16000 tokens per call')
    expect(rejection!.message).toContain(`${rejection!.estimatedTokens} estimated tokens`)
    expect(rejection!.message).toContain('Write was rejected')
    expect(rejection!.message).toContain('Nothing was written to disk')
    // 模型必须知道如何分段写入，而不是重试同样的大文件。
    expect(rejection!.message).toContain('then use Edit repeatedly to append the remaining sections')
    expect(rejection!.message).toContain('old_string')
    expect(rejection!.message).toContain('new_string')
  })

  it('Given 中文长文本 When 判定 Then 保守估算同样触发拒绝', () => {
    const content = '超'.repeat(20_000)
    const rejection = evaluateWriteSizeLimit('Write', { file_path: 'notes.md', content })

    expect(estimateTokenCount(content)).toBeGreaterThan(WRITE_CONTENT_TOKEN_THRESHOLD)
    expect(rejection?.estimatedTokens).toBe(estimateTokenCount(content))
  })

  it('Given 单次可写完的内容 When 判定 Then 放行', () => {
    expect(evaluateWriteSizeLimit('Write', { file_path: 'a.ts', content: 'export const a = 1\n' })).toBeNull()
    // ASCII 26,000 字符 ≈ 6,500 tokens，仍在上限内。
    expect(evaluateWriteSizeLimit('Write', { file_path: 'a.ts', content: 'a'.repeat(26_000) })).toBeNull()
  })

  it('Given 非 Write 工具或非字符串正文 When 判定 Then 不拦截', () => {
    expect(evaluateWriteSizeLimit('Edit', { file_path: 'a.ts', content: 'x'.repeat(200_000) })).toBeNull()
    expect(evaluateWriteSizeLimit('Write', { file_path: 'a.ts' })).toBeNull()
  })
})
