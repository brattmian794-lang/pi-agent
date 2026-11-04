import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentBackgroundCommand, AgentBackgroundCommandDetails, AgentBackgroundCommandStartInput } from '@proma/shared'

export interface PiBackgroundCommandClient {
  start(input: AgentBackgroundCommandStartInput): Promise<AgentBackgroundCommand>
  list(): Promise<AgentBackgroundCommand[]>
  output(commandId: string): Promise<AgentBackgroundCommandDetails | null>
}

/** 仅识别未引用的 Shell 后台运算符；不把字符串、注释、重定向和 && 当作后台执行。 */
export function hasShellBackgroundOperator(command: string): boolean {
  let quote = ''
  let escaped = false
  let comment = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (comment) { if (char === '\n') comment = false; continue }
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '#' && (i === 0 || /[\s;]/.test(command[i - 1]!))) { comment = true; continue }
    if (char === '&' && command[i - 1] !== '&' && command[i - 1] !== '>' && command[i - 1] !== '<'
      && command[i + 1] !== '&' && command[i + 1] !== '>') return true
  }
  return false
}

export function createManagedPiShellTool(foreground: ToolDefinition, client: PiBackgroundCommandClient | undefined): ToolDefinition {
  return {
    ...foreground,
    description: `${foreground.description}\n后台服务请设置 runInBackground=true，直接传入服务命令，无需 nohup 或 &。返回 commandId，可用 BackgroundCommand 查询输出。停止需用户在后台命令界面确认。`,
    parameters: Type.Object({
      command: Type.String({ description: '要执行的 Shell 命令。' }),
      timeout: Type.Optional(Type.Number({ description: '前台命令超时秒数。' })),
      runInBackground: Type.Optional(Type.Boolean({ description: '作为受管后台命令执行，跨 Agent 回合保留。' })),
    }),
    async execute(toolCallId, rawParams, signal, onUpdate, context) {
      const params = rawParams as { command: string; timeout?: number; runInBackground?: boolean }
      if (!params.runInBackground && !(foreground.name === 'bash' && hasShellBackgroundOperator(params.command))) {
        return foreground.execute(toolCallId, params, signal, onUpdate, context)
      }
      if (signal?.aborted) throw new Error('后台命令启动已取消')
      if (!client) throw new Error('后台命令服务不可用')
      const command = await client.start({ command: params.command, cwd: context.cwd })
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...command, message: '后台命令由应用管理。使用 BackgroundCommand 查看输出；停止需用户确认。' }) }],
        details: { commandId: command.id, status: command.status },
      }
    },
  }
}

export function createPiBackgroundQueryTool(client: PiBackgroundCommandClient): ToolDefinition {
  return {
    name: 'BackgroundCommand', label: '查询后台命令',
    description: '查询当前会话后台命令的状态与最近输出。省略 commandId 时列出命令。停止命令需用户在界面确认。',
    parameters: Type.Object({ commandId: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const { commandId } = params as { commandId?: string }
      const result = commandId ? await client.output(commandId) : await client.list()
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    },
  }
}
