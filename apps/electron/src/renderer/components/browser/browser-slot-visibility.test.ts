import { describe, expect, test } from 'bun:test'
import { shouldShowBrowserSlot } from './browser-slot-visibility'

describe('原生浏览器浮层布局', () => {
  test('各窗口与右侧面板尺寸有效时显示浏览器页面', () => {
    for (const [width, height] of [[320, 180], [640, 480], [1440, 900]] as const) {
      expect(shouldShowBrowserSlot(true, width, height, false)).toBe(true)
    }
  })

  test('AlertDialog 打开时隐藏原生页面，确保确认按钮处于可交互层', () => {
    expect(shouldShowBrowserSlot(true, 640, 480, true)).toBe(false)
    expect(shouldShowBrowserSlot(true, 320, 180, true)).toBe(false)
  })

  test('确认框关闭后恢复当前页面，且保留 tab 或无效布局的隐藏状态', () => {
    expect(shouldShowBrowserSlot(true, 640, 480, false)).toBe(true)
    expect(shouldShowBrowserSlot(false, 640, 480, false)).toBe(false)
    expect(shouldShowBrowserSlot(true, 4, 480, false)).toBe(false)
    expect(shouldShowBrowserSlot(true, 640, 4, false)).toBe(false)
  })
})
