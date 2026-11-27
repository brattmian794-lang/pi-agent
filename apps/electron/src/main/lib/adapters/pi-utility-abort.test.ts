import { describe, expect, it, spyOn } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import type { AgentRuntimeState } from '@proma/shared'
import type { AgentRuntimeRequestOptions } from '../agent-runtime-client'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { PiUtilityAdapter } from './pi-utility-adapter'

type Connection = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof PiUtilityAdapter>[1]>>>

interface AbortBehavior {
  /** QUERY_ABORT 的返回；Error 表示调用直接失败（例如客户端超时）。 */
  response?: { accepted: boolean; completed?: boolean } | Error
}

interface ConsoleSpy {
  mock: { calls: unknown[][] }
}

function spyText(spy: ConsoleSpy): string {
  return spy.mock.calls
    .map((call) => call.map((value) => (value instanceof Error ? value.message : String(value))).join(' '))
    .join('\n')
}

function abortFixture(behavior: AbortBehavior = {}) {
  const state: AgentRuntimeState = {
    status: 'ready',
    bootId: 'boot-abort-test',
    pid: null,
    active: true,
    pendingRequests: 0,
  }
  const calls: string[] = []
  let stopCount = 0
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })

  const connection: Connection = {
    currentState: state,
    setRequestHandler: () => {},
    onEvent: () => () => {},
    stop: async () => {
      stopCount += 1
      state.status = 'stopped'
    },
    async call<T>(method: string, _payload?: unknown, _options?: AgentRuntimeRequestOptions): Promise<T> {
      calls.push(method)
      if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
        resolveStarted()
        return { accepted: true } as T
      }
      if (method === AGENT_RUNTIME_METHODS.QUERY_ABORT) {
        const response = behavior.response ?? { accepted: true, completed: true }
        if (response instanceof Error) throw response
        return response as T
      }
      return { accepted: true } as T
    },
  }

  return {
    connection,
    state,
    started,
    calls,
    get stopCount() { return stopCount },
  }
}

/** 消费 query 生成器；返回它抛出的错误，便于断言终态。 */
async function drainQuery(adapter: PiUtilityAdapter, sessionId: string): Promise<unknown> {
  try {
    for await (const _message of adapter.query({ sessionId } as PiAgentQueryOptions)) { /* 消费全部消息 */ }
    return undefined
  } catch (error) {
    return error
  }
}

describe('Pi Utility 取消语义', () => {
  it('Given 运行时已停止 When 取消 Query Then 不再发送 abort 请求并按终态说明原因', async () => {
    const fixture = abortFixture()
    const adapter = new PiUtilityAdapter(undefined, () => fixture.connection)
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const queryResult = drainQuery(adapter, 'session-stopped')
      await fixture.started
      fixture.state.status = 'stopped'

      await adapter.abort('session-stopped')
      const error = await queryResult

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Agent 运行时已停止')
      expect(fixture.calls).not.toContain(AGENT_RUNTIME_METHODS.QUERY_ABORT)
      expect(spyText(logSpy)).toContain('运行时已停止，取消请求按终态处理')
      expect(spyText(warnSpy)).not.toContain('取消失败')
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('Given 运行时回执未完成取消 When 取消 Query Then 记录结果未知并关闭运行时', async () => {
    const fixture = abortFixture({ response: { accepted: true, completed: false } })
    const adapter = new PiUtilityAdapter(undefined, () => fixture.connection)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const queryResult = drainQuery(adapter, 'session-unknown')
      await fixture.started

      await adapter.abort('session-unknown')
      const error = await queryResult

      expect((error as Error).message).toContain('结果未知')
      expect(spyText(warnSpy)).toContain('取消结果未知')
      expect(spyText(warnSpy)).not.toContain('取消失败')
      expect(fixture.stopCount).toBeGreaterThanOrEqual(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Given 取消请求超时 When 取消 Query Then 报告结果未知而不是取消失败', async () => {
    const fixture = abortFixture({ response: new Error('Agent runtime request timed out: agent.query.abort') })
    const adapter = new PiUtilityAdapter(undefined, () => fixture.connection)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const queryResult = drainQuery(adapter, 'session-timeout')
      await fixture.started

      await adapter.abort('session-timeout')
      const error = await queryResult

      expect((error as Error).message).toContain('结果未知')
      expect(spyText(warnSpy)).toContain('取消结果未知')
      expect(spyText(warnSpy)).not.toContain('取消失败')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Given 取消已确认 When 重复取消 Then 返回一致终态且不产生失败日志', async () => {
    const fixture = abortFixture()
    const adapter = new PiUtilityAdapter(undefined, () => fixture.connection)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const queryResult = drainQuery(adapter, 'session-repeat')
      await fixture.started

      await adapter.abort('session-repeat')
      await adapter.abort('session-repeat')
      await queryResult

      expect(fixture.calls.filter((method) => method === AGENT_RUNTIME_METHODS.QUERY_ABORT)).toHaveLength(1)
      expect(spyText(warnSpy)).not.toContain('取消失败')
      expect(spyText(logSpy).match(/已确认取消运行/g)).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('Given 运行时返回非停止类错误 When 取消 Query Then 仍记录取消失败以便排查', async () => {
    const fixture = abortFixture({ response: new Error('Agent runtime request aborted: agent.query.abort') })
    const adapter = new PiUtilityAdapter(undefined, () => fixture.connection)
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const queryResult = drainQuery(adapter, 'session-failed')
      await fixture.started

      await adapter.abort('session-failed')
      await queryResult

      expect(spyText(warnSpy)).toContain('取消失败')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
