/**
 * 受管浏览器工具的 Agent 侧可核验性（#11 / #13 / #14 的调用方视角）。
 *
 * CDP 命令超时表示「命令已发出、结果未知」，工具必须把它作为结构化结果交回模型，
 * 而不是让模型只看到一段异常文本；真实的失败（页面已关闭等）仍要照旧抛出。
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { BrowserCdpTimeoutError } from '../browser-cdp'

// electron 只为让桥接模块的传递依赖可加载；本测试不触达真实浏览器与主进程。
mock.module('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0', getAppPath: () => '/tmp', isPackaged: false, whenReady: async () => undefined, on: () => undefined },
  BrowserWindow: class {},
  WebContentsView: class {},
  MessageChannelMain: class {},
  Notification: class {},
  session: { fromPartition: () => ({}) },
  net: { fetch: async () => ({}) },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  clipboard: { readText: () => '', writeText: () => undefined },
  screen: { getPrimaryDisplay: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }) },
  dialog: {},
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
  powerMonitor: { on: () => undefined },
  globalShortcut: { register: () => true, unregisterAll: () => undefined },
  utilityProcess: { fork: () => ({}) },
}))

const TIMEOUT_METHOD = 'Accessibility.getFullAXTree'
const TIMEOUT_MS = 5_000

type StubMode = 'success' | 'timeout' | 'failure'

let stubMode: StubMode = 'success'
let stubPayload: unknown = {}
const invokedMethods: string[] = []

function stubCall(method: string): Promise<unknown> {
  invokedMethods.push(method)
  if (stubMode === 'timeout') return Promise.reject(new BrowserCdpTimeoutError(TIMEOUT_METHOD, TIMEOUT_MS))
  if (stubMode === 'failure') return Promise.reject(new Error('页面已关闭，请重新打开标签。'))
  return Promise.resolve(stubPayload)
}

const browserControllerStub = {
  configureSession: () => undefined,
  observe: () => stubCall('observe'),
  navigate: () => stubCall('navigate'),
  waitFor: () => stubCall('waitFor'),
  find: () => stubCall('find'),
  click: () => stubCall('click'),
  act: () => stubCall('act'),
  fill: () => stubCall('fill'),
  domAction: () => stubCall('domAction'),
  evaluate: () => stubCall('evaluate'),
  press: () => stubCall('press'),
  hover: () => stubCall('hover'),
  drag: () => stubCall('drag'),
  scroll: () => stubCall('scroll'),
  extract: () => stubCall('extract'),
  selectOption: () => stubCall('selectOption'),
  upload: () => stubCall('upload'),
  screenshot: () => stubCall('screenshot'),
  previewOpen: () => stubCall('previewOpen'),
  listTabs: () => stubCall('listTabs'),
  createNewTab: () => stubCall('createNewTab'),
  selectAgentTab: () => stubCall('selectAgentTab'),
  closeTab: () => stubCall('closeTab'),
  close: () => stubCall('close'),
}

mock.module('../browser-controller', () => ({ browserController: browserControllerStub }))

const { buildBrowserTools } = await import('./pi-builtin-tools')

type BuildArgs = Parameters<typeof buildBrowserTools>

const sdkStub = {
  defineTool: (definition: unknown): unknown => definition,
} as unknown as BuildArgs[0]

const ctxStub = {
  sessionId: 'session-browser-timeout',
  channelId: 'channel-browser-timeout',
  allowedRoots: [],
  agentCwd: '/tmp',
} as unknown as BuildArgs[1]

/**
 * 测试只关心「工具名 + execute」，Pi ToolDefinition 的其余参数由桥接层填充。
 */
interface ExecutableBrowserTool {
  name: string
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>
}

const tools = buildBrowserTools(sdkStub, ctxStub)

function findTool(name: string): ExecutableBrowserTool {
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`未找到工具 ${name}`)
  return found as unknown as ExecutableBrowserTool
}

function textOf(result: AgentToolResult<unknown>): string {
  const block = result.content[0]
  return block && block.type === 'text' ? block.text : ''
}

function detailsOf(result: AgentToolResult<unknown>): Record<string, unknown> {
  return result.details as Record<string, unknown>
}

beforeEach(() => {
  stubMode = 'success'
  stubPayload = {}
  invokedMethods.length = 0
})

afterAll(() => {
  mock.restore()
})

describe('受管浏览器工具的 CDP 超时语义', () => {
  it('超时返回 status=unknown 的结构化结果且不抛错', async () => {
    stubMode = 'timeout'

    const result = await findTool('BrowserObserve').execute('call-1', {}, undefined)
    const details = detailsOf(result)

    expect(details.ok).toBe(false)
    expect(details.status).toBe('unknown')
    expect(details.method).toBe(TIMEOUT_METHOD)
    expect(details.timeoutMs).toBe(TIMEOUT_MS)
    expect(details.retryable).toBe(true)
    expect(typeof details.message).toBe('string')
    expect(details.message as string).toContain('结果未知')
    // 文本内容与 details 一致，模型读文本、宿主读 details，二者不会分叉。
    expect(JSON.parse(textOf(result))).toEqual(details)
  })

  it('动作类工具同样降级为结构化结果', async () => {
    stubMode = 'timeout'

    for (const name of ['BrowserNavigate', 'BrowserClick', 'BrowserFill', 'BrowserExecuteJavaScript']) {
      const tool = findTool(name)
      const result = await tool.execute('call-2', {}, undefined)
      const details = detailsOf(result)
      expect(details.status).toBe('unknown')
      expect(details.retryable).toBe(true)
    }
  })

  it('非超时的真实失败仍然抛出，不被吞成结构化结果', async () => {
    stubMode = 'failure'

    const tool = findTool('BrowserObserve')
    await expect(tool.execute('call-3', {}, undefined)).rejects.toThrow('页面已关闭，请重新打开标签。')
  })

  it('成功路径的返回结构不变', async () => {
    stubPayload = { url: 'https://example.com', title: '示例站点', elements: [] }

    const result = await findTool('BrowserObserve').execute('call-4', {}, undefined)

    expect(result.details).toEqual({ url: 'https://example.com', title: '示例站点', elements: [] })
    expect(JSON.parse(textOf(result))).toEqual({ url: 'https://example.com', title: '示例站点', elements: [] })
    expect(detailsOf(result).status).toBeUndefined()
    expect(invokedMethods).toEqual(['observe'])
  })

  it('超时结果携带触发超时的 CDP 方法，便于模型判断哪一步没拿到结果', async () => {
    stubMode = 'timeout'

    const result = await findTool('BrowserExecuteJavaScript').execute('call-5', { script: '1 + 1' }, undefined)
    const details = detailsOf(result)

    expect(invokedMethods).toEqual(['evaluate'])
    expect(details.method).toBe(TIMEOUT_METHOD)
    expect(details.message as string).toContain(TIMEOUT_METHOD)
  })
})
