import * as React from 'react'
import type { AgentBackgroundCommand } from '@proma/shared'
import { AlertTriangle, ChevronUp, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function isBackgroundCommandActive(command: AgentBackgroundCommand): boolean {
  return ['starting', 'running', 'stopping', 'stop_failed'].includes(command.status)
}

export function backgroundCommandStatus(command: AgentBackgroundCommand): string {
  switch (command.status) {
    case 'starting': return '启动中'
    case 'running': return '运行中'
    case 'stopping': return '正在停止'
    case 'stop_failed': return '停止失败'
    case 'stopped': return '已停止'
    case 'exited': return command.exitCode == null ? '已退出' : `已退出 · 退出码 ${command.exitCode}`
    case 'failed': return '执行失败'
    case 'interrupted': return '意外中断 · 无法恢复控制'
  }
}

export function backgroundCommandHasError(command: AgentBackgroundCommand): boolean {
  return Boolean(command.error) || ['failed', 'stop_failed', 'interrupted'].includes(command.status)
    || (command.status === 'exited' && command.exitCode != null && command.exitCode !== 0)
}

export function backgroundCommandDuration(command: AgentBackgroundCommand, now: number): string {
  if (!isBackgroundCommandActive(command) && command.endedAt == null) return '时长未知'
  const seconds = Math.max(0, Math.floor(((command.endedAt ?? now) - command.startedAt) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

interface BackgroundCommandsBarProps extends React.ComponentPropsWithoutRef<typeof Button> {
  activeCount: number
  hasError: boolean
}

export const BackgroundCommandsBar = React.forwardRef<HTMLButtonElement, BackgroundCommandsBarProps>(
  ({ activeCount, hasError, ...props }, ref) => (
    <Button ref={ref} type="button" variant="ghost" {...props} className="pointer-events-auto h-9 shrink-0 gap-2 rounded-full border border-border/60 bg-background/95 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur-md hover:bg-accent hover:text-foreground" aria-label={`后台命令，${activeCount} 个活动中${hasError ? '，有异常' : ''}`}>
      <SquareTerminal className="size-3.5" />
      <span>后台命令</span>
      <span className="min-w-4 rounded-full bg-primary/10 px-1 text-center text-[10px] font-medium tabular-nums text-primary">{activeCount}</span>
      {hasError && <AlertTriangle aria-hidden="true" className="size-3.5 text-destructive" />}
      <ChevronUp className="size-3 opacity-60" />
    </Button>
  ),
)
BackgroundCommandsBar.displayName = 'BackgroundCommandsBar'
