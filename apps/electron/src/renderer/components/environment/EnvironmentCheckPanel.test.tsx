import { describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BunRuntimeStatus, RuntimeStatus } from '@proma/shared'
import { runtimeStatusAtom } from '@/atoms/environment'
import { describeBunStatus, EnvironmentCheckPanel } from './EnvironmentCheckPanel'

/** 构造完整 RuntimeStatus，仅 Bun 部分由用例指定 */
function makeRuntime(bun: BunRuntimeStatus): RuntimeStatus {
  return {
    node: { available: false, version: null, path: null, error: null },
    bun,
    git: { available: false, version: null, path: null, error: null },
    envLoaded: false,
    initializedAt: 0,
  }
}

/** 构造 Bun 状态，默认不可用且无错误（即未安装） */
function makeBun(overrides: Partial<BunRuntimeStatus> = {}): BunRuntimeStatus {
  return {
    available: false,
    path: null,
    version: null,
    source: null,
    error: null,
    ...overrides,
  }
}

/** 服务端渲染面板（不挂载 effect），用于断言卡片文案真实出现在 DOM 输出中 */
function renderPanel(runtime: RuntimeStatus | null): string {
  const store = createStore()
  if (runtime) {
    store.set(runtimeStatusAtom, runtime)
  }
  return renderToStaticMarkup(
    <Provider store={store}>
      <EnvironmentCheckPanel autoDetectOnMount={false} />
    </Provider>,
  )
}

describe('describeBunStatus', () => {
  test('运行时尚未加载时展示检测中', () => {
    expect(describeBunStatus(null)).toEqual({ status: 'checking', statusText: '正在检测...' })
  })

  test('Bun 可用时展示版本与来源（打包内置）', () => {
    const summary = describeBunStatus(
      makeRuntime(
        makeBun({
          available: true,
          path: '/app/vendor/bun',
          version: '1.2.3',
          source: 'bundled',
        }),
      ),
    )
    expect(summary).toEqual({
      status: 'success',
      statusText: 'Bun 1.2.3 已可用（来源：打包内置）',
    })
  })

  test('Bun 来自系统 PATH 且无版本号时只展示来源', () => {
    const summary = describeBunStatus(
      makeRuntime(makeBun({ available: true, path: '/usr/bin/bun', source: 'system' })),
    )
    expect(summary).toEqual({
      status: 'success',
      statusText: 'Bun 已可用（来源：系统 PATH）',
    })
  })

  test('Bun 可用但来源未知时不展示来源括号', () => {
    const summary = describeBunStatus(
      makeRuntime(makeBun({ available: true, path: '/opt/bun', version: '1.1.0' })),
    )
    expect(summary).toEqual({ status: 'success', statusText: 'Bun 1.1.0 已可用' })
  })

  test('候选存在但无法执行时展示主进程诊断原文', () => {
    const error = '发现 2 个 Bun 候选但都无法执行：system=C:\\bun.exe（退出码 -1（可能不是可执行文件））'
    const summary = describeBunStatus(makeRuntime(makeBun({ error })))
    expect(summary).toEqual({ status: 'warning', statusText: 'Bun 不可用', errorMessage: error })
  })

  test('完全未安装时按可选缺省提示，不展示错误细节', () => {
    const summary = describeBunStatus(makeRuntime(makeBun()))
    expect(summary.status).toBe('warning')
    expect(summary.statusText).toBe('未安装 Bun（可选，不影响核心功能）')
    expect(summary.errorMessage).toBeUndefined()
  })

  test('空白 error 视为未安装', () => {
    const summary = describeBunStatus(makeRuntime(makeBun({ error: '   ' })))
    expect(summary.statusText).toBe('未安装 Bun（可选，不影响核心功能）')
    expect(summary.errorMessage).toBeUndefined()
  })
})

describe('EnvironmentCheckPanel 的 Bun 卡片', () => {
  test('Bun 候选无法执行时把诊断原文渲染到卡片里', () => {
    const error = '发现 1 个 Bun 候选但都无法执行：system=C:\\bun.exe（退出码 1（可能不是可执行文件））'
    const html = renderPanel(makeRuntime(makeBun({ error })))

    expect(html).toContain('Bun 运行时')
    expect(html).toContain('Bun 不可用')
    expect(html).toContain('发现 1 个 Bun 候选但都无法执行')
    expect(html).toContain('C:\\bun.exe')
  })

  test('未安装 Bun 时渲染可选提示而不是错误原文', () => {
    const html = renderPanel(makeRuntime(makeBun()))

    expect(html).toContain('未安装 Bun（可选，不影响核心功能）')
    expect(html).not.toContain('Bun 不可用')
  })

  test('Bun 可用时渲染版本与来源', () => {
    const html = renderPanel(
      makeRuntime(makeBun({ available: true, version: '1.2.3', source: 'bundled' })),
    )

    expect(html).toContain('Bun 1.2.3 已可用（来源：打包内置）')
  })

  test('运行时未加载时 Bun 卡片展示正在检测', () => {
    const html = renderPanel(null)

    expect(html).toContain('Bun 运行时')
    expect(html).toContain('正在检测...')
  })
})
