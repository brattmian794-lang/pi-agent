import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { AgentBackgroundCommand } from '@proma/shared'
import { agentBackgroundCommandsAtom, agentBackgroundCommandsAtomFamily } from '@/atoms/agent-atoms'
import { BackgroundCommandsPopover } from './BackgroundCommandsPopover'
import { StopBackgroundCommandDialog } from './StopBackgroundCommandDialog'
import { BackgroundCommandDetails } from './BackgroundCommandDetails'

export function BackgroundCommandsOverlay({ sessionId }: { sessionId: string }): React.ReactElement {
  return <SessionBackgroundCommands key={sessionId} sessionId={sessionId} />
}

function SessionBackgroundCommands({ sessionId }: { sessionId: string }): React.ReactElement {
  const commands = useAtomValue(agentBackgroundCommandsAtomFamily(sessionId))
  const setCommands = useSetAtom(agentBackgroundCommandsAtom)
  const store = useStore()
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<AgentBackgroundCommand | null>(null)
  const [details, setDetails] = React.useState<AgentBackgroundCommand | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const generation = React.useRef(0)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    const current = ++generation.current
    const snapshot = new Map((store.get(agentBackgroundCommandsAtom).get(sessionId) ?? []).map((command) => [command.id, command]))
    setLoading(true)
    setError('')
    try {
      const items = await window.electronAPI.listAgentBackgroundCommands(sessionId)
      if (current !== generation.current) return
      setCommands((prev) => {
        const map = new Map(prev)
        const existing = prev.get(sessionId) ?? []
        const merged = new Map(existing.map((command) => [command.id, command]))
        for (const command of items) {
          if (command.sessionId !== sessionId) continue
          // 请求期间收到的事件优先，缺席记录保留，不能用消失推断终态。
          if (merged.get(command.id) === snapshot.get(command.id)) merged.set(command.id, command)
        }
        map.set(sessionId, [...merged.values()])
        return map
      })
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [sessionId, setCommands, store])

  React.useEffect(() => {
    void refresh()
    return () => { generation.current++ }
  }, [refresh])

  React.useEffect(() => {
    // 即使空会话隐藏入口，也持续订阅首次启动事件，不依赖其他页面的监听挂载时序。
    return window.electronAPI.onAgentBackgroundCommandsChanged((event) => {
      if (event.sessionId !== sessionId) return
      generation.current++
      setLoading(false)
      setError('')
      setCommands((prev) => {
        const map = new Map(prev)
        map.set(sessionId, event.commands.filter((command) => command.sessionId === sessionId))
        return map
      })
    })
  }, [sessionId, setCommands])

  const updateCommand = React.useCallback((command: AgentBackgroundCommand): void => {
    if (command.sessionId !== sessionId) return
    // 停止结果使旧的列表快照失效，避免覆盖已验证的终态。
    generation.current++
    setLoading(false)
    setCommands((prev) => {
      const map = new Map(prev)
      const items = prev.get(sessionId) ?? []
      map.set(sessionId, [...items.filter((item) => item.id !== command.id), command])
      return map
    })
  }, [sessionId, setCommands])

  const restoreFocus = (): void => { triggerRef.current?.focus() }
  return (
    <>
      {commands.some((command) => command.sessionId === sessionId) && <BackgroundCommandsPopover commands={commands.filter((command) => command.sessionId === sessionId)} open={open} loading={loading} error={error} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) void refresh() }} onRefresh={() => { void refresh() }} onStop={(command) => { setSelected(command); setOpen(false) }} onDetails={(command) => { setDetails(command); setOpen(false) }} triggerRef={triggerRef} dialogOpen={selected !== null || details !== null} />}
      {selected && <StopBackgroundCommandDialog key={selected.id} sessionId={sessionId} command={commands.find((command) => command.id === selected.id) ?? selected} onUpdate={updateCommand} onClose={() => setSelected(null)} onRestoreFocus={restoreFocus} />}
      {details && <BackgroundCommandDetails key={details.id} sessionId={sessionId} command={commands.find((command) => command.id === details.id) ?? details} onClose={() => setDetails(null)} onRestoreFocus={restoreFocus} />}
    </>
  )
}
