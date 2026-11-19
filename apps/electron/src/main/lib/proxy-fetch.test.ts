import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { createManagedProxyFetch } from './proxy-fetch'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('managed fetch for long-lived SSE', () => {
  test('reads an idle SSE response with body timeout disabled and closes its dispatcher', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: connected\n\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected local TCP server')

    const managedFetch = createManagedProxyFetch(undefined, { bodyTimeoutMs: 0 })
    try {
      const response = await managedFetch.fetch(`http://127.0.0.1:${address.port}/events`)
      const reader = response.body?.getReader()
      expect((await reader?.read())?.done).toBe(false)
      await reader?.cancel()
    } finally {
      await managedFetch.close()
    }
  })
})
