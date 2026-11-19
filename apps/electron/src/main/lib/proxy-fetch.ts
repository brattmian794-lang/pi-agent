/**
 * 代理 Fetch 工具
 *
 * 基于 undici ProxyAgent 创建支持 HTTP 代理的 fetch 函数。
 * 用于渠道配置了代理地址时，让 AI API 请求走指定代理。
 */

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Dispatcher, RequestInfo, RequestInit } from 'undici'
import type { Agent as UndiciAgent } from 'undici'

export interface ManagedProxyFetch {
  fetch: typeof globalThis.fetch
  close: () => Promise<void>
}

export interface ManagedProxyFetchOptions {
  bodyTimeoutMs?: number
}

export function createManagedProxyFetch(proxyUrl?: string, options: ManagedProxyFetchOptions = {}): ManagedProxyFetch {
  const normalizedProxyUrl = proxyUrl?.trim()
  const agentOptions: UndiciAgent.Options = options.bodyTimeoutMs === undefined ? {} : { bodyTimeout: options.bodyTimeoutMs }
  const dispatcher = normalizedProxyUrl
    ? new ProxyAgent({ uri: normalizedProxyUrl, ...agentOptions })
    : options.bodyTimeoutMs === undefined ? undefined : new Agent(agentOptions)
  if (!dispatcher) return { fetch, close: async () => undefined }

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => undiciFetch(input as RequestInfo, { ...init, dispatcher })) as unknown as typeof globalThis.fetch,
    close: async () => {
      await (dispatcher as Dispatcher & { close?: () => Promise<void> }).close?.().catch(() => undefined)
    },
  }
}


/**
 * 创建代理 fetch 函数。
 */
export function createProxyFetch(proxyUrl: string): typeof globalThis.fetch {
  const dispatcher = new ProxyAgent(proxyUrl)
  return ((input: RequestInfo | URL, init?: RequestInit) => undiciFetch(input as RequestInfo, { ...init, dispatcher })) as unknown as typeof globalThis.fetch
}

export function getFetchFn(proxyUrl?: string): typeof globalThis.fetch {
  return proxyUrl?.trim() ? createProxyFetch(proxyUrl.trim()) : fetch
}
