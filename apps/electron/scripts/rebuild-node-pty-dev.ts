import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows x64 优先复用 node-pty 预构建文件，避免开发环境依赖 Visual Studio。
const nodePtyRoot = join(import.meta.dir, '..', '..', '..', 'node_modules', 'node-pty')
const prebuiltPty = join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node')

if (process.platform === 'win32' && process.arch === 'x64' && existsSync(prebuiltPty)) {
  console.log(`[node-pty] 开发模式使用预构建产物，跳过 electron-rebuild：${prebuiltPty}`)
  process.exit(0)
}

const result = spawnSync(process.execPath, ['run', 'rebuild:node-pty'], {
  cwd: join(import.meta.dir, '..'),
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
