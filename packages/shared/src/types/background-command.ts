/** 由主进程持有的 Pi Shell 后台命令；与 Agent 回合生命周期独立。 */
export type AgentBackgroundCommandStatus =
  | 'starting' | 'running' | 'stopping' | 'stop_failed'
  | 'stopped' | 'exited' | 'failed' | 'interrupted'

export interface AgentBackgroundCommand {
  id: string
  sessionId: string
  command: string
  cwd: string
  startedAt: number
  status: AgentBackgroundCommandStatus
  pid?: number
  endedAt?: number
  exitCode?: number | null
  error?: string
}

export interface AgentBackgroundCommandStartInput {
  command: string
  cwd: string
}

export interface AgentBackgroundCommandStopResult {
  accepted: boolean
  reason?: 'not_running' | 'already_stopping' | 'stop_failed'
  command?: AgentBackgroundCommand
}

export interface AgentBackgroundCommandDetails {
  command: AgentBackgroundCommand
  output: string
  truncated: boolean
}

export interface AgentBackgroundCommandsChangedEvent {
  sessionId: string
  commands: AgentBackgroundCommand[]
}

export function isAgentBackgroundCommandActive(command: Pick<AgentBackgroundCommand, 'status'>): boolean {
  return command.status === 'starting' || command.status === 'running'
    || command.status === 'stopping' || command.status === 'stop_failed'
}
