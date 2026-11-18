import { describe, expect, test } from 'bun:test'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'

const anthropic = new AnthropicAdapter('kimi-coding')
const openai = new OpenAIAdapter('custom')
const responses = new OpenAIResponsesAdapter()
const google = new GoogleAdapter()
const titleInput = { baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', modelId: 'k3.1-pro', prompt: '生成标题' }

describe('标题请求输出预算与协议兼容', () => {
  test('Given Responses 标题请求 When 构造请求 Then 保留推理和最终文本的输出空间且不猜测推理参数', () => {
    const body = JSON.parse(responses.buildTitleRequest(titleInput).body) as Record<string, unknown>
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(512)
    expect(body.reasoning).toBeUndefined()
    expect(body.input).toEqual([{ role: 'user', content: '生成标题' }])
  })

  test('Given Anthropic 兼容模型 When 构造标题请求 Then 扩大预算且仅按既有能力禁用推理', () => {
    for (const modelId of ['k3.1-pro', 'deepseek-reasoner', 'MiniMax-M2', 'claude-sonnet-4-5', 'claude-mythos-preview']) {
      const body = JSON.parse(anthropic.buildTitleRequest({ ...titleInput, modelId }).body) as Record<string, unknown>
      expect(body.max_tokens).toBeGreaterThanOrEqual(512)
      expect(body.output_config).toBeUndefined()
    }
    const claude = new AnthropicAdapter()
    const knownBody = JSON.parse(claude.buildTitleRequest({ ...titleInput, modelId: 'claude-sonnet-4-5' }).body) as Record<string, unknown>
    expect(knownBody.thinking).toEqual({ type: 'disabled' })
  })

  test('Given Google 标题请求 When 构造请求 Then 为推理与最终文本留出预算', () => {
    const body = JSON.parse(google.buildTitleRequest(titleInput).body) as { generationConfig: { maxOutputTokens: number } }
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(512)
  })
})

describe('标题响应仅提取最终文本', () => {
  test('Given Kimi 或 MiniMax 的纯 thinking 响应 When 解析标题 Then 不再从最后一行猜标题', () => {
    for (const thinking of ['用户要求根据第一条消息生成简短对话标题', '先分析\n- 这仍然是推理']) {
      expect(anthropic.parseTitleResponse({ content: [{ type: 'thinking', thinking }] })).toBeNull()
    }
  })

  test('Given 混合内容块 When 解析 Anthropic 标题 Then 拼接最终文本并排除推理和工具内容', () => {
    expect(anthropic.parseTitleResponse({ content: [
      { type: 'thinking', thinking: '内部推理', text: '也不能读取这个字段' },
      { type: 'text', text: '修复' },
      { type: 'tool_use', text: '忽略工具内容' },
      { type: 'text', text: '自动命名' },
    ] })).toBe('修复自动命名')
  })

  test('Given OpenAI 兼容内容块 When 解析标题 Then 返回字符串且忽略 reasoning_content', () => {
    expect(openai.parseTitleResponse({ choices: [{ message: { reasoning_content: '秘密', content: [
      { type: 'thinking', text: '不作为标题' },
      { type: 'reasoning', text: '不作为标题' },
      { type: 'text', text: '有效标题' },
    ] } }] })).toBe('有效标题')
    expect(openai.parseTitleResponse({ choices: [{ message: { reasoning_content: '不作为标题', content: null } }] })).toBeNull()
    expect(openai.parseTitleResponse({ choices: [{ message: { content: ' 普通标题 ' } }] })).toBe('普通标题')
  })

  test('Given Responses 混合输出 When 解析标题 Then 只接受 assistant message 的 output_text', () => {
    expect(responses.parseTitleResponse({ output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: '内部推理' }], summary: [{ text: '内部摘要' }] },
      { type: 'message', role: 'user', content: [{ type: 'output_text', text: '用户输入' }] },
      { type: 'message', role: 'assistant', content: [
        { type: 'refusal', refusal: '拒绝内容' },
        { type: 'reasoning_text', text: '秘密' },
        { type: 'output_text', text: '最终标题' },
      ] },
    ] })).toBe('最终标题')
    expect(responses.parseTitleResponse({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: '不能生成' }] }] })).toBeNull()
  })

  test('Given Google 的 thought 与可见文本 When 解析标题 Then 仅提取可见文本', () => {
    expect(google.parseTitleResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: '内部推理' },
      { functionCall: { name: 'tool' }, text: '工具内容' },
      { text: '可见标题' },
    ] } }] })).toBe('可见标题')
    expect(google.parseTitleResponse({ candidates: [{ content: { parts: [{ thought: true, text: '只有推理' }] } }] })).toBeNull()
    expect(google.parseTitleResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '未完成标' }] } }] })).toBeNull()
  })

  test('Given 不完整响应 When token 耗尽 Then 不保存推理或截断的文本', () => {
    expect(responses.parseTitleResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
      { type: 'reasoning', summary: [{ text: '尚未完成' }] },
    ] })).toBeNull()
    expect(responses.parseTitleResponse({ status: 'incomplete', output_text: '尚未完成的标' })).toBeNull()
    expect(anthropic.parseTitleResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '截断标' }] })).toBeNull()
    expect(openai.parseTitleResponse({ choices: [{ finish_reason: 'length', message: { content: '截断标' } }] })).toBeNull()
  })

  test('Given 空响应或无效数据 When 解析标题 Then 安全返回 null', () => {
    for (const adapter of [anthropic, openai, responses, google]) {
      for (const value of [null, undefined, {}, [], { content: [{ type: 'text', text: 123 }] }, { output_text: 123 }, { output: 'bad' }, { choices: [] }]) {
        expect(adapter.parseTitleResponse(value)).toBeNull()
      }
    }
  })
})
