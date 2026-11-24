import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertGenericSettingsUpdate, egoLiteSettingsChange, isEgoLitePlatformSupported, isEgoLiteSettingsPageUrl, normalizeEgoLiteSettings } from './ego-lite-settings-policy'

const builtin = { egoLiteEnabled: false, browserExecutionBackend: 'builtin', egoLiteProfileMode: 'current' } as const
const ego = { egoLiteEnabled: true, browserExecutionBackend: 'egoLite', egoLiteProfileMode: 'current' } as const

describe('Ego Lite 设置边界', () => {
  test('旧设置、非法开关和被禁用的旧选择回退到内置', () => {
    for (const input of [{}, { ...ego, egoLiteEnabled: 'true' }, { ...ego, egoLiteEnabled: false }]) {
      expect(normalizeEgoLiteSettings(input, true)).toEqual(builtin)
    }
    expect(normalizeEgoLiteSettings({ ...ego, browserExecutionBackend: 'other' }, true)).toEqual({ ...builtin, egoLiteEnabled: true })
  })

  test('准备成功后才能选择外部，关闭恢复内置，旧版已启用配置保持不变', () => {
    const enabled = normalizeEgoLiteSettings({ egoLiteEnabled: true }, true)
    expect(enabled).toEqual({ ...builtin, egoLiteEnabled: true })
    expect(normalizeEgoLiteSettings(ego, true)).toEqual(ego)
    expect(egoLiteSettingsChange('egoLite', enabled, 'idle')).toEqual({ browserExecutionBackend: 'egoLite' })
    expect(egoLiteSettingsChange('egoLite', enabled, 'ready')).toEqual({ browserExecutionBackend: 'egoLite' })
    expect(egoLiteSettingsChange('builtin', ego)).toEqual({ browserExecutionBackend: 'builtin' })
    expect(normalizeEgoLiteSettings({ ...ego, ...egoLiteSettingsChange(false, ego) }, true)).toEqual(builtin)
    expect(() => egoLiteSettingsChange('egoLite', builtin)).toThrow()
    expect(() => egoLiteSettingsChange(true, builtin)).toThrow()
    expect(() => egoLiteSettingsChange(ego, builtin)).toThrow()
  })

  test('准备期间即便保留旧授权也不能选 Ego Lite，但可回到内置', () => {
    for (const stage of ['detecting', 'downloading', 'installing', 'starting', 'configuring', 'cancelling'] as const) {
      expect(() => egoLiteSettingsChange('egoLite', ego, stage)).toThrow('请等待 Ego Lite 准备完成')
      expect(egoLiteSettingsChange('builtin', ego, stage)).toEqual({ browserExecutionBackend: 'builtin' })
    }
  })

  test('支持的正式版目标平台可启用 Ego Lite 设置', () => {
    for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']] as const) {
      expect(isEgoLitePlatformSupported(platform, arch)).toBe(true)
      expect(normalizeEgoLiteSettings(ego, isEgoLitePlatformSupported(platform, arch))).toEqual(ego)
    }
    expect(isEgoLitePlatformSupported('linux', 'x64')).toBe(false)
    expect(isEgoLitePlatformSupported('win32', 'arm64')).toBe(false)
    expect(isEgoLitePlatformSupported('darwin', 'arm')).toBe(false)
  })

  test('设置 IPC 只接受开发主窗口或精确的正式版 renderer 文件 URL', () => {
    const rendererPath = resolve('dist', 'renderer', 'index.html')
    const packagedUrl = pathToFileURL(rendererPath).href
    expect(isEgoLiteSettingsPageUrl('http://127.0.0.1:5173/#settings', false, rendererPath)).toBe(true)
    expect(isEgoLiteSettingsPageUrl('http://localhost:5173/', false, rendererPath)).toBe(false)
    expect(isEgoLiteSettingsPageUrl(`${packagedUrl}#settings`, true, rendererPath)).toBe(true)
    expect(isEgoLiteSettingsPageUrl(pathToFileURL(resolve('other.html')).href, true, rendererPath)).toBe(false)
    expect(isEgoLiteSettingsPageUrl('https://example.com/', true, rendererPath)).toBe(false)
  })


  test('通用更新拒绝敏感字段，包括混合请求，继续接受普通设置', () => {
    expect(() => assertGenericSettingsUpdate({ themeMode: 'dark' })).not.toThrow()
    expect(() => assertGenericSettingsUpdate({ themeMode: 'dark', egoLiteEnabled: true })).toThrow()
    expect(() => assertGenericSettingsUpdate({ browserExecutionBackend: 'egoLite' })).toThrow()
  })
})

test('默认复用当前配置，独立模式需显式选择且准备期间不可切换', () => {
  expect(normalizeEgoLiteSettings({}, true).egoLiteProfileMode).toBe('current')
  expect(normalizeEgoLiteSettings({ egoLiteProfileMode: 'workspace' }, true).egoLiteProfileMode).toBe('workspace')
  expect(normalizeEgoLiteSettings({ egoLiteProfileMode: 'invalid' }, true).egoLiteProfileMode).toBe('current')
  expect(egoLiteSettingsChange('current', builtin)).toEqual({ egoLiteProfileMode: 'current' })
  expect(egoLiteSettingsChange('workspace', builtin)).toEqual({ egoLiteProfileMode: 'workspace' })
  expect(() => egoLiteSettingsChange('workspace', builtin, 'downloading')).toThrow('请等待')
})
