import { describe, expect, it } from 'bun:test'
import { copyForkEntryWithRetry } from './agent-fork-workspace-copy'

function missingEntryError(): NodeJS.ErrnoException {
  const error = new Error('source disappeared') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

describe('copyForkEntryWithRetry', () => {
  it('retries transient ENOENT and succeeds', async () => {
    let attempts = 0
    await copyForkEntryWithRetry(async () => {
      attempts += 1
      if (attempts < 3) throw missingEntryError()
    })
    expect(attempts).toBe(3)
  })

  it('stops after the bounded ENOENT attempts', async () => {
    let attempts = 0
    await expect(copyForkEntryWithRetry(async () => {
      attempts += 1
      throw missingEntryError()
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(attempts).toBe(3)
  })

  it('does not retry other errors', async () => {
    let attempts = 0
    await expect(copyForkEntryWithRetry(async () => {
      attempts += 1
      throw new Error('permission denied')
    })).rejects.toThrow('permission denied')
    expect(attempts).toBe(1)
  })
})
