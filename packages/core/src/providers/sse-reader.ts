/**
 * 共享 SSE 流式读取器
 *
 * 封装所有供应商通用的 SSE 解析逻辑：
 * - fetch 调用 + 错误检查
 * - ReadableStream reader + TextDecoder 管理
 * - 逐行 buffer 分割 + data: 前缀检测 + [DONE] 哨兵处理
 * - 通过 adapter.parseSSELine() 委托供应商特定解析
 * - 通过回调分发事件
 * - 累积工具调用信息（tool use 支持）
 */

import type { ProviderAdapter, ProviderRequest, StreamEventCallback, ThinkingBlock, ToolCall } from './types.ts'

// ===== 流式请求 =====

/** streamSSE 的输入选项 */
export interface StreamSSEOptions {
  /** 构建好的 HTTP 请求配置 */
  request: ProviderRequest
  /** 供应商适配器（用于解析 SSE 行） */
  adapter: ProviderAdapter
  /** 事件回调 */
  onEvent: StreamEventCallback
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal
  /** 首字节超时（毫秒），默认 30s。超时触发 AbortError，可被重试逻辑捕获并自动重试 */
  timeoutMs?: number
  /** 自定义 fetch 函数（代理等场景下由调用方注入） */
  fetchFn?: typeof globalThis.fetch
}

/** streamSSE 的返回结果 */
export interface StreamSSEResult {
  /** 累积的完整文本内容 */
  content: string
  /** 累积的推理内容（扁平文本，所有思考块拼接） */
  reasoning: string
  /**
   * 结构化的思考块（每块含 thinking 文本和可选 signature）
   *
   * 思考+工具模式下必须原样（含签名）回传给 Anthropic 协议家族服务端：
   * 签名缺失时会被 DeepSeek v4 等服务端以 "content[].thinking must be passed back" 拒绝。
   */
  thinkingBlocks: ThinkingBlock[]
  /** 本轮返回的工具调用列表 */
  toolCalls: ToolCall[]
  /** 停止原因（'tool_use' 表示需要执行工具后继续） */
  stopReason?: string
}

// ===== 首字节前自动重试 =====
//
// 仅在「尚未向 UI 发出任何事件」时重试，一旦开始流式输出就不再重试——
// 否则已渲染的内容会与重试产生的内容重复。覆盖场景：fetch 网络错误、
// 瞬时 HTTP 状态（408/429/5xx）、以及 200 之后首事件前的连接中断。

/** 首字节前最大自动重试次数 */
const MAX_SSE_RETRIES = 5

/** 累计重试等待预算（毫秒）——交互式 Chat，用户在等待，预算比 Agent 编排短 */
const MAX_SSE_RETRY_WAIT_MS = 30_000

/** 单次重试延迟上限（毫秒） */
const SSE_RETRY_MAX_DELAY_MS = 8_000

/** HTTP 错误携带状态码，便于重试决策 */
class HTTPError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HTTPError'
  }
}

/** Provider 在 200 流内返回的语义错误，通常不是瞬时网络问题，不应自动重试。 */
class ProviderStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderStreamError'
  }
}

/**
 * 计算重试延迟（指数退避 + ±20% jitter）
 *
 * 基础序列：1s, 2s, 4s, 8s, 8s...（cap = 8s），叠加 ±20% 抖动避免惊群。
 * 累计等待限制在 {@link MAX_SSE_RETRY_WAIT_MS} 内，预算耗尽返回 0（表示放弃）。
 */
function getSSERetryDelayMs(attempt: number, elapsedRetryDelayMs: number): number {
  const remainingMs = MAX_SSE_RETRY_WAIT_MS - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), SSE_RETRY_MAX_DELAY_MS)
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round(base + jitter)))
}

/**
 * 判断错误是否可重试
 *
 * - 带 HTTP 状态码：仅 408/429/5xx（瞬时）可重试，其余 4xx 为永久错误
 * - 无状态码（网络错误 / 流读取中断 / 空响应体）：视为瞬时问题，可重试
 */
function isRetriableError(error: unknown): boolean {
  if (error instanceof ProviderStreamError) return false
  if (error instanceof HTTPError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  }
  return true
}

/** 可被 AbortSignal 立即打断的 sleep；abort 时 reject AbortError */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 执行流式 SSE 请求（含首字节前自动重试）
 *
 * 通用流程：
 * 1. 发起 fetch POST 请求
 * 2. 检查响应状态
 * 3. 获取 ReadableStream reader，逐 chunk 读取
 * 4. 按换行分行，过滤 "data: " 前缀和 "[DONE]" 哨兵
 * 5. 调用 adapter.parseSSELine() 解析供应商特定 JSON
 * 6. 累积 content/reasoning/toolCalls，通过 onEvent 回调分发
 * 7. 返回完整内容
 *
 * 重试语义：仅当本次尝试尚未通过 onEvent 发出任何事件时才重试，
 * 确保不会向 UI 重复推送内容。
 */
export async function streamSSE(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { signal } = options

  let elapsedRetryDelayMs = 0

  for (let attempt = 1; ; attempt++) {
    // 跟踪本次尝试是否已发出事件——一旦发出就不能再重试
    let hasEmitted = false
    const trackedOptions: StreamSSEOptions = {
      ...options,
      onEvent: (event) => {
        hasEmitted = true
        options.onEvent(event)
      },
    }

    try {
      return await runStreamAttempt(trackedOptions)
    } catch (error) {
      // 用户主动取消：不重试
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      // 已向 UI 发出过事件：重试会导致内容重复
      if (hasEmitted) throw error
      // 永久性错误（4xx 等）或已达重试上限：直接抛出
      if (!isRetriableError(error) || attempt >= MAX_SSE_RETRIES) throw error

      const delay = getSSERetryDelayMs(attempt, elapsedRetryDelayMs)
      if (delay <= 0) throw error // 等待预算耗尽
      elapsedRetryDelayMs += delay

      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[streamSSE] 首字节前出错，${delay}ms 后第 ${attempt} 次重试: ${msg}`)
      await sleepWithAbort(delay, signal)
    }
  }
}

function normalizeToolCallOutputIndex(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value) return value
  return undefined
}

/** 单次 SSE 流式尝试（不含重试逻辑） */
async function runStreamAttempt(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { request, adapter, onEvent, signal, fetchFn = fetch, timeoutMs = 30_000 } = options

  // 真正的"首字节超时"：仅在等待 HTTP 响应期间计时，收到响应后立即清除。
  // 使用 setTimeout + clearTimeout 而非 AbortSignal.timeout() 因为后者是绝对超时，
  // 会无条件 abort 整个流（包括已开始的内容输出），导致正常长回复被截断。
  // 超时产生的 AbortError 会被外层 streamSSE 的 isRetriableError 识别为可重试，
  // 从而触发指数退避重试（最多 5 次 / 30s 预算）。
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new DOMException('First byte timeout', 'TimeoutError')), timeoutMs)
  const effectiveSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  // 1. 发起请求（支持通过 fetchFn 注入代理）
  const response = await fetchFn(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: effectiveSignal,
  })

  // 已收到 HTTP 响应头，清除首字节超时——后续流式读取不应受时间限制
  clearTimeout(timer)

  // 2. 错误检查
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new HTTPError(`${adapter.providerType} API 错误 (${response.status}): ${text.slice(0, 300)}`, response.status)
  }

  if (!response.body) {
    throw new Error('响应体为空')
  }

  // 3. 读取流
  let content = ''
  let reasoning = ''
  let stopReason: string | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 工具调用追踪
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
  const toolCallIdsByOutputIndex = new Map<string, string>()
  let currentToolCallId: string | undefined

  // 思考块追踪（Anthropic 协议：每个 thinking 块由多个 thinking_delta + signature_delta 组成）
  const thinkingBlocks: ThinkingBlock[] = []
  let currentThinking: ThinkingBlock | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || ''

      for (const line of lines) {
        // SSE 规范：冒号后的空格是可选的，兼容 "data: {...}" 和 "data:{...}" 两种格式
        let data: string
        if (line.startsWith('data: ')) {
          data = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim()
        } else {
          continue
        }
        if (data === '[DONE]' || !data) continue

        // 4. 委托给 adapter 解析供应商特定 JSON
        const events = adapter.parseSSELine(data)

        for (const event of events) {
          if (event.type === 'chunk') {
            content += event.delta
          } else if (event.type === 'reasoning') {
            reasoning += event.delta
            // 同步追加到当前思考块
            if (currentThinking) {
              currentThinking.thinking += event.delta
            } else {
              // 容错：有些 Provider 不发 content_block_start，直接发 thinking_delta
              currentThinking = { thinking: event.delta }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_signature') {
            if (currentThinking) {
              currentThinking.signature = (currentThinking.signature ?? '') + event.signature
            } else {
              // 容错：signature_delta 出现时没有活跃思考块，自建一个
              currentThinking = { thinking: '', signature: event.signature }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_block_start') {
            currentThinking = { thinking: '' }
            thinkingBlocks.push(currentThinking)
          } else if (event.type === 'reasoning_block_stop') {
            currentThinking = null
          } else if (event.type === 'tool_call_start') {
            currentToolCallId = event.toolCallId
            const outputIndex = normalizeToolCallOutputIndex(event.metadata?.outputIndex)
            if (outputIndex) toolCallIdsByOutputIndex.set(outputIndex, event.toolCallId)
            const existing = pendingToolCalls.get(event.toolCallId)
            pendingToolCalls.set(event.toolCallId, {
              id: event.toolCallId,
              name: event.toolName,
              args: existing?.args ?? '',
              metadata: { ...existing?.metadata, ...event.metadata },
            })
          } else if (event.type === 'tool_call_delta') {
            const outputIndex = normalizeToolCallOutputIndex(event.metadata?.outputIndex)
            const tcId = event.toolCallId || (outputIndex ? toolCallIdsByOutputIndex.get(outputIndex) : undefined) || currentToolCallId
            if (tcId) {
              const pending = pendingToolCalls.get(tcId)
              if (pending) {
                pending.args = event.finalArguments !== undefined
                  ? event.finalArguments
                  : pending.args + event.argumentsDelta
              }
            }
          } else if (event.type === 'done' && event.stopReason) {
            stopReason = event.stopReason
          } else if (event.type === 'error') {
            throw new ProviderStreamError(event.error)
          }
          onEvent(event)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 将 pending 工具调用解析为最终结果
  const toolCalls: ToolCall[] = []
  for (const [, pending] of pendingToolCalls) {
    try {
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: pending.args ? JSON.parse(pending.args) : {},
        metadata: pending.metadata,
      })
    } catch {
      // JSON 解析失败仍保留工具调用（空参数）
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: {},
        metadata: pending.metadata,
      })
    }
  }

  // 有工具调用但无显式 stopReason 时自动推断
  if (toolCalls.length > 0 && !stopReason) {
    stopReason = 'tool_use'
  }

  onEvent({ type: 'done', stopReason })
  return { content, reasoning, thinkingBlocks, toolCalls, stopReason }
}

// ===== 非流式标题请求 =====

/** 标题请求失败原因分类，用于区分账户额度、网络与模型侧问题。 */
export type TitleFetchFailureKind =
  | 'timeout'
  | 'insufficient_balance'
  | 'http_error'
  | 'network'
  | 'empty_response'
  | 'parse_error'

export interface TitleFetchResult {
  title: string | null
  failure: { kind: TitleFetchFailureKind; message: string } | null
}

/** 标题请求超时时长：推理模型较慢时也不能无限挂起。 */
export const TITLE_REQUEST_TIMEOUT_MS = 30_000

const INSUFFICIENT_BALANCE_PATTERN = /balance|quota|insufficient|recharge|额度|余额/i

/**
 * 执行非流式标题生成请求，并返回可诊断的失败原因。
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 * @returns 标题文本与失败分类（成功时 failure 为 null）
 */
export async function fetchTitleWithDiagnostics(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<TitleFetchResult> {
  try {
    const response = await fetchFn(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(TITLE_REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      const snippet = errorText.slice(0, 300)
      const kind: TitleFetchFailureKind =
        // 402 Payment Required 本身就是额度语义；其它状态码（部分网关会把上游 402/额度错误
        // 包成 400/429/500）则以响应体里的余额关键词为准，避免把额度不足误判成模型故障。
        response.status === 402 || INSUFFICIENT_BALANCE_PATTERN.test(errorText)
          ? 'insufficient_balance'
          : 'http_error'
      const message = kind === 'insufficient_balance'
        ? `账户额度不足（HTTP ${response.status}），请充值后重试: ${snippet}`
        : `标题请求返回 HTTP ${response.status} ${response.statusText}: ${snippet}`
      console.warn(`[fetchTitle] 请求失败: ${message}`, { provider: adapter.providerType })
      return { title: null, failure: { kind, message } }
    }

    // 响应体解析失败与网络故障分开归类：HTTP 已成功返回，问题出在模型侧响应格式或解析器。
    let data: unknown
    let title: string | null
    try {
      data = await response.json()
      title = adapter.parseTitleResponse(data)
    } catch (parseError) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError)
      const message = `标题响应解析失败: ${detail}`
      console.warn(`[fetchTitle] ${message}`, { provider: adapter.providerType })
      return { title: null, failure: { kind: 'parse_error', message } }
    }
    if (!title) {
      return {
        title: null,
        failure: { kind: 'empty_response', message: '响应成功但未解析出标题字段' },
      }
    }
    return { title, failure: null }
  } catch (error) {
    const timedOut = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const message = timedOut
      ? `标题请求超时（${TITLE_REQUEST_TIMEOUT_MS / 1000}s 内未返回）`
      : `标题请求网络异常: ${error instanceof Error ? error.message : String(error)}`
    console.warn(`[fetchTitle] ${message}`, { provider: adapter.providerType })
    return {
      title: null,
      failure: { kind: timedOut ? 'timeout' : 'network', message },
    }
  }
}

/**
 * 执行非流式标题生成请求
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 * @returns 提取的标题文本，失败返回 null
 */
export async function fetchTitle(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<string | null> {
  const result = await fetchTitleWithDiagnostics(request, adapter, fetchFn)
  return result.title
}
