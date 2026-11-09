import { build, Platform } from 'electron-builder'
import type { Configuration } from 'electron-builder'
import { mkdirSync, readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { join, resolve } from 'node:path'
import { findFile } from './controller'
import { sha256File } from './local-feed'
import { writeJsonFileAtomic } from '../../src/main/lib/safe-file'

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

/** 专用测试版本：独立 appId/产品名，只输出本地工件，永远不发布。 */
const version = argument('version', '0.19.0-test.1')
const role = argument('role', 'old')
const output = resolve(argument('output', join('out', 'updater-test-fixtures', role)))
mkdirSync(output, { recursive: true })
const current = process.platform === 'win32' ? Platform.WINDOWS : process.platform === 'darwin' ? Platform.MAC : Platform.LINUX
const target = process.platform === 'win32' ? 'nsis' : process.platform === 'darwin' ? 'zip' : 'AppImage'
const baseConfig = load(readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')) as Configuration
await build({
  targets: current.createTarget([target]),
  publish: 'never',
  config: {
    ...baseConfig,
    extends: null,
    appId: 'com.proma.updater.test',
    productName: 'PromaUpdaterTest',
    extraMetadata: { version, proma: { updaterTest: true } },
    directories: { output },
    publish: { provider: 'generic', url: 'http://127.0.0.1:9', channel: 'latest' },
    win: { target: ['nsis'], ...(process.env.PROMA_STAGING_SIGN === '1' ? {} : { signAndEditExecutable: false }) },
    nsis: { oneClick: true, perMachine: false, allowElevation: false, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: true },
    mac: { target: ['zip'] },
    linux: { target: ['AppImage'], executableName: 'PromaUpdaterTest' },
    forceCodeSigning: process.env.PROMA_STAGING_SIGN === '1',
  },
})
const extension = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.zip' : '.AppImage'
const artifact = findFile(output, extension)
const manifest = { schemaVersion: 1, role, version, platform: process.platform, arch: process.arch, artifact, sha256: sha256File(artifact), feedDirectory: output }
writeJsonFileAtomic(join(output, 'fixture.json'), manifest)
console.log(`[更新测试工件] ${JSON.stringify(manifest)}`)
