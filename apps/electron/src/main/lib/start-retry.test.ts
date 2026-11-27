import { describe, expect, test } from 'bun:test'
import { DEFAULT_START_RETRY_DELAYS_MS, StartRetryController } from './start-retry'
import type { StartRetryControllerOptions } from './start-retry'

interface FakeTimerJob {
  callback: () => void
  delayMs: number
  /** 已被 fire 或已被 cancel 标记为失效 */
  settled: boolean
}

interface FakeScheduler {
  options: StartRetryControllerOptions
  jobs: FakeTimerJob[]
  /** 触发一个仍挂起的定时器，返回它的延迟时长（没有挂起时返回 null） */
  fireNext: () => number | null
  pendingCount: () => number
}

/** 假定时器：只记录调度，不真正等待，确保测试不依赖真实时间。 */
function createFakeScheduler(): FakeScheduler {
  const jobs: FakeTimerJob[] = []
  return {
    options: {
      setTimer: (callback: () => void, delayMs: number) => {
        const job: FakeTimerJob = { callback, delayMs, settled: false }
        jobs.push(job)
        return job as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (timer: ReturnType<typeof setTimeout>) => {
        // 取消后标记失效，等价于 clearTimeout 的“到期不再执行”
        ;(timer as unknown as FakeTimerJob).settled = true
      },
    },
    jobs,
    fireNext: () => {
      const job = jobs.find((item) => !item.settled)
      if (!job) return null
      job.settled = true
      job.callback()
      return job.delayMs
    },
    pendingCount: () => jobs.filter((item) => !item.settled).length,
  }
}

describe('启动失败退避重试（issue #19）', () => {
  test('Given 连续遇到可恢复失败 When 逐次调度重试 Then 按 3s/10s/30s 递增并在第四次耗尽', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController(scheduler.options)

    expect(controller.schedule(() => {})).toEqual({ attempt: 1, delayMs: 3_000 })
    expect(controller.schedule(() => {})).toEqual({ attempt: 2, delayMs: 10_000 })
    expect(controller.schedule(() => {})).toEqual({ attempt: 3, delayMs: 30_000 })
    // 耗尽后返回 null：调用方应落 error 交回 bridge-registry 的 60s 健康检查
    expect(controller.schedule(() => {})).toBeNull()
    expect(controller.attemptCount).toBe(3)
    expect(DEFAULT_START_RETRY_DELAYS_MS).toEqual([3_000, 10_000, 30_000])
  })

  test('Given 已排期重试 When 定时器到点 Then 只触发一次回调', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController(scheduler.options)
    let retries = 0

    controller.schedule(() => {
      retries += 1
    })
    expect(retries).toBe(0)
    expect(scheduler.fireNext()).toBe(3_000)
    expect(retries).toBe(1)
    expect(controller.pending).toBe(false)
    // 已触发过的 job 不会重复执行
    expect(scheduler.fireNext()).toBeNull()
    expect(retries).toBe(1)
  })

  test('Given 存在挂起重试 When 调用 cancel Then 到点后不再回调', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController(scheduler.options)
    let retries = 0

    controller.schedule(() => {
      retries += 1
    })
    controller.cancel()

    expect(controller.pending).toBe(false)
    expect(scheduler.pendingCount()).toBe(0)
    scheduler.fireNext()
    expect(retries).toBe(0)
  })

  test('Given 再次调度 When 上一次重试仍挂起 Then 只保留最新的一个，避免重复启动', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController(scheduler.options)

    controller.schedule(() => {})
    controller.schedule(() => {})

    expect(scheduler.pendingCount()).toBe(1)
    expect(controller.attemptCount).toBe(2)
  })

  test('Given 连接已成功 When reset 后再次失败 Then 退避从最短间隔重新开始', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController(scheduler.options)

    controller.schedule(() => {})
    controller.schedule(() => {})
    controller.reset()
    expect(controller.attemptCount).toBe(0)

    expect(controller.schedule(() => {})).toEqual({ attempt: 1, delayMs: 3_000 })
  })

  test('Given 自定义退避序列 When 调度 Then 使用注入的间隔与长度', () => {
    const scheduler = createFakeScheduler()
    const controller = new StartRetryController({ ...scheduler.options, delaysMs: [500] })

    expect(controller.schedule(() => {})).toEqual({ attempt: 1, delayMs: 500 })
    expect(controller.schedule(() => {})).toBeNull()
  })
})
