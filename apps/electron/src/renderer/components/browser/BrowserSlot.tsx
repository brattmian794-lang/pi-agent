import * as React from 'react'
import { nextBrowserLayoutRevision } from './browser-layout-revision'
import { shouldShowBrowserSlot } from './browser-slot-visibility'

// 每次 publish（包括卸载隐藏）分配全局单调 revision。旧 slot 的 IPC 即使晚到，
// 主进程也不会覆盖随后已挂载 tab 的可见性和边界。
// WebContentsView 是原生子视图，天然盖在 renderer DOM 之上；CSS z-index 无法反转。
// 会话删除确认框在挂载期间暂时隐藏它；其他浮层仍不影响浏览器。

export function BrowserSlot({ sessionId, tabId }: { sessionId: string; tabId: string }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const element = ref.current
    const setLayout = (window.electronAPI as Partial<typeof window.electronAPI>).setAgentBrowserLayout
    if (!element || typeof setLayout !== 'function') return
    let frame = 0
    const selector = '[data-hide-native-browser]'
    let alertDialogOpen = document.body.querySelector(`:scope > ${selector}`) !== null
    const commitLayout = (visible: boolean, preserveSessionOnHide: boolean) => {
      const rect = element.getBoundingClientRect()
      void setLayout({
        sessionId,
        tabId,
        revision: nextBrowserLayoutRevision(),
        visible: shouldShowBrowserSlot(visible, rect.width, rect.height, alertDialogOpen),
        preserveSessionOnHide,
        bounds: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
        },
      })
    }
    const publish = (visible: boolean, preserveSessionOnHide = false, immediate = false) => {
      if (frame) cancelAnimationFrame(frame)
      if (immediate) {
        frame = 0
        commitLayout(visible, preserveSessionOnHide)
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        commitLayout(visible, preserveSessionOnHide)
      })
    }
    const publishCurrentVisibility = (immediate = false) => publish(true, alertDialogOpen, immediate)
    const resizeObserver = new ResizeObserver(() => publishCurrentVisibility())
    const dialogObserver = new MutationObserver(() => {
      const isOpen = document.body.querySelector(`:scope > ${selector}`) !== null
      if (isOpen === alertDialogOpen) return
      alertDialogOpen = isOpen
      publishCurrentVisibility(true)
    })
    const publishBounded = () => publishCurrentVisibility()
    resizeObserver.observe(element)
    dialogObserver.observe(document.body, { childList: true })
    window.addEventListener('resize', publishBounded)
    // Tab 切换时先前 Slot 会立即发出 hide。新 Slot 不能再等一帧才 show，
    // 否则快速左右切换时原生视图会停留在隐藏状态，表现为页面内容消失。
    publishCurrentVisibility(true)
    return () => {
      resizeObserver.disconnect()
      dialogObserver.disconnect()
      window.removeEventListener('resize', publishBounded)
      if (frame) cancelAnimationFrame(frame)
      void setLayout({ sessionId, tabId, revision: nextBrowserLayoutRevision(), visible: false, preserveSessionOnHide: false, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    }
  }, [sessionId, tabId])

  return <div ref={ref} className="flex-1 min-h-0 bg-muted/15 titlebar-no-drag" aria-label="受管浏览器页面" />
}
