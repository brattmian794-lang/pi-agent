import { describe, expect, it, mock } from 'bun:test'
import { externalNavigationUrl, lazyExternalBrowserRun, resolveBrowserRoute, selectExternalBrowser } from './agent-external-browser'
import { getToolPhrase } from '../../renderer/components/agent/tool-phrase'
import { buildExternalBrowserTools } from './adapters/pi-external-browser-tools'
import type { ExternalBrowserAction } from './agent-external-browser'

const observe = { kind: 'observe' } as const

describe('选定 Ego Lite 的一次运行', () => {
  it('开发版与正式版均允许受支持平台架构的显式前台选择', () => {
    const selected = { egoLiteEnabled: true, browserExecutionBackend: 'egoLite' }
    expect(selectExternalBrowser(selected, 'darwin', 'arm64', true)).toBe(true)
    expect(selectExternalBrowser(selected, 'win32', 'x64', true)).toBe(true)
    expect(selectExternalBrowser(selected, 'linux', 'x64', true)).toBe(false)
    expect(selectExternalBrowser(selected, 'win32', 'arm64', true)).toBe(false)
    expect(selectExternalBrowser(selected, 'darwin', 'arm64', false)).toBe(false)
    for (const settings of [{}, { ...selected, egoLiteEnabled: false }, { ...selected, browserExecutionBackend: 'builtin' }]) {
      expect(selectExternalBrowser(settings, 'darwin', 'arm64', true)).toBe(false)
    }
    expect(resolveBrowserRoute(selected, 'win32', 'x64', true, true, 'ready').backend).toBe('egoLite')
    expect(resolveBrowserRoute(selected, 'win32', 'arm64', true, true, 'ready').label).toContain('架构不支持')
  })

  it('复检中的新运行暂用内置，复检完成后仍按同一偏好使用 Ego Lite', () => {
    const preference = Object.freeze({ egoLiteEnabled: true, browserExecutionBackend: 'egoLite' })
    const resolve = (stage: 'configuring' | 'ready' | 'failed' | 'cancelled') =>
      resolveBrowserRoute(preference, 'win32', 'x64', true, true, stage)
    expect(resolve('configuring')).toMatchObject({ backend: 'builtin', label: expect.stringContaining('复检') })
    expect(resolve('failed')).toMatchObject({ backend: 'builtin', label: expect.stringContaining('未就绪') })
    expect(resolve('cancelled').backend).toBe('builtin')
    expect(resolve('ready')).toMatchObject({ backend: 'egoLite', label: expect.stringContaining('外部窗口') })
  })

  it('后台或无工作区的运行明确标出内置后端及原因', () => {
    const preference = { egoLiteEnabled: true, browserExecutionBackend: 'egoLite' }
    expect(resolveBrowserRoute(preference, 'win32', 'x64', false, true, 'ready')).toMatchObject({ backend: 'builtin', label: expect.stringContaining('前台运行') })
    expect(resolveBrowserRoute(preference, 'win32', 'x64', true, false, 'ready')).toMatchObject({ backend: 'builtin', label: expect.stringContaining('没有工作区') })
    expect(resolveBrowserRoute({}, 'win32', 'x64', true, true, 'ready').backend).toBe('builtin')
  })

  it('给定非浏览器任务，不加载 runtime；首次动作才创建句柄，结束后仅释放一次', async () => {
    const stop = mock(() => {})
    const execute = mock(async () => 'snapshot')
    const load = mock(async () => () => ({ execute, stop }))
    const run = lazyExternalBrowserRun(load, () => true)
    expect(load).not.toHaveBeenCalled()
    expect(await run.execute(observe)).toBe('snapshot')
    expect(await run.execute(observe)).toBe('snapshot')
    run.stop()
    run.stop()
    await expect(run.execute(observe)).rejects.toThrow('本轮')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each(['stop', 'disable', 'cancel'])('模块加载期间发生 %s，不得创建窗口或派发动作', async cause => {
    let enabled = true
    const abort = new AbortController()
    const create = mock(() => ({ execute: async () => '', stop() {} }))
    const run = lazyExternalBrowserRun(async () => create, () => enabled)
    const pending = run.execute(observe, abort.signal)
    if (cause === 'stop') run.stop()
    if (cause === 'disable') enabled = false
    if (cause === 'cancel') abort.abort()
    await expect(pending).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
  })

  it('动作失败只派发一次，返回手动切换说明', async () => {
    const execute = mock(async () => { throw new Error('lost connection') })
    const run = lazyExternalBrowserRun(async () => () => ({ execute, stop() {} }), () => true)
    await expect(run.execute({ kind: 'click', ref: '1' })).rejects.toThrow('通用设置')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('外部截图作为 PNG 图像返回，历史轨迹始终体现实际窗口', async () => {
    const calls: ExternalBrowserAction[] = []
    const sdk = { defineTool: (tool: unknown) => tool } as typeof import('@earendil-works/pi-coding-agent')
    const tools = buildExternalBrowserTools(sdk, { execute: async action => { calls.push(action); return 'cG5n' }, stop() {} })
    for (const tool of tools) {
      expect(tool.label).toContain('外部')
      expect(getToolPhrase(tool.name, { _intent: '查看' }).label).toContain('外部')
    }
    const screenshot = tools.find(tool => tool.name === 'BrowserEgoScreenshot')!
    const result = await screenshot.execute('id', {}, undefined, undefined, {} as never)
    expect(result.content).toEqual([{ type: 'image', mimeType: 'image/png', data: 'cG5n' }])
    expect(calls).toEqual([{ kind: 'screenshot' }])
  })

  it('外部导航只接受显式且不含凭据的 HTTP(S) 地址', () => {
    expect(externalNavigationUrl('https://example.org')).toBe('https://example.org/')
    for (const url of ['file:///C:/a.html', 'javascript:alert(1)', 'about:blank', 'search words', 'https://a:b@example.org']) {
      expect(() => externalNavigationUrl(url)).toThrow()
    }
  })
})
