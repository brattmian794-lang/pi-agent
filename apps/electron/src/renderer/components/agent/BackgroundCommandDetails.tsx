import * as React from 'react'
import type { AgentBackgroundCommand, AgentBackgroundCommandDetails } from '@proma/shared'
import { Folder, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { backgroundCommandStatus, isBackgroundCommandActive } from './BackgroundCommandsBar'

interface BackgroundCommandDetailsProps {
  sessionId: string
  command: AgentBackgroundCommand
  onClose: () => void
  onRestoreFocus: () => void
}

export function BackgroundCommandDetails({ sessionId, command, onClose, onRestoreFocus }: BackgroundCommandDetailsProps): React.ReactElement {
  const [details, setDetails] = React.useState<AgentBackgroundCommandDetails | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  const active = isBackgroundCommandActive(command)

  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const load = async (): Promise<void> => {
      setLoading(true)
      try {
        const result = await window.electronAPI.getAgentBackgroundCommandDetails(sessionId, command.id)
        if (cancelled) return
        if (!result) throw new Error('未找到此命令的输出记录。')
        if (result.command.sessionId !== sessionId || result.command.id !== command.id) throw new Error('输出记录与当前命令不匹配。')
        setDetails(result)
        setError('')
        if (active && isBackgroundCommandActive(result.command)) timer = window.setTimeout(() => { void load() }, 2000)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [sessionId, command.id, active, revision])

  const displayedCommand = details?.command ?? command
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }} className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl gap-3 overflow-y-auto rounded-2xl p-5">
        <DialogHeader className="min-w-0 pr-7 text-left">
          <DialogTitle className="text-base">后台命令输出</DialogTitle>
          <DialogDescription className="text-xs">{backgroundCommandStatus(displayedCommand)} · 最近输出{active ? ' · 打开时自动刷新' : ''}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/30">
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-5">{command.command}</pre>
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground"><Folder className="size-3 shrink-0" /><span className="truncate" title={command.cwd}>{command.cwd}</span></div>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span role="status">{loading ? '正在加载最近输出…' : details?.truncated ? '仅显示最近输出，较早内容已截断' : '最近输出'}</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" disabled={loading} onClick={refresh}>{loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}刷新</Button>
        </div>
        {error && <p role="alert" className="max-h-24 overflow-auto break-all rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">加载失败：{error} 可点击刷新重试。{details ? '下方保留上次获取的输出。' : ''}</p>}
        {displayedCommand.error && <p className="max-h-24 overflow-auto break-all text-xs text-destructive">{displayedCommand.error}</p>}
        <pre aria-label="命令最近输出" aria-busy={loading} className="min-h-32 max-h-[40vh] min-w-0 overflow-auto whitespace-pre rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-5">{details?.output || (loading && !details ? '正在读取输出…' : error && !details ? '输出暂不可用' : '暂无输出')}</pre>
      </DialogContent>
    </Dialog>
  )
}
