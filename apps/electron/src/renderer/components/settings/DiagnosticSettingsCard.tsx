import * as React from 'react'
import { useAtom } from 'jotai'
import { Bug, Download, FolderOpen, Loader2, Terminal } from 'lucide-react'
import { diagnosticStateAtom } from '@/lib/diagnostics'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { SettingsCard, SettingsRow, SettingsToggle } from './primitives'

export function DiagnosticSettingsCard(): React.ReactElement {
  const [state, setState] = useAtom(diagnosticStateAtom)
  const [pending, setPending] = React.useState<string | null>('load')
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setPending('load')
    setError(null)
    try { setState(await window.electronAPI.getDiagnosticState()) }
    catch { setError('加载诊断状态失败，请重试。') }
    finally { setPending(null) }
  }, [setState])

  React.useEffect(() => { void load() }, [load])

  const run = async (name: string, action: () => Promise<void>): Promise<void> => {
    setPending(name)
    setError(null)
    setMessage(null)
    try {
      await action()
      setState(await window.electronAPI.getDiagnosticState())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '诊断操作失败，请重试。')
    } finally { setPending(null) }
  }

  const exportLogs = async (): Promise<void> => {
    const result = await window.electronAPI.exportDiagnosticLogs()
    setMessage(result.status === 'exported'
      ? '日志已导出。请检查是否包含对话内容、路径或其他敏感信息，再分享给支持人员。'
      : result.status === 'empty'
        ? '暂无诊断日志。请先开启诊断日志，复现问题后再导出。'
        : '已取消导出。')
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-2 px-4 pt-4">
        <Bug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">开发者与诊断</h3>
      </div>
      <SettingsToggle
        label="诊断日志"
        description="默认关闭。开启后立即收集后续主进程和主界面的日志，重启后保留开关状态；关闭停止采集但不删除历史日志。"
        checked={state?.enabled ?? false}
        disabled={!state || pending !== null}
        onCheckedChange={(enabled) => { void run('toggle', async () => {
          setState(await window.electronAPI.setDiagnosticEnabled(enabled))
          setMessage(enabled ? '诊断日志已开启，请复现问题后导出。' : '诊断日志已关闭，历史日志仍可导出。')
        }) }}
      />
      <SettingsRow label="日志位置" description="按每文件 5 MiB、最多 5 份轮转（约 25 MiB），过长的单条日志会截断；前端高频日志会限流。">
        <span className="max-w-sm break-all text-xs text-muted-foreground select-text">{state?.directory ?? '尚未加载'}</span>
      </SettingsRow>
      <div className="flex flex-wrap gap-2 px-4 pb-4" aria-busy={pending !== null}>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => { void run('devtools', () => window.electronAPI.openDiagnosticDevTools()) }}>
          <Terminal className="mr-1.5 h-4 w-4" aria-hidden="true" />打开开发者工具
        </Button>
        <Button variant="outline" size="sm" disabled={pending !== null || !state} onClick={() => { void run('directory', () => window.electronAPI.openDiagnosticDirectory()) }}>
          <FolderOpen className="mr-1.5 h-4 w-4" aria-hidden="true" />打开日志目录
        </Button>
        <Button variant="outline" size="sm" disabled={pending !== null || !state} onClick={() => { void run('export', exportLogs) }}>
          {pending === 'export' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />}导出日志
        </Button>
        {pending === 'load' && <span role="status" className="self-center text-xs text-muted-foreground">正在加载诊断状态…</span>}
        {error && <Button variant="ghost" size="sm" onClick={() => { void load() }}>重新加载状态</Button>}
      </div>
      <div className="space-y-2 px-4 pb-4">
        <Alert>
          <AlertDescription className="text-xs leading-relaxed">
            开启诊断日志 → 复现问题 → 导出日志 → 关闭采集。日志仅保存在本机，不自动上传，不切换应用构建模式或数据目录。不会补录开启前的日志，也不包含所有独立子进程的输出。
            <br />会自动脱敏已识别的 API Key、Token、密码等凭据，但不能保证全部识别；日志仍可能含对话内容和本机路径，分享前请检查。
          </AlertDescription>
        </Alert>
        {(error || state?.lastError) && <p role="alert" className="break-all text-xs text-destructive">{error ?? `日志存储异常：${state?.lastError}`}</p>}
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      </div>
    </SettingsCard>
  )
}
