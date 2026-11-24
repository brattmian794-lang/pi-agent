import { describe, expect, it, mock } from 'bun:test'
import { createEgoLiteInstaller } from './ego-lite-installer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
function fixture() {
  return createEgoLiteInstaller({
    platform: 'linux', arch: 'x64', home: '/tmp/ego-test-home', temp: '/tmp', env: {},
    fetch: mock(async () => { throw new Error('不得发起下载') }) as unknown as typeof fetch,
    run: mock(async () => ''),
    launch: mock(async () => {}),
  })
}
describe('自动安装的安全边界', () => {
  it('不支持的平台在读取外部资源或下载前明确失败', async () => {
    const controller = new AbortController()
    await expect(fixture().ensure(controller.signal, () => {})).rejects.toThrow('仅支持')
  })
  it('取消不会启动外部准备步骤，可以再次尝试', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fixture().ensure(controller.signal, () => {})).rejects.toThrow('已取消')
  })
})

describe('Windows 官方安装流程', () => {
  it('进程 PATH 未更新时仍能定位官方活动目录中的原生 CLI', async () => {
    const home = await mkdtemp(join(tmpdir(), 'proma-ego-discovery-test-'))
    try {
      const active = join(home, '.local', 'share', 'ego', 'active_version_dir')
      await mkdir(active, { recursive: true })
      const exe = join(active, 'ego-browser.exe')
      await writeFile(exe, '')
      const env = { PATH: '' }
      const run = mock(async () => { throw new Error('无需查询注册表') })
      const installer = createEgoLiteInstaller({ platform: 'win32', arch: 'x64', home, temp: home,
        env, fetch: globalThis.fetch, run, launch: async () => {} })
      expect(await installer.discoverCli()).toBe(exe)
      expect(env.PATH).toBe('')
      expect(run).not.toHaveBeenCalled()
    } finally { await rm(home, { recursive: true, force: true }) }
  })
  it('下载并校验后直接启动安装器', async () => {
    const home = await mkdtemp(join(tmpdir(), 'proma-ego-install-test-'))
    const bytes = new TextEncoder().encode('verified installer')
    const release = { url: 'https://cdn.ego.app/setup/windows/x64/egoliteSetup.exe', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }
    const controller = new AbortController()
    const launch = mock(async (file: string, args: string[]) => {
      expect(file).toContain('egoliteSetup.exe')
      expect(file).not.toContain('explorer.exe')
      expect(args).toEqual([])
      controller.abort()
    })
    try {
      const installer = createEgoLiteInstaller({
        platform: 'win32', arch: 'x64', home, temp: home,
        env: { LOCALAPPDATA: home, SystemRoot: 'C:\\Windows' },
        releases: { 'mac-arm64': release, 'mac-x64': release, 'win-x64': release },
        fetch: mock(async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
        run: mock(async (file: string) => {
          if (file.endsWith('powershell.exe')) return 'CN=CITRO LABS PTE. LIMITED, O=CITRO LABS PTE. LIMITED'
          const error = new Error('not found') as NodeJS.ErrnoException
          error.code = '1'
          throw error
        }),
        launch, onboardingMs: 10, pollMs: 1,
      })
      await expect(installer.ensure(controller.signal, () => {})).rejects.toThrow('已取消')
      expect(launch).toHaveBeenCalledTimes(1)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
