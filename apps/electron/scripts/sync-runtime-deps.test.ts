import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncRuntimeDeps, linkDevelopmentRuntimeDeps } from './sync-runtime-deps'
import { writeJsonFileAtomic } from '../src/main/lib/safe-file'
import { createRequire } from 'node:module'

function packageFixture(root: string, name: string, dependencies: Record<string, string> = {}): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeJsonFileAtomic(join(directory, 'package.json'), { name, version: '1.0.0', main: 'index.js', dependencies })
  writeFileSync(join(directory, 'index.js'), `module.exports = '${name}'`)
  return directory
}

describe('开发运行依赖同步', () => {
  it('Given 包内含 node_modules When 同步 Then 按依赖清单复制闭包并排除未声明的嵌套包', () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-sync-test-'))
    try {
      const source = join(directory, 'source', 'node_modules')
      const target = join(directory, 'app', 'node_modules')
      const parent = packageFixture(source, 'agent', { core: '1.0.0' })
      packageFixture(source, 'core')
      packageFixture(join(parent, 'node_modules'), 'unused-large-tree')
      packageFixture(target, 'unrelated-development-package')
      const result = syncRuntimeDeps({ sourceNodeModules: source, targetNodeModules: target, externalRuntimePackages: ['agent'], cleanTarget: false })
      expect(result.copiedPackageCount).toBe(2)
      expect(existsSync(join(target, 'core', 'package.json'))).toBe(true)
      expect(existsSync(join(target, 'agent', 'node_modules'))).toBe(false)
      expect(existsSync(join(target, 'unrelated-development-package', 'index.js'))).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('Given 嵌套依赖存在不同版本 When 同步 Then 保留真实解析版本且不复制无关依赖', () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-sync-version-'))
    try {
      const source = join(directory, 'source', 'node_modules')
      const target = join(directory, 'app', 'node_modules')
      packageFixture(source, 'core')
      const parent = packageFixture(source, 'agent', { core: '2.0.0' })
      const nested = packageFixture(join(parent, 'node_modules'), 'core')
      writeFileSync(join(nested, 'index.js'), 'module.exports = 2')
      syncRuntimeDeps({ sourceNodeModules: source, targetNodeModules: target, externalRuntimePackages: ['core', 'agent'], cleanTarget: false })
      expect(readFileSync(join(target, 'agent', 'node_modules', 'core', 'index.js'), 'utf8')).toBe('module.exports = 2')
      expect(readFileSync(join(target, 'core', 'index.js'), 'utf8')).toContain("'core'")
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('Given 复制新包时失败 When 目标已有可用包 Then 保留旧包入口而非留下残包', () => {
    const directory = mkdtempSync(join(tmpdir(), 'proma-sync-failure-'))
    try {
      const source = join(directory, 'source', 'node_modules')
      const target = join(directory, 'app', 'node_modules')
      const parent = packageFixture(source, 'agent')
      packageFixture(target, 'agent')
      writeFileSync(join(target, 'agent', 'index.js'), 'previous-good-entry')
      symlinkSync(join(directory, 'missing-directory'), join(parent, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => syncRuntimeDeps({ sourceNodeModules: source, targetNodeModules: target, externalRuntimePackages: ['agent'], cleanTarget: false })).toThrow()
      expect(readFileSync(join(target, 'agent', 'index.js'), 'utf8')).toBe('previous-good-entry')
      expect(existsSync(join(target, 'agent', 'package.json'))).toBe(true)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

it('Given 开发目录有不完整间接依赖 When 链接运行包 Then 从仓库源包解析完整依赖且重复启动安全', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proma-dev-links-'))
  try {
    const source = join(directory, 'source', 'node_modules')
    const target = join(directory, 'app', 'node_modules')
    packageFixture(source, 'core')
    const agent = packageFixture(source, 'agent', { core: '1.0.0' })
    writeFileSync(join(agent, 'index.js'), "module.exports = require('core')")
    mkdirSync(join(target, 'core'), { recursive: true })
    packageFixture(target, 'agent')
    const options = { sourceNodeModules: source, targetNodeModules: target, externalRuntimePackages: ['agent'] }
    linkDevelopmentRuntimeDeps(options)
    const require = createRequire(join(directory, 'app', 'main.cjs'))
    expect(require('agent')).toBe('core')
    expect(existsSync(join(target, 'agent', 'package.json'))).toBe(true)
    expect(linkDevelopmentRuntimeDeps(options).copiedPackageCount).toBe(1)
    expect(require('agent')).toBe('core')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
