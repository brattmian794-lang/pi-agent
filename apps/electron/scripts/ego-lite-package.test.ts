import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const resources = new URL('../resources/optional-integrations/ego-lite/', import.meta.url)

describe('随应用提供的可选 Ego Lite 官方 Pi 资源', () => {
  test('离线归档与固定的 npm SHA-512 一致且包含可查看的授权声明', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', resources), 'utf8'))
    const archive = readFileSync(new URL('pi-plugin-1.0.0.tgz', resources))
    expect(manifest.name).toBe('@ego-lite/pi-plugin')
    expect(manifest.version).toBe('1.0.0')
    expect(`sha512-${createHash('sha512').update(archive).digest('base64')}`).toBe(manifest.integrity)
    expect(readFileSync(new URL('LICENSE', resources), 'utf8')).toContain('Permission is hereby granted')
  })

  test('安装包单独复制可选资源，默认 Skill 目录不含该插件', () => {
    const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    expect(config).toContain('from: resources/optional-integrations/ego-lite')
    expect(config).toContain('to: optional-integrations/ego-lite')
    expect(existsSync(new URL('../default-skills/ego-browser', import.meta.url))).toBe(false)
  })
})
