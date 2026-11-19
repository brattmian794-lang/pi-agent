import { describe, expect, it } from 'bun:test'
import { createSidebarRefresh, getAgentSidebarActiveRowId } from './sidebar-session-refresh'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('sidebar session refresh', () => {
  it('retries a snapshot changed while a full-list request is pending', async () => {
    let snapshot = 'old'
    let loads = 0
    let committed = ''
    const first = deferred<string>()
    const refresh = createSidebarRefresh()
    const run = refresh.run(() => snapshot, () => {
      loads += 1
      return loads === 1 ? first.promise : Promise.resolve('fresh')
    }, (value) => { committed = value })

    snapshot = 'updated by event'
    first.resolve('stale')
    await run

    expect(loads).toBe(2)
    expect(committed).toBe('fresh')
  })

  it('ignores an older request when a newer refresh starts', async () => {
    const first = deferred<string>()
    let committed = ''
    const refresh = createSidebarRefresh()
    const oldRun = refresh.run(() => 'same', () => first.promise, (value) => { committed = value })
    await refresh.run(() => 'same', async () => 'new', (value) => { committed = value })
    first.resolve('old')
    await oldRun
    expect(committed).toBe('new')
  })

  it('targets a visible delegated row, then falls back to its parent row', () => {
    expect(getAgentSidebarActiveRowId(['agent-parent', 'agent-child-worker'], 'agent', 'parent', 'worker', undefined)).toBe('agent-child-worker')
    expect(getAgentSidebarActiveRowId(['agent-parent'], 'agent', 'parent', 'worker', undefined)).toBe('agent-parent')
  })
})
