import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { AgentBackgroundCommand, AgentBackgroundCommandDetails, AgentBackgroundCommandStartInput, AgentBackgroundCommandStopResult } from '@proma/shared'
import { isAgentBackgroundCommandActive } from '@proma/shared'
import type { AgentRuntimeEnv } from './agent-runtime-env'
import { executeBackgroundCommand, type BackgroundCommandExecution, type BackgroundCommandExecutionInput } from './background-command-executor'
import type { BackgroundCommandStore } from './background-command-store'

interface ManagedEntry extends AgentBackgroundCommandDetails {
  execution?: BackgroundCommandExecution
  stopPromise?: Promise<AgentBackgroundCommandStopResult>
}

export interface BackgroundCommandServiceOptions {
  store?: BackgroundCommandStore
  execute?: (input: BackgroundCommandExecutionInput) => BackgroundCommandExecution
  onChanged?: (sessionId: string, commands: AgentBackgroundCommand[]) => void
}

/** 应用级服务是后台命令的唯一所有者，Agent 回合结束不释放服务进程。 */
export class BackgroundCommandService {
  private readonly sessions = new Map<string, Map<string, ManagedEntry>>()
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private closing = false
  constructor(private readonly options: BackgroundCommandServiceOptions = {}) {}

  private entries(sessionId: string): Map<string, ManagedEntry> {
    let entries = this.sessions.get(sessionId)
    if (!entries) {
      entries = new Map((this.options.store?.read(sessionId) ?? []).map((entry) => [entry.command.id, entry]))
      this.sessions.set(sessionId, entries)
    }
    return entries
  }

  list(sessionId: string): AgentBackgroundCommand[] {
    return [...this.entries(sessionId).values()].map((entry) => ({ ...entry.command })).reverse()
  }

  details(sessionId: string, commandId: string): AgentBackgroundCommandDetails | null {
    const entry = this.entries(sessionId).get(commandId)
    return entry ? { command: { ...entry.command }, output: entry.output, truncated: entry.truncated } : null
  }

  async start(sessionId: string, input: AgentBackgroundCommandStartInput, runtimeEnv?: AgentRuntimeEnv): Promise<AgentBackgroundCommand> {
    if (this.closing) throw new Error('应用正在退出，无法启动后台命令')
    if (!sessionId || !input.command.trim() || input.command.length > 100_000 || !isAbsolute(input.cwd)) throw new Error('后台命令或工作目录无效')
    const entries = this.entries(sessionId)
    if ([...entries.values()].filter((entry) => isAgentBackgroundCommandActive(entry.command)).length >= 12) throw new Error('当前会话最多运行 12 条后台命令')
    const command: AgentBackgroundCommand = { id: randomUUID(), sessionId, command: input.command, cwd: input.cwd, startedAt: Date.now(), status: 'starting' }
    const entry: ManagedEntry = { command, output: '', truncated: false }
    entries.set(command.id, entry)
    this.publish(sessionId)
    try {
      const execution = (this.options.execute ?? executeBackgroundCommand)({ ...input, runtimeEnv, onOutput: (text) => {
        entry.output += text
        if (entry.output.length > 65_536) { entry.output = entry.output.slice(-65_536); entry.truncated = true }
        this.scheduleSave(sessionId)
      } })
      entry.execution = execution
      void execution.exited.then(({ exitCode, error }) => {
        command.exitCode = exitCode
        command.endedAt = Date.now()
        command.status = command.status === 'stopping' || command.status === 'stop_failed' ? 'stopped' : exitCode === 0 && !error ? 'exited' : 'failed'
        command.error = error ?? (command.status === 'failed' ? `命令退出（${exitCode ?? '未知'}），请查看输出。` : undefined)
        entry.execution = undefined
        this.publish(sessionId)
      })
      command.pid = await execution.ready
      if (command.status === 'starting') command.status = 'running'
      this.publish(sessionId)
    } catch (error) {
      const startError = error instanceof Error ? error.message : String(error)
      command.error = startError
      if (entry.execution) {
        try { await entry.execution.stop() } catch { command.status = 'stop_failed'; this.publish(sessionId); return { ...command } }
      }
      command.error = startError
      command.status = 'failed'
      command.endedAt = Date.now()
      this.publish(sessionId)
    }
    return { ...command }
  }

  async stop(sessionId: string, commandId: string): Promise<AgentBackgroundCommandStopResult> {
    const entry = this.entries(sessionId).get(commandId)
    if (!entry || !entry.execution || !isAgentBackgroundCommandActive(entry.command)) return { accepted: false, reason: 'not_running', command: entry ? { ...entry.command } : undefined }
    if (entry.stopPromise) return { accepted: false, reason: 'already_stopping', command: { ...entry.command } }
    entry.command.status = 'stopping'
    entry.command.error = undefined
    this.publish(sessionId)
    const execution = entry.execution
    entry.stopPromise = (async () => {
      try {
        await execution.stop()
        const result = await execution.exited
        entry.command.status = 'stopped'
        entry.command.exitCode = result.exitCode
        entry.command.endedAt = Date.now()
        entry.command.error = undefined
        entry.execution = undefined
        this.publish(sessionId)
        return { accepted: true, command: { ...entry.command } }
      } catch (error) {
        entry.command.status = 'stop_failed'
        entry.command.error = error instanceof Error ? error.message : String(error)
        this.publish(sessionId)
        return { accepted: false, reason: 'stop_failed' as const, command: { ...entry.command } }
      } finally { entry.stopPromise = undefined }
    })()
    return entry.stopPromise
  }

  async shutdown(): Promise<void> {
    this.closing = true
    await Promise.all([...this.sessions.entries()].flatMap(([sessionId, entries]) => [...entries.values()]
      .filter((entry) => entry.execution).map((entry) => entry.stopPromise ?? this.stop(sessionId, entry.command.id))))
    for (const sessionId of this.sessions.keys()) this.save(sessionId)
  }

  private publish(sessionId: string): void {
    const entries = this.entries(sessionId)
    const finished = [...entries.values()].filter((entry) => !isAgentBackgroundCommandActive(entry.command))
    for (const entry of finished.slice(0, Math.max(0, finished.length - 30))) entries.delete(entry.command.id)
    this.options.onChanged?.(sessionId, this.list(sessionId))
    this.save(sessionId)
  }

  private scheduleSave(sessionId: string): void {
    if (this.saveTimers.has(sessionId)) return
    const timer = setTimeout(() => { this.saveTimers.delete(sessionId); this.save(sessionId) }, 1_000)
    timer.unref()
    this.saveTimers.set(sessionId, timer)
  }

  private save(sessionId: string): void {
    const timer = this.saveTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(sessionId)
    try {
      this.options.store?.write(sessionId, [...this.entries(sessionId).values()].map(({ command, output, truncated }) => ({ command: { ...command }, output, truncated })))
    } catch (error) { console.error('[后台命令] 保存状态失败', error) }
  }
}
