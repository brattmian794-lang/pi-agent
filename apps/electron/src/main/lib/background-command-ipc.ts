import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type { AgentBackgroundCommand, AgentBackgroundCommandDetails, AgentBackgroundCommandStopResult } from '@proma/shared'

interface BackgroundCommandIpcEvent { sender: { id: number } }
interface BackgroundCommandIpcRegistrar {
  handle(channel: string, listener: (event: BackgroundCommandIpcEvent, sessionId: string, commandId: string) => unknown): void
}
export interface BackgroundCommandIpcHandlers {
  assertRenderer(senderId: number): void
  list(sessionId: string): AgentBackgroundCommand[]
  stop(sessionId: string, commandId: string): Promise<AgentBackgroundCommandStopResult>
  details(sessionId: string, commandId: string): AgentBackgroundCommandDetails | null
}

/** 四层 IPC 共用的主进程入口；进程控制不能暴露给普通浏览器或附属窗口。 */
export function registerBackgroundCommandIpc(ipc: BackgroundCommandIpcRegistrar, handlers: BackgroundCommandIpcHandlers): void {
  ipc.handle(AGENT_IPC_CHANNELS.LIST_BACKGROUND_COMMANDS, (event, sessionId) => {
    handlers.assertRenderer(event.sender.id)
    return handlers.list(sessionId)
  })
  ipc.handle(AGENT_IPC_CHANNELS.STOP_BACKGROUND_COMMAND, (event, sessionId, commandId) => {
    handlers.assertRenderer(event.sender.id)
    return handlers.stop(sessionId, commandId)
  })
  ipc.handle(AGENT_IPC_CHANNELS.GET_BACKGROUND_COMMAND_DETAILS, (event, sessionId, commandId) => {
    handlers.assertRenderer(event.sender.id)
    return handlers.details(sessionId, commandId)
  })
}
