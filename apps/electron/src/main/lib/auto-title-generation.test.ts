import { describe, expect, mock, test } from 'bun:test'
import { AnthropicAdapter, OpenAIAdapter, OpenAIResponsesAdapter, fetchTitle } from '@proma/core/providers'
import type { ProviderAdapter } from '@proma/core/providers'
import { autoGenerateSessionTitle } from './auto-title-generation'
import type { AutomaticTitleEnvironment } from './auto-title-generation'
import { createFallbackTitle, sanitizeGeneratedTitle, TITLE_PROMPT } from './title-generation'

function createSession(title = '新 Agent 会话', branch = false) {
  let meta: ReturnType<AutomaticTitleEnvironment['getSessionMeta']> = {
    title,
    ...(branch && { explorationParentSessionId: 'parent' }),
  }
  const updateSessionMeta = mock<AutomaticTitleEnvironment['updateSessionMeta']>((updates) => {
    if (meta) meta = { ...meta, ...updates }
  })
  const onTitleUpdated = mock<(title: string) => void>(() => {})
  return {
    getSessionMeta: () => meta && { ...meta },
    updateSessionMeta,
    onTitleUpdated,
    rename: (newTitle: string) => { if (meta) meta = { ...meta, title: newTitle } },
    remove: () => { meta = undefined },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

interface ResponseCase {
  name: string
  adapter: ProviderAdapter
  body?: unknown
  status?: number
  networkError?: boolean
}

const responseCases: ResponseCase[] = [
  { name: 'HTTP 400', adapter: new AnthropicAdapter('kimi-coding'), status: 400, body: { error: 'invalid_request' } },
  { name: '网络异常', adapter: new OpenAIAdapter('custom'), networkError: true },
  { name: '空响应', adapter: new OpenAIAdapter('custom'), body: { choices: [] } },
  { name: 'Kimi 只有 thinking', adapter: new AnthropicAdapter('kimi-coding'), body: { content: [{ type: 'thinking', thinking: '用户要求生成标题\n- 这是内部分析' }] } },
  { name: 'Responses token 耗尽', adapter: new OpenAIResponsesAdapter(), body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', summary: [{ text: '内部分析' }] }] } },
]

describe('自动标题请求、回退和保存链路', () => {
  for (const fixture of responseCases) {
    test(`Given ${fixture.name} When 自动命名 Then 仅保存安全回退且请求不重试`, async () => {
      const userMessage = '请检查 @file:D%3A%5Cprivate%5Creport.pdf http://192.168.1.2:8080/path'
      const session = createSession()
      const fetchFn = mock(async () => {
        if (fixture.networkError) throw new Error('模拟网络中断')
        return new Response(JSON.stringify(fixture.body), { status: fixture.status ?? 200 })
      })
      const request = fixture.adapter.buildTitleRequest({
        baseUrl: 'https://example.invalid/v1', apiKey: 'test', modelId: 'test-model', prompt: TITLE_PROMPT + userMessage,
      })
      await autoGenerateSessionTitle(userMessage, {
        ...session,
        generateTitle: async () => sanitizeGeneratedTitle(await fetchTitle(request, fixture.adapter, fetchFn as unknown as typeof fetch))
          ?? createFallbackTitle(userMessage),
      })
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(session.getSessionMeta()?.title).toBe('请检查')
      expect(session.updateSessionMeta).toHaveBeenCalledWith({ title: '请检查' })
      expect(session.onTitleUpdated).toHaveBeenCalledWith('请检查')
    })
  }

  test('Given 推理与最终文本混合响应 When 自动命名 Then 只保存语义标题', async () => {
    const adapter = new AnthropicAdapter('kimi-coding')
    const session = createSession()
    const fetchFn = (async () => new Response(JSON.stringify({ content: [
      { type: 'thinking', thinking: '用户要求根据第一条消息生成简短对话标题' },
      { type: 'text', text: '修复标题生成' },
    ] }))) as unknown as typeof fetch
    await autoGenerateSessionTitle('修复自动标题问题', {
      ...session,
      generateTitle: async () => sanitizeGeneratedTitle(await fetchTitle({ url: 'https://example.invalid', headers: {}, body: '{}' }, adapter, fetchFn)),
    })
    expect(session.getSessionMeta()?.title).toBe('修复标题生成')
    expect(session.onTitleUpdated).toHaveBeenCalledTimes(1)
  })

  test('Given 纯 URL 且没有最终标题 When 回退 Then 保留默认会话名', async () => {
    const session = createSession()
    await autoGenerateSessionTitle('https://example.com/private', {
      ...session,
      generateTitle: async () => createFallbackTitle('https://example.com/private'),
    })
    expect(session.getSessionMeta()?.title).toBe('新 Agent 会话')
    expect(session.updateSessionMeta).not.toHaveBeenCalled()
    expect(session.onTitleUpdated).not.toHaveBeenCalled()
  })
})

describe('自动命名保留手动标题与分支守卫', () => {
  for (const branch of [false, true]) {
    test(`Given ${branch ? '探索分支' : '默认会话'}生成期间用户改名 When 自动标题迟到 Then 不覆盖手动标题`, async () => {
      const session = createSession(branch ? '原主题 (fork)' : '新 Agent 会话', branch)
      const result = deferred<string | null>()
      const running = autoGenerateSessionTitle('新增消息', { ...session, generateTitle: () => result.promise })
      session.rename('用户手动标题')
      result.resolve('迟到的自动标题')
      await running
      expect(session.getSessionMeta()?.title).toBe('用户手动标题')
      expect(session.onTitleUpdated).not.toHaveBeenCalled()
      expect(session.updateSessionMeta.mock.calls.every(([updates]) => updates.title === undefined)).toBe(true)
    })
  }

  test('Given 已有普通会话标题 When 继续发送 Then 不再生成自动标题', async () => {
    const session = createSession('手动命名')
    const generateTitle = mock(async () => '不应调用')
    await autoGenerateSessionTitle('新消息', { ...session, generateTitle })
    expect(generateTitle).not.toHaveBeenCalled()
    expect(session.updateSessionMeta).not.toHaveBeenCalled()
  })

  test('Given 分支首条新增消息 When 连续触发自动命名 Then 初始化一次且安全回退', async () => {
    const session = createSession('原主题 (fork)', true)
    const result = deferred<string | null>()
    const generateTitle = mock(() => result.promise)
    const userMessage = '@file:D%3A%5Cprivate%5Cbranch.txt'
    const running = autoGenerateSessionTitle(userMessage, { ...session, generateTitle })
    expect(session.getSessionMeta()?.explorationTitleInitializedAt).toBeGreaterThan(0)
    await autoGenerateSessionTitle(userMessage, { ...session, generateTitle })
    expect(generateTitle).toHaveBeenCalledTimes(1)
    result.resolve(null)
    await running
    expect(session.getSessionMeta()?.title).toBe('branch.txt')
    expect(session.onTitleUpdated).toHaveBeenCalledTimes(1)
  })

  test('Given 请求期间会话删除或取消 When 返回标题 Then 不写回会话', async () => {
    for (const remove of [true, false]) {
      const session = createSession()
      const result = deferred<string | null>()
      const controller = new AbortController()
      const running = autoGenerateSessionTitle('检查取消', { ...session, generateTitle: () => result.promise }, controller.signal)
      if (remove) session.remove()
      else controller.abort()
      result.resolve('迟到结果')
      await running
      expect(session.updateSessionMeta).not.toHaveBeenCalled()
      expect(session.onTitleUpdated).not.toHaveBeenCalled()
    }
  })
})
