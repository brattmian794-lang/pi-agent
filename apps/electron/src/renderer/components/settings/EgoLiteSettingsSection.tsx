import * as React from 'react'
import { useAtomValue } from 'jotai'
import { currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { isEgoSetupActive } from '@proma/shared'
import type { EgoLiteSettings, EgoSetupState } from '@proma/shared'
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from './primitives'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function EgoLiteSettingsSection(): React.ReactElement | null {
  const api = window.electronAPI
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const [settings, setSettings] = React.useState<EgoLiteSettings | null>(null)
  const [setup, setSetup] = React.useState<EgoSetupState | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const active = setup !== null && isEgoSetupActive(setup.stage)

  React.useEffect(() => {
    let disposed = false
    async function load(): Promise<void> {
      const settings = await api.getEgoLiteSettings()
      if (disposed || !settings) return
      const state = await api.getEgoLiteSetupStatus()
      const current = await api.getEgoLiteSettings()
      if (!disposed) {
        setSetup(state)
        setSettings(current)
      }
    }
    void load().catch((error: unknown) => {
      if (!disposed) setError(`读取 Ego Lite 设置失败：${String(error)}`)
    })
    return () => { disposed = true }
  }, [api])

  React.useEffect(() => {
    if (!active || busy) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll(): Promise<void> {
      try {
        const state = await api.getEgoLiteSetupStatus()
        if (disposed) return
        if (!isEgoSetupActive(state.stage)) {
          const current = await api.getEgoLiteSettings()
          if (disposed) return
          setSettings(current)
          setSetup(state)
          setError('')
          return
        }
        setSetup(state)
        setError('')
      } catch (error) {
        if (!disposed) setError(`读取准备状态失败：${String(error)}`)
      }
      if (!disposed) timer = setTimeout(poll, 1000)
    }
    timer = setTimeout(poll, 1000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, api, busy])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(`Ego Lite 操作失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  function start(): Promise<void> {
    return run(async () => {
      setSetup(await api.startEgoLiteSetup(workspaceId ?? undefined))
      setSettings(await api.getEgoLiteSettings())
    })
  }

  function cancel(): Promise<void> {
    return run(async () => {
      setSetup(await api.cancelEgoLiteSetup())
      setSettings(await api.getEgoLiteSettings())
    })
  }

  const canRetry = setup?.stage === 'failed' || setup?.stage === 'cancelled'
  const showSetup = active || (settings?.egoLiteEnabled && setup?.stage === 'ready')
  const percent = setup?.percent

  if (!settings && !error) return null
  return (
    <SettingsSection title="浏览器执行后端" description="Ego Lite 使用外部窗口；默认仍使用内置浏览器。">
      <SettingsCard>
        {settings && <>
          <SettingsToggle label="启用 Ego Lite" description="开启即授权自动检测、下载和安装 Ego Lite。关闭会取消准备并恢复内置浏览器。"
            checked={settings.egoLiteEnabled || active} disabled={busy || setup?.stage === 'cancelling'}
            onCheckedChange={(checked) => {
              if (checked) return start()
              return run(async () => {
                setSettings(await api.changeEgoLiteSettings(false))
                setSetup(await api.getEgoLiteSetupStatus())
              })
            }} />
          {setup?.stage === 'failed' && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">Ego Lite 启用未完成</p>
            <p className="mt-1 text-foreground">{setup.message || '准备流程失败，请重试。'}</p>
            <p className="mt-1 text-muted-foreground">新运行暂用内置浏览器，已选后端不变。处理后可点击“重试准备”。</p>
          </div>}
          <SettingsRow label="Ego 浏览器配置" description={settings.egoLiteProfileMode === 'current'
            ? '复用现有默认 Profile；任务空间分开，但各工作区共享登录态和网站数据。'
            : '每个工作区使用独立的非默认 Profile，需要客户端中已存在对应配置。'}>
            <Select disabled={busy || active} value={settings.egoLiteProfileMode}
              onValueChange={(value) => {
                if (value === 'current' || value === 'workspace') {
                  void run(async () => { setSettings(await api.changeEgoLiteSettings(value)) })
                }
              }}>
              <SelectTrigger aria-label="Ego 浏览器配置模式"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="current">复用当前配置（推荐）</SelectItem>
                <SelectItem value="workspace">工作区独立配置</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow label="下一次运行使用" description={settings.browserExecutionBackend === 'egoLite' && setup?.stage !== 'ready'
            ? '已保留 Ego Lite 偏好。就绪前，新运行暂用内置浏览器。'
            : undefined}>
            <Select disabled={busy || active || !settings.egoLiteEnabled} value={settings.browserExecutionBackend}
              onValueChange={(value) => {
                if (value === 'builtin' || value === 'egoLite') {
                  void run(async () => { setSettings(await api.changeEgoLiteSettings(value)) })
                }
              }}>
              <SelectTrigger aria-label="下一次运行使用的浏览器"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="builtin">内置浏览器</SelectItem>
                <SelectItem value="egoLite">Ego Lite</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          {showSetup && <SettingsRow label="准备状态" description={<span role="status" className="break-words">
            {setup?.message}{active && typeof percent === 'number' ? ` (${Math.round(percent)}%)` : ''}
          </span>}>
            {active && <Button variant="outline" size="sm" disabled={busy || setup?.stage === 'cancelling'} onClick={cancel}>取消准备</Button>}
          </SettingsRow>}
          {!active && (canRetry || settings.egoLiteEnabled) && <SettingsRow label="Ego Lite 检查与修复"
            description="复检期间暂停 Ego Lite 操作，保留已选后端与浏览器配置。">
            <Button variant="outline" size="sm" disabled={busy} onClick={start}>{canRetry ? '重试准备' : '重新检查并修复'}</Button>
          </SettingsRow>}
        </>}
        {error && <p role="alert" className="break-words px-4 py-2 text-sm text-destructive">{error}</p>}
      </SettingsCard>
    </SettingsSection>
  )
}
