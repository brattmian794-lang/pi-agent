/**
 * Bridge 启动失败退避重试控制器
 *
 * 背景（issue #19）：系统解锁瞬间网络尚未就绪时，飞书 Bridge 的启动会以
 * `connect ETIMEDOUT` 失败。直接把状态落定为 error，用户要等到下一次 60s
 * 健康检查才恢复；只停在 connecting 又永远不会被健康检查重启
 * （bridge-registry 的 needsRecovery 只在 error 返回 true）。因此由 Bridge
 * 自身按退避重试，耗尽后再落 error 交回自愈守护，两条路径都不会留下永久
 * 卡死的连接。
 *
 * 这里刻意不依赖 electron 或任何单例：定时器可注入，便于测试。
 */

/** 默认启动重试退避（毫秒）：约 3s / 10s / 30s 三次机会。 */
export const DEFAULT_START_RETRY_DELAYS_MS = [3_000, 10_000, 30_000] as const

/** 一次已排期的重试：第几次（从 1 开始）与延迟时长。 */
export interface StartRetryPlan {
  attempt: number
  delayMs: number
}

export interface StartRetryControllerOptions {
  /** 自定义退避序列；默认 DEFAULT_START_RETRY_DELAYS_MS */
  delaysMs?: readonly number[]
  /** 注入定时器，便于测试；默认使用全局 setTimeout */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  /** 注入清理函数，便于测试；默认使用全局 clearTimeout */
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Bridge 启动失败后的退避重试控制器。
 *
 * 保证同一时刻最多只有一个挂起的重试：每次 schedule 先取消上一次挂起，
 * 避免重复 start 导致多条长连接并存。
 */
export class StartRetryController {
  private readonly delaysMs: readonly number[]
  private readonly setTimerFn: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimerFn: (timer: ReturnType<typeof setTimeout>) => void
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: StartRetryControllerOptions = {}) {
    this.delaysMs = options.delaysMs ?? DEFAULT_START_RETRY_DELAYS_MS
    this.setTimerFn = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimerFn = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /** 申请一次重试；返回 null 表示退避已耗尽，调用方应落 error 交回自愈守护。 */
  schedule(retry: () => void): StartRetryPlan | null {
    this.cancel()
    const delayMs = this.delaysMs[this.attempts]
    if (delayMs === undefined) return null

    this.attempts += 1
    const attempt = this.attempts
    const timer = this.setTimerFn(() => {
      this.timer = null
      retry()
    }, delayMs)
    timer.unref?.()
    this.timer = timer
    return { attempt, delayMs }
  }

  /** 取消挂起的重试（不清零计数）。 */
  cancel(): void {
    if (!this.timer) return
    this.clearTimerFn(this.timer)
    this.timer = null
  }

  /** 连接成功或彻底失败后复位：取消挂起重试并把计数归零。 */
  reset(): void {
    this.cancel()
    this.attempts = 0
  }

  /** 是否还有挂起未触发的重试。 */
  get pending(): boolean {
    return this.timer !== null
  }

  /** 已排期的重试次数。 */
  get attemptCount(): number {
    return this.attempts
  }
}
