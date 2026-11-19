import { cp, mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

const FORK_WORKSPACE_COPY_BLOCKLIST = new Set([
  '.claude',
  '.DS_Store',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  'coverage',
  'target',
])

export interface ForkWorkspaceCopyResult {
  copiedCount: number
  skippedCount: number
  failedCount: number
}

export function shouldCopyForkWorkspacePath(src: string): boolean {
  return !FORK_WORKSPACE_COPY_BLOCKLIST.has(basename(src))
}

const ENOENT_COPY_ATTEMPTS = 3

export async function copyForkEntryWithRetry(copy: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await copy()
      return
    } catch (error) {
      const isMissingEntry = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      if (!isMissingEntry || attempt >= ENOENT_COPY_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 25))
    }
  }
}

export async function copyForkWorkspaceFiles(sourceDir: string, destDir: string): Promise<ForkWorkspaceCopyResult> {
  await mkdir(destDir, { recursive: true })

  const result: ForkWorkspaceCopyResult = {
    copiedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(sourceDir, entry.name)
    const destPath = join(destDir, entry.name)

    if (!shouldCopyForkWorkspacePath(srcPath)) {
      result.skippedCount += 1
      continue
    }

    try {
      await copyForkEntryWithRetry(() => cp(srcPath, destPath, {
        recursive: true,
        filter: shouldCopyForkWorkspacePath,
      }))
      result.copiedCount += 1
    } catch (err) {
      result.failedCount += 1
      console.warn(`[Agent 会话] fork 工作区条目复制失败，已跳过 (${srcPath}):`, err)
    }
  }

  return result
}
