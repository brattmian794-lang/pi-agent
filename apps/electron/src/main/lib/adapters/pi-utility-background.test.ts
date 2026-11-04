import { describe, expect, it } from 'bun:test'
import { AGENT_RUNTIME_METHODS, AGENT_RUNTIME_PROTOCOL_VERSION, createAgentRuntimeRequest } from '@proma/shared'
import type { AgentRuntimeEvent, AgentRuntimeRequest } from '@proma/shared'
import type { AgentRuntimeRequestOptions } from '../agent-runtime-client'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { PiUtilityAdapter } from './pi-utility-adapter'
import { BackgroundCommandService } from '../background-command-service'

type Connection = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof PiUtilityAdapter>[1]>>>

function runtimeFixture(service: BackgroundCommandService, sessionId = 'session-a') {
  let listener: ((event: AgentRuntimeEvent) => void) | undefined
  let handler: ((request: AgentRuntimeRequest) => Promise<unknown>) | undefined
  let queryId = ''
  let stops = 0
  let resolveExit!: (value: { exitCode: number }) => void
  let processStops = 0
  const connection: Connection = {
    setRequestHandler: (callback) => { handler = callback },
    onEvent: (callback) => { listener = callback; return () => { listener = undefined } },
    stop: async () => { stops++ },
    async call<T>(method: string, _payload?: unknown, options?: AgentRuntimeRequestOptions): Promise<T> {
      if (method === AGENT_RUNTIME_METHODS.QUERY_START) {
        queryId = options?.queryId ?? ''
        const request = createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_BACKGROUND_COMMAND,
          { queryId, sessionId, action: 'start', input: { command: 'server', cwd: process.cwd() } }, { queryId, sessionId }, 'test')
        await handler!(request)
        listener?.({ protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, bootId: 'test', kind: 'event', method: AGENT_RUNTIME_METHODS.EVENT_QUERY_END, sessionId, queryId, payload: {} })
      }
      return { accepted: true } as T
    },
  }
  return { connection, get stops() { return stops }, request: (targetSessionId: string) => handler!(createAgentRuntimeRequest(AGENT_RUNTIME_METHODS.CAPABILITY_BACKGROUND_COMMAND,
    { queryId, sessionId: targetSessionId, action: 'list' }, { queryId, sessionId: targetSessionId }, 'test')) }
}

function serviceFixture() {
  const exits: Array<(value: { exitCode: number }) => void> = []
  let stopCount = 0
  const service = new BackgroundCommandService({ execute: () => {
    let end!: (value: { exitCode: number }) => void
    const exited = new Promise<{ exitCode: number }>((resolve) => { end = resolve })
    exits.push(end)
    return { ready: Promise.resolve(1234), exited, stop: async () => { stopCount++; end({ exitCode: 143 }) } }
  } })
  return { service, get stopCount() { return stopCount } }
}

describe('主进程后台命令跨回合所有权', () => {
  it('Given 回合结束 When utility 释放、用户再停止 Then 服务仍运行且能独立停止', async () => {
    const { service } = serviceFixture()
    const runtime = runtimeFixture(service)
    const adapter = new PiUtilityAdapter(service, () => runtime.connection)
    try {
      for await (const _message of adapter.query({ sessionId: 'session-a' } as PiAgentQueryOptions)) { /* 等待结束 */ }
      expect(runtime.stops).toBe(1)
      const command = service.list('session-a')[0]!
      expect(command.status).toBe('running')
      expect(await service.stop('other-session', command.id)).toMatchObject({ accepted: false })
      expect(await service.stop('session-a', command.id)).toMatchObject({ accepted: true, command: { status: 'stopped' } })
      await expect(runtime.request('session-a')).rejects.toThrow('No active Agent query')
    } finally { adapter.dispose(); await service.shutdown() }
  })

  it('Given 同一会话开启新回合 When 停止旧命令 Then 不影响新命令且ID不冲突', async () => {
    const fixture = serviceFixture()
    const runtimes = [runtimeFixture(fixture.service), runtimeFixture(fixture.service)]
    const adapter = new PiUtilityAdapter(fixture.service, () => runtimes.shift()!.connection)
    try {
      for (let i = 0; i < 2; i++) for await (const _message of adapter.query({ sessionId: 'session-a' } as PiAgentQueryOptions)) { /* 等待结束 */ }
      const commands = fixture.service.list('session-a')
      expect(commands).toHaveLength(2)
      expect(commands[0]!.id).not.toBe(commands[1]!.id)
      await fixture.service.stop('session-a', commands[1]!.id)
      expect(fixture.service.list('session-a')[0]!.status).toBe('running')
      expect(fixture.stopCount).toBe(1)
    } finally { adapter.dispose(); await fixture.service.shutdown() }
  })
})
