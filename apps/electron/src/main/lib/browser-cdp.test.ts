import { describe, expect, it } from 'bun:test'
import {
  BROWSER_CDP_COMMAND_TIMEOUT_MS,
  BROWSER_OBSERVE_AX_DEPTH,
  BROWSER_OBSERVE_EXTENDED_AX_DEPTH,
  BrowserCdpTimeoutError,
  BrowserFailureDeduper,
  BrowserOperationAbortedError,
  describeBrowserNavigationFailure,
  describeBrowserScriptFailure,
  formatBrowserFailureReason,
  resolveBrowserObserveAxDepth,
  withBrowserCdpTimeout,
} from './browser-cdp'

/** 让出事件循环，用于等待超时计时器或迟到的命令回调。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('withBrowserCdpTimeout', () => {
  it('命令在预算内完成时返回结果', async () => {
    await expect(withBrowserCdpTimeout(async () => 'ok', 'Page.navigate', 50)).resolves.toBe('ok')
  })

  it('命令超时抛出带 method 与 timeoutMs 的 BrowserCdpTimeoutError', async () => {
    const error = await withBrowserCdpTimeout(() => new Promise<string>(() => {}), 'Page.navigate', 10).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(BrowserCdpTimeoutError)
    const timeoutError = error as BrowserCdpTimeoutError
    expect(timeoutError.method).toBe('Page.navigate')
    expect(timeoutError.timeoutMs).toBe(10)
    expect(timeoutError.name).toBe('BrowserCdpTimeoutError')
    // 文案必须说明“结果未知”，否则调用方会误判成页面加载失败。
    expect(timeoutError.message).toContain('结果未知')
    expect(timeoutError.message).toContain('Page.navigate')
    expect(timeoutError.message).toContain('1 秒')
  })

  it('超时后迟到的命令结果被忽略，不会二次 settle', async () => {
    let commandFinished = false
    const pending = withBrowserCdpTimeout(async () => {
      await delay(30)
      commandFinished = true
      return 'late'
    }, 'Runtime.evaluate', 10)
    await expect(pending).rejects.toBeInstanceOf(BrowserCdpTimeoutError)
    await delay(50)
    // 底层命令照常跑完，但结果已被丢弃；这里只验证忽略迟到结果不会抛错。
    expect(commandFinished).toBe(true)
  })

  it('中止信号把等待中的命令转成 BrowserOperationAbortedError', async () => {
    const controller = new AbortController()
    const pending = withBrowserCdpTimeout(() => new Promise<string>(() => {}), 'Accessibility.getFullAXTree', 1_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(BrowserOperationAbortedError)
  })

  it('已中止的信号不会执行命令', async () => {
    const controller = new AbortController()
    controller.abort()
    let invoked = false
    const pending = withBrowserCdpTimeout(async () => {
      invoked = true
      return 'ok'
    }, 'Runtime.evaluate', 1_000, controller.signal)
    await expect(pending).rejects.toBeInstanceOf(BrowserOperationAbortedError)
    await delay(0)
    expect(invoked).toBe(false)
  })

  it('命令自身失败时原样透出错误', async () => {
    const failure = new Error('net::ERR_NAME_NOT_RESOLVED')
    await expect(withBrowserCdpTimeout(async () => { throw failure }, 'Page.navigate', 50)).rejects.toBe(failure)
  })

  it('默认预算与生产常量一致', () => {
    expect(BROWSER_CDP_COMMAND_TIMEOUT_MS).toBe(8_000)
  })
})

describe('describeBrowserNavigationFailure', () => {
  it('区分命令超时、主动停止与已确认的加载失败', () => {
    const timeout = describeBrowserNavigationFailure('example.com', new BrowserCdpTimeoutError('Page.navigate', 8_000))
    expect(timeout.status).toBe('unknown')
    expect(timeout.summary).toContain('命令已超时')

    const aborted = describeBrowserNavigationFailure('example.com', new BrowserOperationAbortedError())
    expect(aborted.status).toBe('unknown')
    expect(aborted.summary).toBe('打开 example.com 已停止，结果未知')

    const failed = describeBrowserNavigationFailure('example.com', new Error('net::ERR_CONNECTION_REFUSED'))
    expect(failed.status).toBe('failed')
    expect(failed.summary).toBe('无法打开 example.com')
  })

  it('不再把超时当成页面加载失败', () => {
    expect(describeBrowserNavigationFailure('a.test', new BrowserCdpTimeoutError('Page.navigate', 8_000)).status).not.toBe('failed')
  })
})

describe('describeBrowserScriptFailure', () => {
  it('超时记为 unknown 而不是失败或成功', () => {
    const timeout = describeBrowserScriptFailure('页面 JavaScript 执行', new BrowserCdpTimeoutError('Runtime.evaluate', 8_000))
    expect(timeout.status).toBe('unknown')
    expect(timeout.summary).toBe('页面 JavaScript 执行超时：命令已超时，结果未知，请重新观察确认')
  })

  it('脚本异常才是已确认的失败', () => {
    const failed = describeBrowserScriptFailure('页面内容抽取', new Error('抽取表达式执行异常'))
    expect(failed.status).toBe('failed')
    expect(failed.summary).toBe('页面内容抽取失败')
  })

  it('主动停止同样记为结果未知', () => {
    const aborted = describeBrowserScriptFailure('页面滚动', new BrowserOperationAbortedError())
    expect(aborted.status).toBe('unknown')
    expect(aborted.summary).toBe('页面滚动已停止，结果未知')
  })
})

describe('BrowserFailureDeduper', () => {
  it('同一原因只提示一次', () => {
    const deduper = new BrowserFailureDeduper()
    const error = new Error('DOM should be enabled first')
    expect(deduper.shouldReport(error)).toBe(true)
    expect(deduper.shouldReport(new Error('DOM should be enabled first'))).toBe(false)
    expect(deduper.shouldReport(error)).toBe(false)
  })

  it('不同原因分别提示', () => {
    const deduper = new BrowserFailureDeduper()
    expect(deduper.shouldReport(new Error('DOM should be enabled first'))).toBe(true)
    expect(deduper.shouldReport(new Error('Overlay not available'))).toBe(true)
    expect(deduper.shouldReport(new Error('DOM should be enabled first'))).toBe(false)
  })

  it('超过上限后清空，让新错误继续可见', () => {
    const deduper = new BrowserFailureDeduper(2)
    expect(deduper.shouldReport(new Error('a'))).toBe(true)
    expect(deduper.shouldReport(new Error('b'))).toBe(true)
    // 第三类错误触发清空，随后 a 视作新错误再次提示。
    expect(deduper.shouldReport(new Error('c'))).toBe(true)
    expect(deduper.shouldReport(new Error('a'))).toBe(true)
  })

  it('非 Error 值也能得到稳定的去重键', () => {
    const deduper = new BrowserFailureDeduper()
    expect(formatBrowserFailureReason('boom')).toBe('boom')
    expect(deduper.shouldReport('boom')).toBe(true)
    expect(deduper.shouldReport('boom')).toBe(false)
  })
})

describe('resolveBrowserObserveAxDepth', () => {
  it('默认预算保持浅层，超大预算才加深', () => {
    expect(resolveBrowserObserveAxDepth(240)).toBe(BROWSER_OBSERVE_AX_DEPTH)
    expect(resolveBrowserObserveAxDepth(241)).toBe(BROWSER_OBSERVE_EXTENDED_AX_DEPTH)
  })
})
