import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 打包产物直接决定的运行时行为（#21 差分文件、#32 图标资源）无法在单测里跑完整打包，
// 这里守住 electron-builder.yml 的配置约定，避免后续改动悄悄退回旧行为。
const appDir = join(import.meta.dir, '../../../..')

interface ExtraResourceEntry {
  from?: string
  to?: string
  filter?: string[]
}

interface BuilderConfig {
  files?: string[]
  extraResources?: ExtraResourceEntry[]
  mac?: { icon?: string; extraResources?: ExtraResourceEntry[] }
  win?: { icon?: string }
  linux?: { icon?: string }
  nsis?: { differentialPackage?: boolean }
}

const config = Bun.YAML.parse(readFileSync(join(appDir, 'electron-builder.yml'), 'utf-8')) as BuilderConfig

/** 判断 extraResources 是否把某个源文件发布到 resourcesPath 根目录下的同名文件。 */
function publishesToResourceRoot(source: string): boolean {
  return (config.extraResources ?? []).some((entry) => entry.from === source && entry.to === source.split('/').pop())
}

describe('打包配置与更新器策略一致', () => {
  test('Given 发布产物不含 Windows 差分文件 When 打包 Then 关闭 NSIS 差分并让更新器只走全量下载', () => {
    // 与 auto-updater.ts 的 disableDifferentialDownload 配合：没有 .exe.blockmap 就不该请求它。
    expect(config.nsis?.differentialPackage).toBe(false)
    expect(config.win?.icon).toBe('resources/icon.ico')
  })

  test('Given files 段排除 dist/resources When 打包 Then 通过 extraResources 发布窗口图标', () => {
    const files = config.files ?? []
    // dist/resources 整体排除，只保留 Linux 运行时需要的 icon.png。
    expect(files).toContain('!dist/resources/**')
    expect(files).toContain('dist/resources/icon.png')

    // 打包后的 Windows 窗口图标必须落在 process.resourcesPath 根目录，否则 getIconPath 找不到。
    expect(publishesToResourceRoot('resources/icon.ico')).toBe(true)
    expect(publishesToResourceRoot('resources/icon.png')).toBe(true)
    // macOS 的 icon.icns 由 mac.icon 生成到 .app/Contents/Resources，再声明一次会让打包报 EEXIST。
    expect(publishesToResourceRoot('resources/icon.icns')).toBe(false)

    for (const source of ['resources/icon.ico', 'resources/icon.icns', 'resources/icon.png']) {
      expect(existsSync(join(appDir, source))).toBe(true)
    }
  })

  test('Given macOS 有独立 extraResources When 打包 Then 平台段与通用段合并而不是互相覆盖', () => {
    // electron-builder 的 getFileMatchers 会同时添加 config.extraResources 与平台段，
    // 因此 macOS 的 agent-island 等资源不会挤掉通用图标资源。
    expect(config.mac?.icon).toBe('resources/icon.icns')
    expect((config.mac?.extraResources ?? []).length).toBeGreaterThan(0)
    expect(config.linux?.icon).toBe('resources/icon.png')
  })
})
