export const externalBrowserLabels = {
  BrowserEgoNavigate: '在外部窗口打开网页',
  BrowserEgoObserve: '观察外部窗口',
  BrowserEgoClick: '点击外部网页元素',
  BrowserEgoFill: '填写外部网页字段',
  BrowserEgoWait: '等待外部网页文本',
  BrowserEgoScreenshot: '截取外部窗口',
  BrowserEgoHandoff: '将外部窗口交给用户',
} as const

export function externalBrowserLabel(name: string): string | undefined {
  return Object.hasOwn(externalBrowserLabels, name) ? externalBrowserLabels[name as keyof typeof externalBrowserLabels] : undefined
}
