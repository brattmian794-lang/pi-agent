import * as React from 'react'
import type { AgentBackgroundCommand } from '@proma/shared'
import { Folder, Loader2, RefreshCw, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BackgroundCommandsBar, backgroundCommandDuration, backgroundCommandHasError, backgroundCommandStatus, isBackgroundCommandActive } from './BackgroundCommandsBar'

interface BackgroundCommandsPopoverProps {
  commands: AgentBackgroundCommand[]
  open: boolean
  loading: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
  onDetails: (command: AgentBackgroundCommand) => void
  onStop: (command: AgentBackgroundCommand) => void
  triggerRef: React.RefObject<HTMLButtonElement>
  dialogOpen: boolean
}

export function BackgroundCommandsPopover({ commands, open, loading, error, onOpenChange, onRefresh, onDetails, onStop, triggerRef, dialogOpen }: BackgroundCommandsPopoverProps): React.ReactElement {
  const [now, setNow] = React.useState(Date.now)
  const active = commands.filter(isBackgroundCommandActive)
  const ended = commands.filter((command) => !isBackgroundCommandActive(command)).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  React.useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <BackgroundCommandsBar ref={triggerRef} activeCount={active.length} hasError={Boolean(error) || commands.some(backgroundCommandHasError)} />
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={10} onCloseAutoFocus={(event) => { if (dialogOpen) event.preventDefault() }} className="w-[min(460px,calc(100vw-2rem))] overflow-hidden rounded-xl border-border/60 bg-popover p-0 shadow-lg">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5">
          <span className="text-sm font-medium">后台命令 <span className="ml-1 text-xs font-normal text-muted-foreground">{active.length} 个活动中</span></span>
          <Button variant="ghost" size="icon" className="size-7" disabled={loading} onClick={onRefresh} aria-label="刷新后台命令">{loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</Button>
        </div>
        {error && <div role="alert" className="break-words border-b border-border/50 px-4 py-2 text-xs text-destructive">刷新失败：{error}。可点击刷新重试。</div>}
        <div className="max-h-[min(400px,60vh)] overflow-y-auto p-2" aria-busy={loading}>
          {commands.length === 0 && <div className="flex flex-col items-center gap-2 px-4 py-7 text-xs text-muted-foreground"><SquareTerminal className="size-6 opacity-40" /><span>{loading ? '正在加载后台命令…' : error ? '暂时无法获取命令列表' : '当前会话暂无后台命令'}</span></div>}
          {([{ title: '活动命令', items: active }, { title: '最近结束', items: ended }]).map(({ title, items }) => items.length > 0 && (
            <section key={title} aria-label={title}>
              <h3 className="px-2 py-2 text-[11px] font-medium text-muted-foreground">{title} · {items.length}</h3>
              {items.map((command) => (
                <div key={command.id} className="min-w-0 space-y-1.5 rounded-lg px-2 py-2.5 hover:bg-muted/50">
                  <div className="line-clamp-2 break-all font-mono text-xs leading-5" title={command.command}>{command.command}</div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"><Folder className="size-3 shrink-0" /><span className="truncate" title={command.cwd}>{command.cwd}</span></div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className={backgroundCommandHasError(command) ? 'text-destructive' : ''}>{backgroundCommandStatus(command)}</span>
                    <span className="tabular-nums">{backgroundCommandDuration(command, now)}</span>
                    <div className="ml-auto flex gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onDetails(command)}>查看输出</Button>
                      {isBackgroundCommandActive(command) && <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={command.status === 'stopping'} onClick={() => onStop(command)} aria-label={`停止后台命令 ${command.command}`}>{command.status === 'stopping' ? '正在停止…' : command.status === 'stop_failed' ? '重试停止' : '停止'}</Button>}
                    </div>
                  </div>
                  {command.error && <p className="max-h-16 overflow-auto break-all text-[11px] leading-4 text-destructive">{command.error}</p>}
                </div>
              ))}
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
