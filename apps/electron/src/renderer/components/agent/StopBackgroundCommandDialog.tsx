import * as React from 'react'
import type { AgentBackgroundCommand } from '@proma/shared'
import { AlertTriangle, Folder, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { backgroundCommandStatus, isBackgroundCommandActive } from './BackgroundCommandsBar'

interface StopBackgroundCommandDialogProps {
  sessionId: string
  command: AgentBackgroundCommand
  onUpdate: (command: AgentBackgroundCommand) => void
  onClose: () => void
  onRestoreFocus: () => void
}

export function StopBackgroundCommandDialog({ sessionId, command, onUpdate, onClose, onRestoreFocus }: StopBackgroundCommandDialogProps): React.ReactElement {
  const [stopping, setStopping] = React.useState(false)
  const [error, setError] = React.useState('')
  const pending = React.useRef(false)
  const alive = React.useRef(false)
  React.useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const stop = async (): Promise<void> => {
    if (pending.current || !isBackgroundCommandActive(command) || command.status === 'stopping') return
    pending.current = true
    setStopping(true)
    setError('')
    try {
      const result = await window.electronAPI.stopAgentBackgroundCommand(sessionId, command.id)
      if (!alive.current) return
      if (result.command && (result.command.sessionId !== sessionId || result.command.id !== command.id)) {
        throw new Error('停止结果与当前命令不匹配，请重新打开列表。')
      }
      if (result.command) onUpdate(result.command)
      if (result.accepted && result.command?.status === 'stopped') {
        toast.success('后台命令已停止')
        onClose()
        return
      }
      if (result.reason === 'already_stopping' || result.command?.status === 'stopping') {
        setError('命令正在停止，等待状态更新后再操作。')
      } else if (result.reason === 'not_running') {
        setError(`命令当前不可停止${result.command ? `（${backgroundCommandStatus(result.command)}）` : ''}，请返回列表查看状态。`)
      } else {
        setError(result.command?.error || '未能确认进程已停止，请重试。')
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      if (alive.current) setStopping(false)
    }
  }

  const canStop = isBackgroundCommandActive(command) && command.status !== 'stopping'
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending.current) onClose() }}>
      <AlertDialogContent onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }} className="w-[calc(100vw-2rem)] max-w-md max-h-[85vh] overflow-y-auto rounded-2xl p-5">
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle className="text-base">停止后台命令？</AlertDialogTitle>
          <AlertDialogDescription className="text-xs leading-5">将结束此命令及其子进程。未保存的进程内数据可能丢失。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-muted/30">
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all px-3 py-3 font-mono text-xs leading-5">{command.command}</pre>
          <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground"><Folder className="size-3 shrink-0" /><span className="truncate" title={command.cwd}>{command.cwd}</span></div>
        </div>
        <p className="text-xs text-muted-foreground">当前状态：{backgroundCommandStatus(command)}</p>
        {error && <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-5 text-destructive"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 max-h-32 overflow-auto break-all">{error}</span></div>}
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel disabled={stopping} className="mt-0 h-9 rounded-lg text-xs">{canStop ? '取消' : '返回列表'}</AlertDialogCancel>
          <AlertDialogAction disabled={stopping || !canStop} className="h-9 gap-2 rounded-lg bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90" onClick={(event) => { event.preventDefault(); void stop() }}>{stopping && <Loader2 className="size-3.5 animate-spin" />}{stopping ? '正在停止…' : error ? '重试停止' : '确认停止'}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
