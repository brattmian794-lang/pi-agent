import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundCommandService } from './background-command-service'
import { BackgroundCommandStore } from './background-command-store'
import type { BackgroundCommandExecution, BackgroundCommandExecutionInput } from './background-command-executor'

function fixture() {
  let resolveExit!: (value: { exitCode: number | null }) => void
  let resolveReady!: (value: number) => void
  let rejectReady!: (error: Error) => void
  let attempts = 0
  let failure = false
  let output: ((text: string) => void) | undefined
  const execution: BackgroundCommandExecution = {
    ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }),
    exited: new Promise((resolve) => { resolveExit = resolve }),
    stop: async () => { attempts++; if (failure) throw new Error('控制通道失败'); resolveExit({ exitCode: 143 }) },
  }
  return {
    execute: (input: BackgroundCommandExecutionInput) => { output = input.onOutput; return execution },
    ready: () => resolveReady(12345), failStart: () => rejectReady(new Error('启动失败')),
    exit: resolveExit, write: (text: string) => output?.(text), failStop: (value: boolean) => { failure = value },
    get attempts() { return attempts },
  }
}
const request = { command: 'python -m http.server', cwd: process.cwd() }

describe('独立后台命令服务', () => {
  it('Given 启动中命令 When 启动确认、确认停止 Then 发布完整状态并保留已停止终态', async () => {
    const child = fixture()
    const states: string[] = []
    const service = new BackgroundCommandService({ execute: child.execute, onChanged: (_session, commands) => states.push(commands[0]!.status) })
    const starting = service.start('a', request)
    expect(service.list('a')[0]!.status).toBe('starting')
    child.ready()
    const command = await starting
    expect(command.status).toBe('running')
    child.write('ready\n')
    const result = await service.stop('a', command.id)
    expect(result).toMatchObject({ accepted: true, command: { id: command.id, status: 'stopped' } })
    expect(service.list('a')[0]!.status).toBe('stopped')
    expect(service.details('a', command.id)?.output).toBe('ready\n')
    expect(states).toContain('stopping')
    expect(child.attempts).toBe(1)
    expect((await service.stop('a', command.id)).reason).toBe('not_running')
    await service.shutdown()
  })

  it('Given 用户未确认或其他会话访问 When 查询和停止 Then 不发送停止信号、不泄露输出', async () => {
    const child = fixture()
    const service = new BackgroundCommandService({ execute: child.execute })
    child.ready()
    const command = await service.start('a', request)
    expect(child.attempts).toBe(0)
    expect(service.list('b')).toEqual([])
    expect(service.details('b', command.id)).toBeNull()
    expect(await service.stop('b', command.id)).toMatchObject({ accepted: false, reason: 'not_running' })
    expect(child.attempts).toBe(0)
    await service.shutdown()
  })

  it('Given 停止失败 When 重试 Then 保留错误与控制权，成功后转为已停止', async () => {
    const child = fixture()
    const service = new BackgroundCommandService({ execute: child.execute })
    child.ready()
    const command = await service.start('a', request)
    child.failStop(true)
    expect(await service.stop('a', command.id)).toMatchObject({ accepted: false, reason: 'stop_failed', command: { status: 'stop_failed', error: '控制通道失败' } })
    child.failStop(false)
    expect(await service.stop('a', command.id)).toMatchObject({ accepted: true, command: { status: 'stopped' } })
    expect(child.attempts).toBe(2)
    await service.shutdown()
  })

  it('Given 两个停止请求竞争 When 第一次尚未结束 Then 第二次不会重复发送控制信号', async () => {
    const child = fixture()
    let finishStop!: () => void
    let calls = 0
    const service = new BackgroundCommandService({ execute: (input) => {
      const execution = child.execute(input)
      return { ...execution, stop: async () => { calls++; await new Promise<void>((resolve) => { finishStop = resolve }); child.exit({ exitCode: 143 }) } }
    } })
    child.ready()
    const command = await service.start('a', request)
    const first = service.stop('a', command.id)
    expect(await service.stop('a', command.id)).toMatchObject({ accepted: false, reason: 'already_stopping' })
    finishStop()
    expect((await first).command?.status).toBe('stopped')
    expect(calls).toBe(1)
    await service.shutdown()
  })

  it('Given 自然退出与启动失败 When 服务接收退出 Then 保留退出码、输出和准确终态', async () => {
    const child = fixture()
    const service = new BackgroundCommandService({ execute: child.execute })
    child.ready()
    const command = await service.start('a', request)
    child.exit({ exitCode: 7 })
    await Promise.resolve()
    expect(service.details('a', command.id)?.command).toMatchObject({ status: 'failed', exitCode: 7 })
    await service.shutdown()
    const broken = fixture()
    const failed = new BackgroundCommandService({ execute: broken.execute })
    const starting = failed.start('a', request)
    broken.failStart()
    expect(await starting).toMatchObject({ status: 'failed', error: '启动失败' })
    await failed.shutdown()
  })

  it('Given 输出持续增长且应用重启 When 读取历史 Then 截断输出且旧活动记录变为已中断，不能停止旧PID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proma-background-store-'))
    try {
      const store = new BackgroundCommandStore(directory)
      const child = fixture()
      const service = new BackgroundCommandService({ store, execute: child.execute })
      child.ready()
      const command = await service.start('a', request)
      child.write('x'.repeat(100_000))
      const failedStop = service.stop('b', command.id)
      await failedStop
      // 显式写入运行快照，模拟进程意外结束前最后一次持久化。
      const details = service.details('a', command.id)!
      store.write('a', [details])
      expect(details.output).toHaveLength(65_536)
      expect(details.truncated).toBe(true)
      const restored = new BackgroundCommandService({ store })
      expect(restored.list('a')[0]!.status).toBe('interrupted')
      expect((await restored.stop('a', command.id)).reason).toBe('not_running')
      expect(child.attempts).toBe(0)
      await service.shutdown()
      await restored.shutdown()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

it('Given 用户停止仍在进行 When 应用退出 Then 等待原停止请求完成且不重复发信号', async () => {
  const child = fixture()
  let finishStop!: () => void
  let calls = 0
  const service = new BackgroundCommandService({ execute: (input) => ({
    ...child.execute(input),
    stop: async () => {
      calls++
      await new Promise<void>((resolve) => { finishStop = resolve })
      child.exit({ exitCode: 143 })
    },
  }) })
  child.ready()
  const command = await service.start('a', request)
  const stopping = service.stop('a', command.id)
  let closed = false
  const shutdown = service.shutdown().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(calls).toBe(1)
  finishStop()
  await stopping
  await shutdown
  expect(closed).toBe(true)
  expect(service.list('a')[0]!.status).toBe('stopped')
})
