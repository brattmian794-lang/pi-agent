import { describe, expect, it, spyOn } from 'bun:test'
import type { WebContents } from 'electron'
import type { AgentDeferredQueueMessageInput, AgentQueuedMessageStatus } from '@proma/shared'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentQueueCoordinatorOptions } from './agent-queue-coordinator'

type RunInput = Parameters<AgentQueueCoordinatorOptions['startRun']>[0]

interface ConsoleSpy {
  mock: { calls: unknown[][] }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 允许 Promise 链与微任务跑完，便于断言异步投递结果。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

function spyText(spy: ConsoleSpy): string {
  return spy.mock.calls
    .map((call) => call.map((value) => (value instanceof Error ? value.message : String(value))).join(' '))
    .join('\n')
}

function fakeWebContents(destroyed = false): WebContents {
  return { isDestroyed: () => destroyed } as unknown as WebContents
}

function queuedMessage(overrides: Partial<AgentDeferredQueueMessageInput> = {}): AgentDeferredQueueMessageInput {
  return {
    sessionId: 'session-a',
    userMessage: '延迟消息',
    channelId: 'channel-a',
    queueMessageId: 'msg-1',
    ...overrides,
  }
}

interface CoordinatorFixture {
  coordinator: AgentQueueCoordinator
  runs: string[]
  statuses: AgentQueuedMessageStatus[]
  gate: Deferred<void> | undefined
  setGate: (gate: Deferred<void> | undefined) => void
  setActive: (active: boolean) => void
  setWebContents: (webContents: WebContents | null) => void
}

function coordinatorFixture(startRun: (input: RunInput) => Promise<void> = async () => {}): CoordinatorFixture {
  let active = false
  let webContents: WebContents | null = fakeWebContents()
  const runs: string[] = []
  const statuses: AgentQueuedMessageStatus[] = []
  const fixture: CoordinatorFixture = {
    coordinator: new AgentQueueCoordinator({
      isActive: () => active,
      getWebContents: () => webContents,
      startRun: (input) => {
        runs.push(input.queueMessageId)
        return startRun(input)
      },
      sendStarted: (_target, status) => { statuses.push(status) },
      reserveRunGeneration: () => 7,
    }),
    runs,
    statuses,
    gate: undefined,
    setGate: (gate) => { fixture.gate = gate },
    setActive: (next) => { active = next },
    setWebContents: (next) => { webContents = next },
  }
  return fixture
}

describe('Agent deferred queue 投递保障', () => {
  it('Given 首次投递失败 When 收到下一次生命周期事件 Then 延迟消息不丢失并成功再次投递', async () => {
    const gate = deferred<void>()
    let startAttempts = 0
    const fixture = coordinatorFixture(async () => {
      startAttempts += 1
      if (startAttempts === 1) throw new Error('会话通道已关闭')
      await gate.promise
    })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(fixture.coordinator.enqueue(queuedMessage())).toBe('started')
      await flush()

      // 失败后消息回到队列头部，等待生命周期事件而不是紧凑重试。
      expect(fixture.coordinator.isDispatching('session-a')).toBe(false)
      expect(fixture.coordinator.snapshot('session-a').map((entry) => entry.input.queueMessageId)).toEqual(['msg-1'])
      await flush()
      expect(fixture.runs).toEqual(['msg-1'])
      expect(spyText(warnSpy)).toContain('延迟消息投递失败，已放回队列等待重新调度')
      expect(spyText(warnSpy)).toContain('msg-1')

      fixture.coordinator.onRunComplete('session-a', undefined, false, false)
      await flush()
      expect(fixture.runs).toEqual(['msg-1', 'msg-1'])

      gate.resolve()
      await flush()
      expect(fixture.coordinator.hasPending('session-a')).toBe(false)
      expect(spyText(logSpy)).toContain('延迟消息已投递')
      expect(fixture.statuses.map((status) => status.messageId)).toEqual(['msg-1', 'msg-1'])
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('Given 投递仍在进行 When 连续收到唤醒事件 Then 同一消息只启动一次', async () => {
    const gate = deferred<void>()
    const fixture = coordinatorFixture(() => gate.promise)

    expect(fixture.coordinator.enqueue(queuedMessage())).toBe('started')
    fixture.coordinator.onTargetAvailable('session-a')
    fixture.coordinator.onBackgroundTaskComplete('session-a')
    fixture.coordinator.onRunComplete('session-a', undefined, false, false)
    await flush()

    expect(fixture.runs).toEqual(['msg-1'])
    gate.resolve()
    await flush()
    expect(fixture.runs).toEqual(['msg-1'])
    expect(fixture.coordinator.hasPending('session-a')).toBe(false)
  })

  it('Given 同一条消息被重复提交 When 队列已持有该消息 Then 不产生重复条目', async () => {
    const gate = deferred<void>()
    const fixture = coordinatorFixture(() => gate.promise)

    expect(fixture.coordinator.enqueue(queuedMessage())).toBe('started')
    expect(fixture.coordinator.enqueue(queuedMessage())).toBe('started')
    expect(fixture.coordinator.enqueue(queuedMessage({ queueMessageId: 'msg-2' }))).toBe('queued')
    await flush()

    expect(fixture.runs).toEqual(['msg-1'])
    gate.resolve()
    await flush()
    // 第一条完成后继续调度第二条，两条都只会启动一次。
    expect(fixture.runs).toEqual(['msg-1', 'msg-2'])
    expect(fixture.coordinator.hasPending('session-a')).toBe(false)
  })

  it('Given 活跃通道已结束 When 两条消息都投递失败 Then 按原顺序保留且不重复', async () => {
    const fixture = coordinatorFixture(async () => { throw new Error('会话通道已关闭') })
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fixture.coordinator.enqueue(queuedMessage({ queueMessageId: 'msg-1' }))
      fixture.coordinator.enqueue(queuedMessage({ queueMessageId: 'msg-2' }))
      await flush()
      await flush()

      // 第一条失败后回到队列头部，第二条仍在队尾等待下一次生命周期事件。
      expect(fixture.coordinator.snapshot('session-a').map((entry) => entry.input.queueMessageId)).toEqual(['msg-1', 'msg-2'])
      expect(fixture.runs).toEqual(['msg-1'])
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Given renderer 通道暂不可用 When 队列有消息 Then 保留消息并在通道恢复后投递', async () => {
    const fixture = coordinatorFixture()
    fixture.setWebContents(fakeWebContents(true))

    expect(fixture.coordinator.enqueue(queuedMessage())).toBe('queued')
    expect(fixture.runs).toEqual([])
    expect(fixture.coordinator.snapshot('session-a').map((entry) => entry.input.queueMessageId)).toEqual(['msg-1'])

    fixture.setWebContents(fakeWebContents())
    fixture.coordinator.onTargetAvailable('session-a')
    await flush()

    expect(fixture.runs).toEqual(['msg-1'])
    expect(fixture.coordinator.hasPending('session-a')).toBe(false)
  })
})
