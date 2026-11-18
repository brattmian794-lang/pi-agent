import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export type FeedFault = 'none' | 'interrupted' | 'corrupt' | 'offline'

/** 只读取专用 feed 目录的测试 HTTP 服务，不转发公网请求。 */
export class LocalUpdateFeed {
  private server: Server | null = null
  private origin = ''
  fault: FeedFault = 'none'
  invalidSignature = false
  constructor(readonly directory: string, readonly channel = process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml') {}

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      const filename = basename(pathname)
      console.log(`[updater-test-feed] ${request.method} ${pathname} range=${request.headers.range ?? '-'} from=${request.socket.remoteAddress ?? '-'}`)
      response.once('finish', () => console.log(`[updater-test-feed] ${filename} response-finish bytes=${response.getHeader('content-length') ?? '-'}`))
      response.once('close', () => { if (!response.writableFinished) console.warn(`[updater-test-feed] ${filename} response-closed-before-finish`) })
      const filePath = join(this.directory, filename)
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end('not found')
        return
      }
      if (filename.endsWith('.yml') && this.invalidSignature) {
        const packagePath = readdirSync(this.directory).find((entry) => entry.endsWith('.exe'))
        if (!packagePath) throw new Error('签名故障场景缺少 Windows 安装包')
        const tampered = readFileSync(join(this.directory, packagePath))
        tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
        const sha512 = createHash('sha512').update(tampered).digest('base64')
        response.setHeader('content-type', 'text/yaml')
        response.end(readFileSync(filePath, 'utf8').replace(/sha512: .+/g, `sha512: ${sha512}`))
        return
      }
      const content = readFileSync(filePath)
      if (this.invalidSignature && filename.endsWith('.exe')) content[content.length - 1] = (content[content.length - 1] ?? 0) ^ 1
      const payload = this.fault === 'corrupt' && /\.(exe|zip|AppImage)$/.test(filename) ? Buffer.from('corrupted test package') : content
      response.setHeader('content-length', payload.length)
      if (this.fault === 'interrupted' && /\.(exe|zip|AppImage)$/.test(filename)) {
        response.writeHead(200)
        response.write(content.subarray(0, Math.min(65536, content.length)))
        response.destroy()
        return
      }
      response.writeHead(200)
      response.end(payload)
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法分配本地测试 feed 端口')
    this.origin = `http://127.0.0.1:${address.port}`
    return this.origin
  }

  get url(): string {
    if (this.fault === 'offline' || !this.origin) return this.origin
    return this.origin
  }

  async close(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server = null
  }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 无新版场景使用独立的旧版 feed 目录，绝不覆盖新版工件。 */
export function prepareNoUpdateFeed(source: string, destination: string, startVersion: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry.endsWith('.yml') || !statSync(join(source, entry)).isFile()) continue
    copyFileSync(join(source, entry), join(destination, entry))
  }
  const extension = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.zip' : '.AppImage'
  const file = readdirSync(destination).find((entry) => entry.endsWith(extension))
  if (!file) throw new Error('旧版 feed 缺少安装包')
  const content = readFileSync(join(destination, file))
  const yaml = `version: ${startVersion}\nfiles:\n  - url: ${file}\n    sha512: ${createHash('sha512').update(content).digest('base64')}\n    size: ${content.length}\npath: ${file}\nsha512: ${createHash('sha512').update(content).digest('base64')}\nreleaseDate: '${new Date().toISOString()}'\n`
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(join(destination, process.platform === 'darwin' ? 'latest-mac.yml' : process.platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'), yaml)
}
