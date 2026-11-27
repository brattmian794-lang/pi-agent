import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UpdateStatus } from '@/atoms/updater'

// AboutSettings 在模块顶层读取构建期注入的 __APP_VERSION__，
// 测试环境没有 Vite define，因此先注入占位值再动态导入。
;(globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test'

const { formatUpdateErrorLabel, StatusText } = await import('./AboutSettings')

/** 构造一个 error 状态，retryable 传 undefined 表示旧版主进程未携带该字段 */
function makeErrorStatus(retryable?: boolean): UpdateStatus {
  const status: UpdateStatus = { status: 'error', error: 'net::ERR_TIMED_OUT' }
  if (retryable !== undefined) {
    status.retryable = retryable
  }
  return status
}

/** 渲染状态文字，返回静态 HTML */
function renderStatus(status: UpdateStatus): string {
  return renderToStaticMarkup(createElement(StatusText, { update: status }))
}

describe('formatUpdateErrorLabel', () => {
  test('retryable=true 时提示用户可再检查一次', () => {
    expect(formatUpdateErrorLabel(makeErrorStatus(true))).toBe('检查失败（可重试）')
  })

  test('retryable=false 时保持原有失败文案', () => {
    expect(formatUpdateErrorLabel(makeErrorStatus(false))).toBe('检查失败')
  })

  test('缺少 retryable 字段时按不可重试处理，兼容旧版 payload', () => {
    expect(formatUpdateErrorLabel(makeErrorStatus())).toBe('检查失败')
  })
})

describe('StatusText 的错误分支', () => {
  test('可重试失败在 UI 上显示「检查失败（可重试）」并保留错误原文', () => {
    const html = renderStatus(makeErrorStatus(true))

    expect(html).toContain('检查失败（可重试）')
    expect(html).toContain('title="net::ERR_TIMED_OUT"')
    expect(html).toContain('text-destructive')
  })

  test('不可重试失败仍显示原有「检查失败」', () => {
    const html = renderStatus(makeErrorStatus(false))

    expect(html).toContain('检查失败')
    expect(html).not.toContain('可重试')
  })

  test('旧版 payload 缺少 retryable 时不显示可重试文案', () => {
    const html = renderStatus(makeErrorStatus())

    expect(html).not.toContain('可重试')
  })
})
