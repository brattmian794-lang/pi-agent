import { describe, expect, it } from 'bun:test'
import { buildPiAgentBrowserUserAgent } from './browser-identity'

describe('pi-agent browser identity', () => {
  it('uses the pi-agent product token while preserving Chromium compatibility tokens', () => {
    const result = buildPiAgentBrowserUserAgent(
      'Mozilla/5.0 Chrome/130.0.0.0 Electron/33.0.0 Proma/0.19.78',
      '0.19.79',
    )

    expect(result).toContain('Chrome/130.0.0.0')
    expect(result).toContain('pi-agent/0.19.79')
    expect(result).not.toContain('Electron/')
    expect(result).not.toContain('Proma/')
  })

  it('replaces an existing pi-agent token instead of duplicating it', () => {
    const result = buildPiAgentBrowserUserAgent(
      'Mozilla/5.0 Chrome/130.0.0.0 pi-agent/0.19.78',
      '0.19.79',
    )

    expect(result.match(/pi-agent\//g)).toHaveLength(1)
  })
})
