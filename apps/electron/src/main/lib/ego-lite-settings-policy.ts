import { pathToFileURL } from 'node:url'
import { isEgoSetupActive } from '@proma/shared'
import type { EgoLiteSettings, EgoSetupState } from '@proma/shared'


export function isEgoLitePlatformSupported(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === 'win32' && arch === 'x64') ||
    (platform === 'darwin' && (arch === 'arm64' || arch === 'x64'))
}

export function isEgoLiteSettingsPageUrl(url: string, packaged: boolean, rendererPath: string): boolean {
  const pageUrl = url.split('#', 1)[0]
  const expectedUrl = packaged ? pathToFileURL(rendererPath).href : 'http://127.0.0.1:5173/'
  return pageUrl === expectedUrl
}

export function normalizeEgoLiteSettings(input: { egoLiteEnabled?: unknown; browserExecutionBackend?: unknown; egoLiteProfileMode?: unknown }, eligible: boolean): EgoLiteSettings {
  const egoLiteEnabled = eligible && input.egoLiteEnabled === true
  return {
    egoLiteEnabled,
    browserExecutionBackend: egoLiteEnabled && input.browserExecutionBackend === 'egoLite' ? 'egoLite' : 'builtin',
    egoLiteProfileMode: input.egoLiteProfileMode === 'workspace' ? 'workspace' : 'current',
  }
}

export function assertGenericSettingsUpdate(input: object): void {
  if ('egoLiteEnabled' in input || 'browserExecutionBackend' in input || 'egoLiteProfileMode' in input) {
    throw new Error('请在通用设置中更改 Ego Lite 选项')
  }
}

export function egoLiteSettingsChange(input: unknown, current: EgoLiteSettings, stage: EgoSetupState['stage'] = 'idle'): Partial<EgoLiteSettings> {
  if (input === true) throw new Error('请先完成 Ego Lite 准备')
  if (input === false) return { egoLiteEnabled: false }
  if (input === true) throw new Error('请先完成 Ego Lite 准备')
  if (input === 'current' || input === 'workspace') {
    if (isEgoSetupActive(stage)) throw new Error('请等待 Ego Lite 准备完成')
    return { egoLiteProfileMode: input }
  }
  if (input === 'builtin') return { browserExecutionBackend: input }
  if (input === 'egoLite') {
    if (isEgoSetupActive(stage)) throw new Error('请等待 Ego Lite 准备完成')
    if (current.egoLiteEnabled) return { browserExecutionBackend: input }
  }
  throw new Error('后端不可用，请先启用 Ego Lite')
}
