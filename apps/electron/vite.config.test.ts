import { describe, expect, test } from 'bun:test'
import { developmentContentSecurityPolicy, developmentCspPlugin } from './vite.config'

describe('development Content Security Policy', () => {
  test('Given the Vite development server When transforming the renderer entry Then CSP allows HMR without unsafe-eval', () => {
    const tags = developmentCspPlugin.transformIndexHtml()
    const policyTag = tags[0]

    expect(developmentCspPlugin.apply).toBe('serve')
    expect(policyTag?.attrs['http-equiv']).toBe('Content-Security-Policy')
    expect(policyTag?.attrs.content).toBe(developmentContentSecurityPolicy)
    expect(developmentContentSecurityPolicy).toContain('http://127.0.0.1:5173')
    expect(developmentContentSecurityPolicy).toContain('ws:')
    expect(developmentContentSecurityPolicy).not.toContain('unsafe-eval')
  })
})
