import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter, ProviderRequest } from './types.ts'
import { fetchTitle, fetchTitleWithDiagnostics } from './sse-reader.ts'

const request: ProviderRequest = {
  url: 'https://example.invalid/v1/chat/completions',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}

/** 只实现标题相关能力的最小适配器桩；其余协议方法在本测试中不会被调用。 */
function createAdapter(parseTitle: (data: unknown) => string | null): ProviderAdapter {
  return {
    providerType: 'test',
    parseTitleResponse: parseTitle,
  } as unknown as ProviderAdapter
}

function jsonResponse(body: string, status = 200, statusText = 'OK'): Response {
  return new Response(body, { status, statusText, headers: { 'Content-Type': 'application/json' } })
}

const adapter = createAdapter((data) => {
  const parsed = data as { title?: string }
  return parsed.title ? parsed.title : null
})

describe('标题请求失败分类', () => {
  test('Given 403 且响应体提示额度不足 When 请求标题 Then 归类为 insufficient_balance 而不是普通 HTTP 错误', async () => {
    const fetchFn = (async () =>
      jsonResponse('{"error":"Wallet balance exhausted. Recharge your account before retrying."}', 403, 'Forbidden')
    ) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.failure?.kind).toBe('insufficient_balance')
    expect(result.failure?.message).toContain('账户额度不足')
    expect(result.failure?.message).toContain('充值')
  })

  test('Given 403 但不是额度问题 When 请求标题 Then 归类为 http_error', async () => {
    const fetchFn = (async () => jsonResponse('{"error":"forbidden"}', 403, 'Forbidden')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('http_error')
  })

  test('Given 402 Payment Required 但响应体没有余额字样 When 请求标题 Then 仍归类为额度不足', async () => {
    const fetchFn = (async () => jsonResponse('{"error":"payment required"}', 402, 'Payment Required')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('insufficient_balance')
    expect(result.failure?.message).toContain('账户额度不足')
  })

  test('Given 429 且响应体提示 credit balance 不足 When 请求标题 Then 归类为额度不足而不是普通 HTTP 错误', async () => {
    const fetchFn = (async () =>
      jsonResponse('{"error":{"message":"Your credit balance is too low to access the API"}}', 429, 'Too Many Requests')
    ) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('insufficient_balance')
    expect(result.failure?.message).toContain('HTTP 429')
  })

  test('Given 500 且响应体是网关错误 When 请求标题 Then 仍归类为 http_error', async () => {
    const fetchFn = (async () => jsonResponse('{"error":"upstream connect error"}', 500, 'Internal Server Error')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('http_error')
  })

  test('Given 请求超时 When 请求标题 Then 归类为 timeout 并给出秒数', async () => {
    const fetchFn = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('timeout')
    expect(result.failure?.message).toContain('30s')
  })

  test('Given 网络中断 When 请求标题 Then 归类为 network 且不回退成超时', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.failure?.kind).toBe('network')
  })

  test('Given 响应成功但无标题 When 请求标题 Then 归类为 empty_response', async () => {
    const fetchFn = (async () => jsonResponse('{}')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.failure?.kind).toBe('empty_response')
  })

  test('Given 响应成功但响应体不是 JSON When 请求标题 Then 归类为 parse_error 而不是网络故障', async () => {
    const fetchFn = (async () => jsonResponse('<html>gateway</html>')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.failure?.kind).toBe('parse_error')
    expect(result.failure?.message).toContain('解析失败')
  })

  test('Given 适配器解析响应时抛错 When 请求标题 Then 归类为 parse_error', async () => {
    const throwingAdapter = createAdapter(() => {
      throw new Error('unexpected title shape')
    })
    const fetchFn = (async () => jsonResponse('{"choices":[]}')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, throwingAdapter, fetchFn)
    expect(result.title).toBeNull()
    expect(result.failure?.kind).toBe('parse_error')
    expect(result.failure?.message).toContain('unexpected title shape')
    // 旧签名必须继续返回 null 而不是抛错
    expect(await fetchTitle(request, throwingAdapter, fetchFn)).toBeNull()
  })

  test('Given 响应含标题 When 请求标题 Then 返回标题且 fetchTitle 保持一致', async () => {
    const fetchFn = (async () => jsonResponse('{"title":"修复更新器日志"}')) as unknown as typeof fetch
    const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
    expect(result).toEqual({ title: '修复更新器日志', failure: null })
    expect(await fetchTitle(request, adapter, fetchFn)).toBe('修复更新器日志')
  })
})
