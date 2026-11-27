import { randomUUID } from 'node:crypto'
import type { AgentRuntimeEvent, AgentRuntimeRequest, AgentRuntimeError, SDKMessage, SDKUserMessageInput, SendQueuedMessageOptions } from '@proma/shared'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import type { PermissionResult, CanUseToolOptions } from '../agent-permission-service'
import type { AgentRuntimeClient } from '../agent-runtime-client'
import type { BackgroundCommandService } from '../background-command-service'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

type RuntimeConnection = Pick<AgentRuntimeClient, 'call' | 'stop' | 'setRequestHandler' | 'onEvent' | 'currentState'>
interface PendingQuery {
  queryId: string
  sessionId: string
  input: PiAgentQueryOptions
  client: RuntimeConnection
  queue: AsyncEventQueue<SDKMessage>
  accepted: boolean
  ended: boolean
  runtimeFailed: boolean
}
interface CapabilityRequest { controller: AbortController; queryId: string }
interface QueryAbortResponse { accepted: boolean; completed?: boolean }
/** 取消请求的可核验结局：确认取消、状态未知、运行时已停止、明确失败。 */
type AbortOutcome = 'cancelled' | 'unknown' | 'stopped' | 'failed'
const RUNTIME_STOPPED_ERROR_PATTERN =
  /Agent runtime (?:stopped|was stopped|is not connected|port is not connected|startup cancelled|exited|fatal error)/i

function classifyAbortOutcome(error: unknown): AbortOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (RUNTIME_STOPPED_ERROR_PATTERN.test(message)) return 'stopped'
  if (/timed out|timeout/i.test(message)) return 'unknown'
  return 'failed'
}
interface AsyncEventQueue<T> {
  push(value: T): void
  end(): void
  fail(error: unknown): void
  next(): Promise<IteratorResult<T>>
}

/** utility 只负责一轮 Agent 查询，后台进程控制委托给主进程服务。 */
export class PiUtilityAdapter {
  private readonly pendingQueries = new Map<string, PendingQuery>()
  private readonly capabilityAbortControllers = new Map<string, CapabilityRequest>()
  private readonly reportedAbortOutcomes = new Set<string>()

  constructor(
    private readonly backgroundCommands?: BackgroundCommandService,
    private readonly createRuntime: (sessionId: string) => RuntimeConnection | Promise<RuntimeConnection> = async (sessionId) => {
      const { AgentRuntimeClient } = await import('../agent-runtime-client')
      return new AgentRuntimeClient({ sessionId })
    },
  ) {}

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const queryId = randomUUID()
    const client = await this.createRuntime(input.sessionId)
    const pending: PendingQuery = {
      queryId, sessionId: input.sessionId, input, client, queue: createAsyncEventQueue<SDKMessage>(),
      accepted: false, ended: false, runtimeFailed: false,
    }
    this.pendingQueries.set(queryId, pending)
    client.setRequestHandler((request) => this.handleRuntimeRequest(request))
    const unsubscribe = client.onEvent((event) => this.handleRuntimeEvent({ ...event, queryId: event.queryId ?? queryId }))
    try {
      await client.call(AGENT_RUNTIME_METHODS.QUERY_START, { queryId, input: serializeQueryInput(input) }, { queryId })
      pending.accepted = true
      while (true) {
        const result = await pending.queue.next()
        if (result.done) return
        yield result.value
      }
    } catch (error) {
      pending.queue.fail(error)
      throw error
    } finally {
      pending.ended = true
      unsubscribe()
      this.pendingQueries.delete(queryId)
      this.abortCapabilitiesForQuery(queryId)
      if (pending.accepted && !pending.runtimeFailed && client.currentState.status === 'ready') {
        await client.call(AGENT_RUNTIME_METHODS.QUERY_ABORT,
          { queryId, sessionId: input.sessionId }, { queryId, timeoutMs: 5_000 }).catch((error: unknown) => {
          // 收尾阶段的取消失败只影响运行时回收，不应升级成用户可见错误。
          console.log(`[PiUtilityAdapter] 收尾取消未确认（运行时可能已结束）: sessionId=${input.sessionId}, queryId=${queryId}`,
            error instanceof Error ? error.message : error)
        })
      }
      await client.stop()
    }
  }

  async abort(sessionId: string): Promise<void> {
    const aborts: Promise<void>[] = []
    for (const pending of this.pendingQueries.values()) {
      if (pending.sessionId !== sessionId) continue
      this.abortCapabilitiesForQuery(pending.queryId)
      // 运行时已经停止/崩溃时，取消请求没有意义，也不能再自动拉起新运行时去发它。
      if (pending.client.currentState.status !== 'ready') {
        this.reportAbortOutcome(pending, 'stopped')
        await this.failStoppedQuery(pending, new Error('Agent 运行时已停止，本次取消无需执行'))
        continue
      }
      aborts.push(pending.client.call<QueryAbortResponse>(AGENT_RUNTIME_METHODS.QUERY_ABORT,
        { queryId: pending.queryId, sessionId }, { queryId: pending.queryId, timeoutMs: 5_000 }).then(async (result) => {
        if (result.completed === false) {
          // 运行时明确回执「未能在时限内完成取消」：本地只能关闭运行时来恢复确定性状态。
          this.reportAbortOutcome(pending, 'unknown')
          await this.failStoppedQuery(pending, new Error('停止 Agent 结果未知（运行时未在时限内确认取消），已关闭运行时'))
          return
        }
        this.reportAbortOutcome(pending, 'cancelled')
        await pending.client.stop()
      }).catch(async (error) => {
        const outcome = classifyAbortOutcome(error)
        this.reportAbortOutcome(pending, outcome, error)
        // 超时/无法确认时统一表述为「结果未知」，避免把未确认的取消当成已取消或普通失败。
        if (outcome === 'stopped') {
          await this.failStoppedQuery(pending, new Error('Agent 运行时已停止，本次取消无需执行'))
          return
        }
        if (outcome === 'unknown') {
          await this.failStoppedQuery(pending, new Error('停止 Agent 结果未知（未在时限内收到运行时确认取消），已关闭运行时'))
          return
        }
        await this.failStoppedQuery(pending, error)
      }))
    }
    await Promise.all(aborts)
  }

  /** 同一 queryId 的同类结局只记录一次，避免重复取消刷屏。 */
  private reportAbortOutcome(pending: PendingQuery, outcome: AbortOutcome, error?: unknown): void {
    const key = `${pending.sessionId}:${pending.queryId}:${outcome}`
    if (this.reportedAbortOutcomes.has(key)) return
    if (this.reportedAbortOutcomes.size >= 200) this.reportedAbortOutcomes.clear()
    this.reportedAbortOutcomes.add(key)
    const context = `sessionId=${pending.sessionId}, queryId=${pending.queryId}`
    if (outcome === 'cancelled') {
      console.log(`[PiUtilityAdapter] 已确认取消运行: ${context}`)
      return
    }
    if (outcome === 'stopped') {
      console.log(`[PiUtilityAdapter] 运行时已停止，取消请求按终态处理: ${context}`)
      return
    }
    if (outcome === 'unknown') {
      console.warn(`[PiUtilityAdapter] 取消结果未知（未在 5s 内收到运行时确认），已关闭运行时以恢复确定性状态: ${context}`)
      return
    }
    console.warn(`[PiUtilityAdapter] 取消失败: ${context}`, error)
  }

  private async failStoppedQuery(pending: PendingQuery, error: unknown): Promise<void> {
    if (!pending.ended && !pending.runtimeFailed) {
      pending.runtimeFailed = true
      this.abortCapabilitiesForQuery(pending.queryId)
      pending.queue.fail(error)
    }
    await pending.client.stop()
  }

  private abortCapabilitiesForQuery(queryId: string): void {
    for (const [requestId, capability] of this.capabilityAbortControllers) {
      if (capability.queryId !== queryId) continue
      capability.controller.abort()
      this.capabilityAbortControllers.delete(requestId)
    }
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) throw new Error('当前会话没有正在运行的 Agent')
    const { onAccepted: _onAccepted, ...serializableOptions } = options ?? {}
    await pending.client.call(AGENT_RUNTIME_METHODS.QUERY_SEND_QUEUED_MESSAGE,
      { sessionId, message, options: serializableOptions }, { queryId: pending.queryId })
    options?.onAccepted?.()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) return
    await pending.client.call(AGENT_RUNTIME_METHODS.QUERY_SET_PERMISSION_MODE, { sessionId, mode }, { queryId: pending.queryId })
  }

  dispose(): void {
    for (const pending of this.pendingQueries.values()) {
      pending.runtimeFailed = true
      pending.queue.fail(new Error('Agent utility stopped'))
      void pending.client.stop()
    }
    this.pendingQueries.clear()
    for (const { controller } of this.capabilityAbortControllers.values()) controller.abort()
    this.capabilityAbortControllers.clear()
  }

  async handleRuntimeRequest(request: AgentRuntimeRequest): Promise<unknown> {
    const payload = asRecord(request.payload)
    const queryId = typeof payload.queryId === 'string' ? payload.queryId : undefined
    const pending = queryId ? this.pendingQueries.get(queryId) : undefined
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL) {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      this.capabilityAbortControllers.get(requestId)?.controller.abort()
      return { accepted: true }
    }
    if (!pending) throw new Error(`No active Agent query: ${queryId ?? 'unknown'}`)
    if (request.sessionId && request.sessionId !== pending.sessionId) throw new Error('运行时会话不匹配')
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_BACKGROUND_COMMAND) {
      if (!this.backgroundCommands) throw new Error('后台命令服务未启用')
      // 会话、Shell 与环境来自已授权查询，拒绝由 utility 覆盖所属会话或执行器。
      if (payload.sessionId !== pending.sessionId) throw new Error('后台命令会话不匹配')
      const data = asRecord(payload.input)
      if (payload.action === 'start') {
        if (typeof data.command !== 'string' || typeof data.cwd !== 'string') throw new Error('后台命令参数无效')
        return this.backgroundCommands.start(pending.sessionId, { command: data.command, cwd: data.cwd }, pending.input.runtimeEnv)
      }
      if (payload.action === 'list') return this.backgroundCommands.list(pending.sessionId)
      if (payload.action === 'output' && typeof data.commandId === 'string') return this.backgroundCommands.details(pending.sessionId, data.commandId)
      throw new Error('不支持的后台命令操作')
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL) {
      if (!pending.input.canUseTool) throw new Error(`No canUseTool handler: ${pending.sessionId}`)
      const controller = new AbortController()
      this.capabilityAbortControllers.set(request.requestId, { controller, queryId: pending.queryId })
      try {
        return await pending.input.canUseTool(String(payload.toolName ?? ''), asRecord(payload.input),
          { ...asRecord(payload.options), signal: controller.signal } as CanUseToolOptions) as PermissionResult
      } finally { this.capabilityAbortControllers.delete(request.requestId) }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL) {
      const toolName = String(payload.toolName ?? '')
      const tool = pending.input.customTools?.find((candidate) => candidate.name === toolName)
      if (!tool) throw new Error(`No custom tool handler: ${toolName}`)
      const controller = new AbortController()
      this.capabilityAbortControllers.set(request.requestId, { controller, queryId: pending.queryId })
      try {
        const execute = tool.execute as unknown as (toolCallId: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
        return await execute(String(payload.toolCallId ?? ''), asRecord(payload.input), controller.signal)
      } finally { this.capabilityAbortControllers.delete(request.requestId) }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CODEX_OAUTH_REFRESHED) {
      await pending.input.onCodexOAuthCredentialsRefreshed?.(payload.credentials as never)
      return { accepted: true }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_GITHUB_COPILOT_OAUTH_REFRESHED) {
      await pending.input.onGithubCopilotOAuthCredentialsRefreshed?.(payload.credentials as never)
      return { accepted: true }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_XAI_OAUTH_REFRESHED) {
      await pending.input.onXaiOAuthCredentialsRefreshed?.(payload.credentials as never)
      return { accepted: true }
    }
    throw new Error(`Unsupported Agent runtime request: ${request.method}`)
  }

  private findPending(sessionId: string): PendingQuery | undefined {
    return [...this.pendingQueries.values()].find((item) => item.sessionId === sessionId)
  }

  private handleRuntimeEvent(event: AgentRuntimeEvent): void {
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_CRASHED) {
      const error = toRuntimeError(event.payload)
      for (const pending of this.pendingQueries.values()) {
        if (pending.queryId !== event.queryId) continue
        pending.runtimeFailed = true
        pending.queue.fail(error)
        this.abortCapabilitiesForQuery(pending.queryId)
      }
      return
    }
    const payload = asRecord(event.payload)
    const queryId = event.queryId ?? (typeof payload.queryId === 'string' ? payload.queryId : undefined)
    const pending = queryId ? this.pendingQueries.get(queryId) : undefined
    if (!pending) return
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY) {
      if (payload.message && typeof payload.message === 'object') pending.queue.push(payload.message as SDKMessage)
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_END) { pending.queue.end(); return }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_ERROR) { pending.queue.fail(toRuntimeError(payload.error)); return }
    if (event.method !== AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK) return
    const data = asRecord(payload.payload)
    switch (payload.callback) {
      case 'session_id': pending.input.onSessionId?.(String(data.sdkSessionId ?? ''), data.sessionFile as string | undefined); break
      case 'pi_entry_bindings': pending.input.onPiEntryBindings?.((data.bindings ?? {}) as Record<string, string>); break
      case 'model_resolved': pending.input.onModelResolved?.(String(data.model ?? '')); break
      case 'context_window': pending.input.onContextWindow?.(Number(data.contextWindow ?? 0)); break
      case 'retry': pending.input.onRetry?.(data.update as never); break
      case 'skill_activated': pending.input.onSkillActivated?.((data.activations ?? []) as never, String(data.userMessageUuid ?? '')); break
    }
  }
}

function serializeQueryInput(input: PiAgentQueryOptions): Record<string, unknown> {
  const {
    abortSignal: _abortSignal, canUseTool: _canUseTool, customTools, backgroundCommands: _backgroundCommands,
    onSessionId: _onSessionId, onPiEntryBindings: _onPiEntryBindings, onModelResolved: _onModelResolved,
    onContextWindow: _onContextWindow, onRetry: _onRetry, onSkillActivated: _onSkillActivated,
    onCodexOAuthCredentialsRefreshed: _onCodexOAuthCredentialsRefreshed,
    onGithubCopilotOAuthCredentialsRefreshed: _onGithubCopilotOAuthCredentialsRefreshed,
    onXaiOAuthCredentialsRefreshed: _onXaiOAuthCredentialsRefreshed, ...serializable
  } = input
  const serializedCustomTools = (customTools ?? []).map((tool) => {
    const { execute: _execute, ...descriptor } = tool as unknown as Record<string, unknown>
    return descriptor
  })
  return { ...serializable, ...(serializedCustomTools.length > 0 ? { customTools: serializedCustomTools } : {}) }
}

function createAsyncEventQueue<T>(): AsyncEventQueue<T> {
  const values: T[] = []
  const waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (reason: unknown) => void }> = []
  let ended = false
  let failure: unknown
  return {
    push(value) { if (ended || failure !== undefined) return; const waiter = waiters.shift(); if (waiter) waiter.resolve({ done: false, value }); else values.push(value) },
    end() { if (ended || failure !== undefined) return; ended = true; while (waiters.length) waiters.shift()!.resolve({ done: true, value: undefined }) },
    fail(error) { if (ended || failure !== undefined) return; failure = error; while (waiters.length) waiters.shift()!.reject(error) },
    async next() {
      if (values.length) return { done: false, value: values.shift()! }
      if (failure !== undefined) throw failure
      if (ended) return { done: true, value: undefined }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }
function toRuntimeError(value: unknown): Error {
  if (value && typeof value === 'object' && typeof (value as AgentRuntimeError).message === 'string') return Object.assign(new Error((value as AgentRuntimeError).message), value)
  return new Error(typeof value === 'string' ? value : 'Agent utility query failed')
}
