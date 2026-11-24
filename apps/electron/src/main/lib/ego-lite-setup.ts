import type { EgoSetupState } from '@proma/shared'

type InstallStage = 'detecting' | 'downloading' | 'installing' | 'starting'
interface SetupSteps {
  install(signal: AbortSignal, report: (stage: InstallStage, message: string, percent?: number) => void): Promise<void>
  verify(signal: AbortSignal): Promise<string>
  configure(workspaceId: string, signal: AbortSignal): Promise<void>
  enable(): void
  load(): EgoSetupState | null
  save(state: EgoSetupState): void
}

const activeStages = new Set(['detecting', 'downloading', 'installing', 'starting', 'configuring', 'cancelling'])
const idle: EgoSetupState = { stage: 'idle', message: '' }

/** 同一应用实例只有一个安装任务。重试重新检测磁盘与客户端，保留先前已完成的步骤。 */
export function createEgoLiteSetup(steps: SetupSteps) {
  let state: EgoSetupState | undefined
  let active: AbortController | undefined
  const status = (): EgoSetupState => {
    if (!state) {
      const previous = steps.load()
      state = previous && activeStages.has(previous.stage)
        ? { stage: 'failed', workspaceId: previous.workspaceId, message: '上次准备中断。重试会重新检测并复用已有安装。' }
        : previous ?? idle
    }
    return { ...state }
  }
  function publish(next: EgoSetupState) {
    const stageChanged = next.stage !== state?.stage
    state = next
    if (stageChanged) steps.save(next)
  }
  async function run(controller: AbortController, workspaceId?: string) {
    const signal = controller.signal
    try {
      await steps.install(signal, (stage, message, percent) => {
        signal.throwIfAborted()
        publish({ stage, message, percent, workspaceId })
      })
      signal.throwIfAborted()
      publish({ stage: 'starting', message: '正在验证浏览器连接…', workspaceId })
      const version = await steps.verify(signal)
      signal.throwIfAborted()
      if (workspaceId) {
        publish({ stage: 'configuring', message: '正在准备工作区专用浏览器配置…', workspaceId })
        await steps.configure(workspaceId, signal)
        signal.throwIfAborted()
      }
      steps.enable()
      state = { stage: 'ready', message: `Ego Lite ${version} 已就绪。${workspaceId ? '' : '首次使用工作区时会自动准备其配置。'}`, workspaceId }
      try { steps.save(state) } catch { /* 设置已保存；日志故障不能反转成功。 */ }
    } catch (error) {
      const next: EgoSetupState = signal.aborted
        ? { stage: 'cancelled', message: '已取消。重试会复用已完成的安装。', workspaceId }
        : { stage: 'failed', message: error instanceof Error ? error.message : '准备失败，请重试。', workspaceId }
      state = next
      try { steps.save(next) } catch { /* 存储不可写时仍须向设置页报告失败。 */ }
    } finally {
      active = undefined
    }
  }
  return {
    status,
    start(workspaceId?: string): EgoSetupState {
      if (active) return status()
      const controller = new AbortController()
      const next: EgoSetupState = { stage: 'detecting', message: '正在检测现有安装…', workspaceId }
      // 先确保持久化可写，再开始任何外部更改。
      steps.save(next)
      state = next
      active = controller
      void run(controller, workspaceId)
      return status()
    },
    cancel(): EgoSetupState {
      if (active && !active.signal.aborted) {
        const next: EgoSetupState = { stage: 'cancelling', message: '正在取消，等待当前步骤安全结束…', workspaceId: state?.workspaceId }
        state = next
        try { steps.save(next) } catch { /* 取消不能因状态记录失败而失效。 */ }
        active.abort()
      }
      return status()
    },
  }
}
