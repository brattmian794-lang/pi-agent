export function isUpdaterTestBuildMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false
  const candidate = metadata as { proma?: { updaterTest?: boolean } }
  return candidate.proma?.updaterTest === true
}

/** 更新测试 feed 仅允许回环 HTTP 或显式独立 staging HTTPS。 */
export function resolveUpdaterTestFeedUrl(value: string | undefined): string {
  if (!value) throw new Error('测试实例缺少 PROMA_UPDATE_TEST_FEED_URL')
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol === 'http:' && loopback) return url.toString().replace(/\/$/, '')
  const host = url.hostname.toLowerCase()
  const isProductionGitHub = host === 'github.com' || host.endsWith('.github.com') || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
  if (url.protocol === 'https:' && !isProductionGitHub) return url.toString().replace(/\/$/, '')
  throw new Error('更新测试 feed 必须是回环 HTTP 或非 GitHub 的独立 staging HTTPS')
}

/** 只有控制器创建的本次目录可以清理，拒绝根目录、越界路径与符号链接。 */
export function isOwnedUpdaterTestDirectory(root: string, parent: string, markerExists: boolean, isSymlink: boolean): boolean {
  return markerExists && !isSymlink && root !== parent && root.length > parent.length && root.startsWith(`${parent}\\`) !== root.startsWith(`${parent}/`)
}
