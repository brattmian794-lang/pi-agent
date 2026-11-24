import { isEgoLitePlatformSupported } from './ego-lite-settings-policy'
import { egoLiteAuthorizationSignal } from './ego-lite-revocation'
import type { createEgoLiteRun, EgoAction } from './ego-lite-runtime'
import { isEgoSetupActive, type EgoSetupState } from '@proma/shared'

export type ExternalBrowserAction = EgoAction
export type ExternalBrowserRun = ReturnType<typeof createEgoLiteRun>

export function selectExternalBrowser(settings: { egoLiteEnabled?: boolean; browserExecutionBackend?: string }, platform: NodeJS.Platform, arch: string, foregroundUser: boolean): boolean {
  return settings.egoLiteEnabled === true && settings.browserExecutionBackend === 'egoLite'
    && isEgoLitePlatformSupported(platform, arch) && foregroundUser
}

export function resolveBrowserRoute(settings: Parameters<typeof selectExternalBrowser>[0], platform: NodeJS.Platform, arch: string, foregroundUser: boolean, hasWorkspace: boolean, stage: EgoSetupState['stage']): { backend: 'builtin' | 'egoLite'; label: string } {
  const builtin = (reason?: string) => ({ backend: 'builtin' as const, label: reason ? `本轮网页后端：内置（${reason}）` : '本轮网页后端：内置' })
  if (settings.browserExecutionBackend !== 'egoLite') return builtin()
  if (!settings.egoLiteEnabled) return builtin('Ego Lite 未启用')
  if (!isEgoLitePlatformSupported(platform, arch)) return builtin('当前平台或架构不支持 Ego Lite')
  if (!foregroundUser) return builtin('Ego Lite 仅用于直接发起的前台运行')
  if (!hasWorkspace) return builtin('当前会话没有工作区')
  if (isEgoSetupActive(stage)) return builtin('Ego Lite 正在准备或复检')
  if (stage !== 'ready') return builtin('Ego Lite 未就绪')
  return { backend: 'egoLite', label: '本轮网页后端：Ego Lite（外部窗口）' }
}

export const manualFallback = '请在通用设置中将浏览器执行后端切换为内置，再开始新一轮运行。'

export function externalNavigationUrl(raw: string): string {
  if (!/^https?:\/\//i.test(raw) || /[\s\\\u0000-\u001f]/.test(raw)) throw new Error('请输入完整的 HTTP(S) URL')
  const url = new URL(raw)
  if (url.username || url.password) throw new Error('外部导航地址不能包含凭据')
  return url.href
}

/** 每一代持有自己的句柄，停止期间仍在加载的模块也不能创建窗口。 */
export function lazyExternalBrowserRun(load: () => Promise<() => ExternalBrowserRun>, enabled: () => boolean): ExternalBrowserRun {
  let stopped = false
  let loading: Promise<() => ExternalBrowserRun> | undefined
  let runtime: ExternalBrowserRun | undefined
  function check(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (stopped || !enabled()) throw new Error(`本轮外部浏览器不可用。${manualFallback}`)
  }
  const authorization = egoLiteAuthorizationSignal()
  function stop(): void {
    if (stopped) return
    stopped = true
    authorization.removeEventListener('abort', stop)
    runtime?.stop()
  }
  authorization.addEventListener('abort', stop, { once: true })
  return {
    async execute(action, signal) {
      check(signal)
      try {
        const create = await (loading ??= load())
        check(signal)
        runtime ??= create()
        return await runtime.execute(action, signal)
      } catch (error) {
        throw new Error(`外部浏览器操作未确认完成，请勿重放。${manualFallback} ${error instanceof Error ? error.message : ''}`, { cause: error })
      }
    },
    stop,
  }
}
