import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { BrowserTraceItem } from '@proma/shared'

/**
 * 受管浏览器 CDP 超时语义的集成测试（issue #11–#15）。
 * Electron 无法在 bun test 中真启动，这里用最小假实现替换 BrowserWindow /
 * WebContentsView / session，只保留 browser-controller.ts 实际用到的接口。
 */

type CdpHandler = (method: string, params?: Record<string, unknown>) => Promise<unknown>

class FakeDebugger {
  attached = false
  readonly calls: Array<{ method: string }> = []

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
  }

  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method })
    return cdpBehavior(method, params)
  }
}

class FakeWebContents extends EventEmitter {
  readonly debuggerClient = new FakeDebugger()
  private currentUrl = ''
  private destroyed = false
  readonly navigationHistory = {
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => undefined,
    goForward: (): void => undefined,
  }

  get debugger(): FakeDebugger {
    return this.debuggerClient
  }

  setWindowOpenHandler(_handler: unknown): void {}

  loadURL(url: string): Promise<void> {
    this.currentUrl = url
    return loadUrlBehavior(url)
  }

  getURL(): string {
    return this.currentUrl
  }

  getTitle(): string {
    return '测试页面'
  }

  isLoading(): boolean {
    return false
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }

  stop(): void {}
  reload(): void {}
  focus(): void {}
  send(): void {}

  getZoomFactor(): number {
    return 1
  }

  capturePage(): Promise<unknown> {
    return Promise.resolve({ isEmpty: (): boolean => true })
  }
}

class FakeWebContentsView {
  readonly webContents: FakeWebContents

  constructor(_options: unknown) {
    this.webContents = new FakeWebContents()
    createdContents.push(this.webContents)
  }

  setVisible(_visible: boolean): void {}
  setBounds(_bounds: unknown): void {}
}

class FakeElectronSession extends EventEmitter {
  readonly protocol = { handle: (_scheme: string, _handler: unknown): void => undefined }
  readonly webRequest = { onBeforeRequest: (_listener: unknown): void => undefined }

  setPermissionRequestHandler(_handler: unknown): void {}
  setCertificateVerifyProc(_proc: unknown): void {}
  setUserAgent(_userAgent: string): void {}

  getUserAgent(): string {
    return 'pi-agent-test/1.0'
  }
}

const createdContents: FakeWebContents[] = []
/** 每条测试自行改写 CDP 行为；默认返回 CDP 正常工作时的最小响应。 */
let cdpBehavior: CdpHandler = async () => ({})
/** 页面加载行为；默认永不完成，用来模拟 Page.navigate 挂起。 */
let loadUrlBehavior: (url: string) => Promise<void> = () => new Promise<void>(() => {})

const sharedSession = new FakeElectronSession()

// bun test 把多个测试文件跑在同一进程里，electron 的 mock 实例会被先运行的文件缓存。
// 先清理既有 mock，确保本文件注册的 electron 假实现真正生效。
mock.restore()

// 本地预览协议只负责把 prom file 请求映射成文件内容，与 CDP 超时语义无关；
// 它静态依赖 electron 的 net，这里整体替换以避免跨测试文件 mock 顺序带来的链接差异。
mock.module('./local-file-protocol', () => ({
  registerPromaFilePath: (path: string): string => path,
  registerPromaDirectoryPath: (path: string): string => path,
  handlePromaFileRequest: async (): Promise<Response> => new Response(null, { status: 404 }),
}))

mock.module('electron', () => ({
  app: {
    getPath: (): string => 'C:\\temp',
    getVersion: (): string => '0.0.0-test',
  },
  BrowserWindow: class {},
  WebContentsView: FakeWebContentsView,
  session: { fromPartition: (): FakeElectronSession => sharedSession },
  // local-file-protocol.ts 已整体 mock；保留 net 以兼容其它导入路径。
  net: { fetch: (): Promise<unknown> => Promise.resolve({}) },
}))

// 风险告知与设置在测试里恒为“已确认”，避免依赖真实配置文件。
mock.module('./settings-service', () => ({ getSettings: (): Record<string, never> => ({}) }))
mock.module('./browser-risk-disclaimer', () => ({ hasAcknowledgedBrowserRiskDisclaimer: (): boolean => true }))

/**
 * electron 是 CJS 原生模块，一个进程里只有第一次注册的 mock 生效。
 * 若 `bun test` 先把别的测试文件跑过一遍，本文件的 mock 会被忽略、控制器无法链接；
 * 此时跳过（用 `bun test --isolate` 可保证每个文件独立 module registry）。
 */
let BrowserControllerCtor: typeof import('./browser-controller').BrowserController | null = null
let controllerLoadError: unknown = null
try {
  const browserControllerModule = await import('./browser-controller')
  BrowserControllerCtor = browserControllerModule.BrowserController
} catch (error) {
  controllerLoadError = error
  console.warn(
    '[browser-controller.test] 受管浏览器控制器未能加载（electron mock 与其它测试文件冲突），'
    + '请用 `bun test --isolate` 运行本文件以复核 CDP 超时语义:',
    error,
  )
}
const { BrowserCdpTimeoutError } = await import('./browser-cdp')

type BrowserControllerInstance = InstanceType<typeof import('./browser-controller').BrowserController>
/** 模块未能加载时整组跳过，避免把环境问题误报成实现回归。 */
const describeController = describe.skipIf(BrowserControllerCtor === null)

const SESSION_ID = 'session-test'
/** 与生产一致的 8 秒会拖慢测试，注入 25ms 验证同一条超时路径。 */
const TEST_TIMEOUT_MS = 25

function createOwnerWindow(): BrowserWindow {
  const owner = {
    isDestroyed: (): boolean => false,
    isVisible: (): boolean => true,
    webContents: { send: (): void => undefined },
    contentView: { addChildView: (): void => undefined, removeChildView: (): void => undefined },
  }
  return owner as unknown as BrowserWindow
}

function latestContents(): FakeWebContents {
  const contents = createdContents.at(-1)
  if (!contents) throw new Error('测试应已创建受管浏览器的 WebContents')
  return contents
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

let controller: BrowserControllerInstance
let warnMessages: string[] = []
const originalWarn = console.warn

function lastTrace(): BrowserTraceItem {
  const state = controller.getState(SESSION_ID)
  if (!state) throw new Error('受管浏览器状态应存在')
  const item = state.trace.at(-1)
  if (!item) throw new Error('trace 应至少包含一条记录')
  return item
}

function highlightWarnings(): string[] {
  return warnMessages.filter((message) => message.includes('无法渲染 Agent 操作高亮'))
}

beforeEach(() => {
  createdContents.length = 0
  warnMessages = []
  console.warn = (...args: unknown[]): void => {
    warnMessages.push(args.map((value) => (value instanceof Error ? `${value.name}:${value.message}` : String(value))).join(' '))
  }
  cdpBehavior = async (method: string) => {
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: '提交' } }] }
    }
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
    return {}
  }
  loadUrlBehavior = () => new Promise<void>(() => {})
  if (!BrowserControllerCtor) throw new Error('受管浏览器控制器未能加载')
  controller = new BrowserControllerCtor({
    commandTimeoutMs: TEST_TIMEOUT_MS,
    observeTimeoutMs: TEST_TIMEOUT_MS,
    navigationTimeoutMs: TEST_TIMEOUT_MS,
    googleDefaultLoadTimeoutMs: TEST_TIMEOUT_MS,
  })
  controller.setOwnerWindow(createOwnerWindow())
})

afterEach(() => {
  console.warn = originalWarn
  controller.dispose()
})

afterAll(() => {
  mock.restore()
})

describeController('#11 导航超时与加载失败可区分', () => {
  it('Page.navigate 超时返回“结果未知”，不伪装成页面加载失败', async () => {
    const error = await captureError(controller.navigate(SESSION_ID, 'example.com'))

    expect(error).toBeInstanceOf(BrowserCdpTimeoutError)
    const item = lastTrace()
    expect(item.action).toBe('navigate')
    expect(item.status).toBe('unknown')
    expect(item.success).toBe(false)
    expect(item.summary).toContain('超时')
    expect(item.summary).toContain('页面可能仍在加载')
  })

  it('已确认的加载失败仍记为 failed', async () => {
    loadUrlBehavior = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED')
    }
    const error = await captureError(controller.navigate(SESSION_ID, 'example.com'))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(BrowserCdpTimeoutError)
    const item = lastTrace()
    expect(item.status).toBe('failed')
    expect(item.success).toBe(false)
    expect(item.summary).toBe('无法打开 example.com')
  })
})

describeController('#12 侧栏打开浏览器时首屏超时', () => {
  it('首屏加载超时仍返回真实标签状态，重试不会创建重复标签', async () => {
    const first = await controller.open(SESSION_ID)

    expect(first.tabs).toHaveLength(1)
    expect(first.activeTabId).toBe(first.tabs[0]?.tabId ?? '')
    expect(warnMessages.some((message) => message.includes('打开标签时首屏加载超时'))).toBe(true)
    expect(createdContents).toHaveLength(1)

    const second = await controller.open(SESSION_ID)
    expect(second.tabs).toHaveLength(1)
    expect(createdContents).toHaveLength(1)
  })
})

describeController('#13 可访问性快照超时', () => {
  it('快照超时明确失败，并声明“通道已重连 ≠ 观察已恢复”', async () => {
    cdpBehavior = (method) => (method === 'Accessibility.getFullAXTree' ? new Promise<unknown>(() => {}) : Promise.resolve({}))
    const error = await captureError(controller.observe(SESSION_ID))

    expect(error).toBeInstanceOf(BrowserCdpTimeoutError)
    const item = lastTrace()
    expect(item.action).toBe('observe')
    expect(item.status).toBe('failed')
    expect(item.success).toBe(false)
    expect(item.summary).toBe('页面观察超时，可重试或重新加载页面')

    const reconnectWarning = warnMessages.find((message) => message.includes('Accessibility.getFullAXTree'))
    expect(reconnectWarning).toContain('已重连调试通道')
    expect(reconnectWarning).toContain('通道是否可用需下一次命令确认')
    // 重连只重建通道：本测试的假 debugger 确实重新 attach 了，但快照仍然失败。
    expect(latestContents().debugger.isAttached()).toBe(true)
  })
})

describeController('#14 Runtime.evaluate 超时', () => {
  it('求值超时留下 unknown trace，不返回结果也不记为成功', async () => {
    cdpBehavior = (method) => (method === 'Runtime.evaluate' ? new Promise<unknown>(() => {}) : Promise.resolve({}))
    const error = await captureError(controller.evaluate(SESSION_ID, '1 + 1'))

    expect(error).toBeInstanceOf(BrowserCdpTimeoutError)
    const item = lastTrace()
    expect(item.action).toBe('script')
    expect(item.status).toBe('unknown')
    expect(item.success).toBe(false)
    expect(item.summary).toContain('结果未知')

    const reconnectWarning = warnMessages.find((message) => message.includes('Runtime.evaluate'))
    expect(reconnectWarning).toContain('已重连调试通道')
  })

  it('求值超时不会被 trace 记录成执行成功', async () => {
    cdpBehavior = (method) => (method === 'Runtime.evaluate' ? new Promise<unknown>(() => {}) : Promise.resolve({}))
    await captureError(controller.evaluate(SESSION_ID, '1 + 1'))

    const state = controller.getState(SESSION_ID)
    const scriptTraces = state?.trace.filter((item) => item.action === 'script') ?? []
    expect(scriptTraces).toHaveLength(1)
    expect(scriptTraces[0]?.success).toBe(false)
  })
})

describeController('#15 Agent 操作高亮', () => {
  it('高亮前先启用 DOM 域，再启用 Overlay', async () => {
    const observation = await controller.observe(SESSION_ID)
    const ref = observation.elements[0]?.ref ?? ''
    expect(ref).not.toBe('')

    await controller.click(SESSION_ID, ref)

    const methods = latestContents().debugger.calls.map((call) => call.method)
    const domEnable = methods.indexOf('DOM.enable')
    const overlayEnable = methods.indexOf('Overlay.enable')
    const highlight = methods.indexOf('Overlay.highlightNode')
    expect(domEnable).toBeGreaterThanOrEqual(0)
    expect(overlayEnable).toBeGreaterThan(domEnable)
    expect(highlight).toBeGreaterThan(overlayEnable)
    expect(highlightWarnings()).toHaveLength(0)
  })

  it('高亮不可用不影响操作结果，且同一失败只告警一次', async () => {
    cdpBehavior = async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: '提交' } }] }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.enable') throw new Error('DOM should be enabled first')
      return {}
    }
    const observation = await controller.observe(SESSION_ID)
    const ref = observation.elements[0]?.ref ?? ''

    const first = await controller.click(SESSION_ID, ref)
    expect(first.tabs).toHaveLength(1)
    expect(lastTrace().action).toBe('click')
    expect(lastTrace().success).toBe(true)

    const second = await controller.click(SESSION_ID, ref)
    expect(second.tabs).toHaveLength(1)

    // 62 条重复日志的根因：同一 DOM 域错误随每次动作重复打印。
    expect(highlightWarnings()).toHaveLength(1)
    expect(highlightWarnings()[0]).toContain('DOM should be enabled first')
  })

  it('高亮命令超时不会重连调试通道，因此不会打断正在进行的点击', async () => {
    // DOM.enable 永不返回：高亮命中 CDP 超时，但动作本身必须照常完成且 ref 仍然有效。
    cdpBehavior = async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: '提交' } }] }
      }
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.enable') return new Promise<unknown>(() => {})
      return {}
    }
    const observation = await controller.observe(SESSION_ID)
    const ref = observation.elements[0]?.ref ?? ''

    await controller.click(SESSION_ID, ref)

    expect(lastTrace().action).toBe('click')
    expect(lastTrace().success).toBe(true)
    expect(highlightWarnings()).toHaveLength(1)
    // 高亮超时不得触发调试通道重连：重连会作废当前 ref，让动作在下一步失败。
    expect(warnMessages.some((message) => message.includes('已重连调试通道'))).toBe(false)
  })
})
