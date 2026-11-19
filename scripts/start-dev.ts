import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface DevHost {
  check: (root: string) => void
  run: (root: string) => number
  log: (message: string) => void
}

export const repositoryRoot = resolve(import.meta.dir, '..')

export function checkDependencies(root: string): void {
  const manifest = resolve(root, 'apps/electron/package.json')
  if (!existsSync(manifest)) throw new Error('未找到 Electron 工程，请使用完整仓库。')
  const resolveDependency = (name: string): string => Bun.resolveSync(name, dirname(manifest))
  try {
    if (!existsSync(resolve(root, 'node_modules')) && !existsSync(resolve(root, 'apps/electron/node_modules'))) {
      throw new Error('缺少 node_modules')
    }
    for (const name of ['vite', 'concurrently', 'electronmon', 'esbuild', 'node-pty', '@earendil-works/pi-coding-agent']) {
      if (!existsSync(resolveDependency(name))) throw new Error(`依赖文件不存在：${name}`)
    }
    const electronDir = dirname(resolveDependency('electron'))
    const binary = readFileSync(resolve(electronDir, 'path.txt'), 'utf8').trim()
    if (!binary || !existsSync(resolve(electronDir, 'dist', binary))) {
      throw new Error('Electron 可执行文件不存在')
    }
  } catch (error) {
    throw new Error(`依赖不完整，请在仓库根目录运行 bun install；Electron 下载失败时可运行 bun node_modules/electron/install.js。详情：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function startDev(args: string[], root: string, host: DevHost): number {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    host.log('用法：start-dev [--check | --help]；--check 仅预检，不启动 GUI、不下载文件。')
    return 0
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    host.log('不支持的参数。用法：start-dev [--check | --help]')
    return 2
  }
  try {
    host.check(root)
    host.log(`仓库：${root}\n预检通过；启动命令：bun run dev（禁用自动进程清理）`)
    if (args[0] === '--check') return 0
    return host.run(root)
  } catch (error) {
    host.log(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = startDev(process.argv.slice(2), repositoryRoot, {
    check: checkDependencies,
    log: console.log,
    run: (root) => {
      const result = spawnSync(process.execPath, ['run', 'dev'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, PROMA_DEV_SKIP_CLEANUP: '1' },
      })
      if (result.error) throw result.error
      return result.status ?? 1
    },
  })
}
