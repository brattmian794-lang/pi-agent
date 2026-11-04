import { expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundCommandService } from '../background-command-service'
import { BackgroundCommandStore } from '../background-command-store'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配端口')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}
async function reachable(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.status === 200, () => false)
}
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)) }
  throw new Error('等待服务状态超时')
}

it.skipIf(process.platform !== 'win32' || !process.env.PROMA_TEST_GIT_BASH)(
  'Given 两个真实 Git Bash HTTP 服务 When 跨回合查询与隔离停止 Then 目标端口退出、另一会话继续运行并保留日志终态', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proma-managed-services-'))
    const runtimeEnv = { env: {}, shellKind: 'git-bash' as const, shellPath: process.env.PROMA_TEST_GIT_BASH! }
    const service = new BackgroundCommandService({ store: new BackgroundCommandStore(join(directory, 'records')) })
    const firstPort = await freePort()
    const secondPort = await freePort()
    try {
      const first = await service.start('a', { cwd: directory, command: `python -u -m http.server ${firstPort} --bind 127.0.0.1` }, runtimeEnv)
      const second = await service.start('b', { cwd: directory, command: `nohup python -u -m http.server ${secondPort} --bind 127.0.0.1 >server.log 2>&1 & NEW_PID=$!; echo "$NEW_PID" >server.pid; sleep 1; curl -fsS http://127.0.0.1:${secondPort}/ >/dev/null` }, runtimeEnv)
      expect(first.status).toBe('running')
      expect(second.status).toBe('running')
      await waitFor(() => reachable(firstPort))
      await waitFor(() => reachable(secondPort))
      // 回合所有者已经释放后，服务仍独立存在（跨回合释放由 utility 测试覆盖）。
      expect(service.list('a')).toHaveLength(1)
      expect(service.details('b', first.id)).toBeNull()
      expect((await service.stop('b', first.id)).accepted).toBe(false)
      expect(await reachable(firstPort)).toBe(true)
      const result = await service.stop('a', first.id)
      expect(result).toMatchObject({ accepted: true, command: { status: 'stopped' } })
      expect(await reachable(firstPort)).toBe(false)
      expect(await reachable(secondPort)).toBe(true)
      expect(service.details('a', first.id)?.output).toContain('Serving HTTP')
      expect(service.list('a')[0]!.status).toBe('stopped')
      await service.shutdown()
      expect(await reachable(secondPort)).toBe(false)
      expect(service.list('b')[0]!.status).toBe('stopped')
      const restored = new BackgroundCommandService({ store: new BackgroundCommandStore(join(directory, 'records')) })
      expect(restored.list('a')[0]!.status).toBe('stopped')
      await restored.shutdown()
    } finally { await service.shutdown(); await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }, 30_000,
)

it.skipIf(process.platform !== 'win32' || !process.env.PROMA_TEST_GIT_BASH)(
  'Given Shell 命令自然失败 When 进程退出 Then 保留非零退出码与输出而非误报运行', async () => {
    const service = new BackgroundCommandService()
    try {
      const command = await service.start('a', { cwd: process.cwd(), command: 'echo expected-failure >&2; exit 7' }, { env: {}, shellKind: 'git-bash', shellPath: process.env.PROMA_TEST_GIT_BASH! })
      await waitFor(async () => service.list('a')[0]!.status === 'failed')
      expect(service.details('a', command.id)?.command.exitCode).toBe(7)
      expect(service.details('a', command.id)?.output).toContain('expected-failure')
    } finally { await service.shutdown() }
  }, 15_000,
)
