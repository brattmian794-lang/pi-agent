/**
 * Bun 运行时路径检测模块
 *
 * Bun 是 Proma 的可选组件（不影响核心 Agent 功能，SDK 自带编译好的 claude 二进制）。
 * 仅用于：
 * - 系统状态展示（设置页显示用户是否装了 Bun）
 * - 用户可能从终端用 Bun 跑自定义脚本时的路径探测
 *
 * 检测顺序（统一逻辑，开发/打包一致）：
 * 1. 打包产物内 vendor/bun/（当前默认不打包，留给未来可选打包扩展）
 * 2. 系统 PATH（which bun / where bun）
 * 3. 开发仓库 apps/electron/vendor/bun/{platform-arch}/（dev 用）
 */

import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { execSync, spawnSync } from 'child_process'
import { app } from 'electron'
import type { BunRuntimeStatus, PlatformArch } from '@proma/shared'

/**
 * 获取当前平台架构标识
 *
 * @returns 当前系统的平台架构组合
 */
export function getCurrentPlatformArch(): PlatformArch {
  const platform = process.platform as 'darwin' | 'linux' | 'win32'
  const arch = process.arch as 'arm64' | 'x64'

  // 验证支持的组合
  const platformArch = `${platform}-${arch}` as PlatformArch

  const supportedCombinations: PlatformArch[] = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-x64',
  ]

  if (!supportedCombinations.includes(platformArch)) {
    throw new Error(`不支持的平台架构组合: ${platformArch}`)
  }

  return platformArch
}

/**
 * 获取 Bun 二进制文件名
 *
 * @returns Windows 上返回 'bun.exe'，其他平台返回 'bun'
 */
function getBunBinaryName(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun'
}

/**
 * 获取打包环境下的 Bun 路径
 *
 * 打包后的目录结构：
 * - macOS: App.app/Contents/Resources/vendor/bun/bun
 * - Windows: resources/vendor/bun/bun.exe
 * - Linux: resources/vendor/bun/bun
 *
 * @returns Bun 二进制路径，如果不存在返回 null
 */
export function getBundledBunPath(): string | null {
  if (!app.isPackaged) {
    return null
  }

  // process.resourcesPath 指向应用的 resources 目录
  const bunPath = join(process.resourcesPath, 'vendor', 'bun', getBunBinaryName())

  if (existsSync(bunPath)) {
    return bunPath
  }

  return null
}

/**
 * 获取开发环境下 vendor 目录中的 Bun 路径
 *
 * 开发环境目录结构：
 * apps/electron/vendor/bun/{platform-arch}/bun
 *
 * @returns Bun 二进制路径，如果不存在返回 null
 */
export function getVendorBunPath(): string | null {
  if (app.isPackaged) {
    return null
  }

  try {
    const platformArch = getCurrentPlatformArch()
    // __dirname 在开发环境下指向 dist/，需要向上一级到 apps/electron/
    const vendorDir = join(__dirname, '..', 'vendor', 'bun', platformArch)
    const bunPath = join(vendorDir, getBunBinaryName())

    if (existsSync(bunPath)) {
      return bunPath
    }
  } catch {
    // 平台不支持，忽略
  }

  return null
}

/**
 * 从系统 PATH 查找所有 Bun 候选
 *
 * `where bun` 会按 PATH 顺序返回多行（每行以 CRLF 结尾），`which bun` 同理；
 * 逐行规范化后返回全部真实存在的路径，交给上层逐个校验可执行性。
 *
 * @returns 存在于磁盘上的候选路径列表，未找到返回空数组
 */
export function getSystemBunPaths(): string[] {
  try {
    // 使用 which/where 命令查找 bun
    const command = process.platform === 'win32' ? 'where bun' : 'which bun'

    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })

    return result
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
      .filter((line) => line.length > 0 && existsSync(line))
  } catch {
    // 命令执行失败，Bun 未安装
  }

  return []
}

/**
 * 验证 Bun 可执行文件
 *
 * @param bunPath - Bun 二进制路径
 * @returns 版本号，或无法执行时的具体原因
 */
export function validateBunExecutable(bunPath: string): { ok: true; version: string } | { ok: false; reason: string } {
  if (!existsSync(bunPath)) {
    return { ok: false, reason: '路径不存在或不可访问' }
  }

  try {
    // 使用 spawnSync 执行，更可靠
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (result.error) {
      return { ok: false, reason: result.error.message }
    }
    if (result.status === 0 && result.stdout) {
      return { ok: true, version: result.stdout.trim() }
    }
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    return { ok: false, reason: stderr || `退出码 ${String(result.status)}（可能不是可执行文件）` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 检测并返回 Bun 运行时状态
 *
 * Bun 是可选组件 —— Claude Agent SDK 0.2.113+ 分发了按平台编译的 claude native
 * binary，核心功能不依赖 Bun。这里的检测结果只用于：
 * - 系统运行时状态卡片展示
 * - 用户执行依赖 Bun 的自定义脚本时提供可用性提示
 *
 * 检测顺序：bundled（若存在） → 系统 PATH → 开发 vendor 目录
 * 全部未命中时返回 available: false 但 **不视为错误**（error 置 null）。
 *
 * @returns Bun 运行时状态
 */
export async function detectBunRuntime(): Promise<BunRuntimeStatus> {
  console.log('[Bun 检测] 开始检测 Bun 运行时（可选组件）...')

  /** Bun 安装来源，用于把诊断日志定位到具体位置。 */
  type BunSource = 'bundled' | 'system' | 'vendor'

  const candidateSources: Array<{ list: () => string[]; source: BunSource }> = [
    { list: () => { const bunPath = getBundledBunPath(); return bunPath ? [bunPath] : [] }, source: 'bundled' },
    { list: getSystemBunPaths, source: 'system' },
    { list: () => { const bunPath = getVendorBunPath(); return bunPath ? [bunPath] : [] }, source: 'vendor' },
  ]

  /** 找到但无法执行的候选，用于区分「未安装」与「安装不可用」。 */
  const failedCandidates: Array<{ path: string; source: BunSource; reason: string }> = []

  for (const { list, source } of candidateSources) {
    for (const bunPath of list()) {
      const validation = validateBunExecutable(bunPath)
      if (!validation.ok) {
        console.warn(`[Bun 检测] ${source} 位置的 Bun 无法执行: ${bunPath}（${validation.reason}）`)
        failedCandidates.push({ path: bunPath, source, reason: validation.reason })
        // PATH 里可能残留多个 bun（旧安装、包管理器副本），继续校验下一个候选。
        continue
      }

      console.log(`[Bun 检测] 找到 Bun (${source}): ${bunPath} (${validation.version})`)
      return {
        available: true,
        path: bunPath,
        version: validation.version,
        source,
        error: null,
      }
    }
  }

  if (failedCandidates.length > 0) {
    const detail = failedCandidates.map((item) => `${item.source}=${item.path}（${item.reason}）`).join('; ')
    const error = `发现 ${failedCandidates.length} 个 Bun 候选但都无法执行：${detail}`
    console.warn(`[Bun 检测] ${error}。请确认该文件可执行（权限、架构匹配）或重新安装 Bun。`)
    return {
      available: false,
      path: null,
      version: null,
      source: null,
      error,
    }
  }

  console.log('[Bun 检测] 未找到 Bun（可选，不影响 Proma 核心功能）')
  return {
    available: false,
    path: null,
    version: null,
    source: null,
    error: null,
  }
}
