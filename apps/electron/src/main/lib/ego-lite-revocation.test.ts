import { expect, mock, test } from 'bun:test'
import { lazyExternalBrowserRun } from './agent-external-browser'
import { revokeEgoLiteRuns } from './ego-lite-revocation'

test('关闭同步停止已加载的外部运行，立即重开也不能恢复旧句柄或完成延迟创建', async () => {
  let enabled = true
  const stop = mock(() => {})
  const create = mock(() => ({ execute: async () => 'ok', stop }))
  const run = () => lazyExternalBrowserRun(async () => create, () => enabled)
  const live = run()
  const idle = run()
  const loading = run()
  const action = { kind: 'observe' } as const
  await live.execute(action)
  const pending = loading.execute(action)
  enabled = false
  revokeEgoLiteRuns()
  expect(stop).toHaveBeenCalledTimes(1)
  enabled = true
  await expect(pending).rejects.toThrow()
  for (const old of [idle, live, loading]) await expect(old.execute(action)).rejects.toThrow()
  expect(create).toHaveBeenCalledTimes(1)
  const next = run()
  expect(await next.execute(action)).toBe('ok')
  for (const old of [idle, live, loading]) old.stop()
  expect(stop).toHaveBeenCalledTimes(1)
  next.stop()
  expect(stop).toHaveBeenCalledTimes(2)
})
