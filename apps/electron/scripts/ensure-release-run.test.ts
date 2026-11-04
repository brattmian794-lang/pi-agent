import { describe, expect, it } from 'bun:test'
import { findReleaseRun, parseGithubRemote, validateReleaseTag, type ReleaseRun } from './ensure-release-run'

describe('发布工作流兜底', () => {
  it('Given HTTPS 或 SSH GitHub 远程地址 When 解析 Then 保留正确的仓库所有者和名称', () => {
    expect(parseGithubRemote('https://github.com/user/project.git')).toEqual({ owner: 'user', repo: 'project' })
    expect(parseGithubRemote('git@github.com:user/project.git')).toEqual({ owner: 'user', repo: 'project' })
    expect(() => parseGithubRemote('https://example.com/user/project.git')).toThrow()
  })
  it('Given 版本标签 When 校验 Then 接受正式版和预发布，拒绝路径或命令输入', () => {
    expect(() => validateReleaseTag('v0.19.70-beta.12')).not.toThrow()
    expect(() => validateReleaseTag('v1.2.3')).not.toThrow()
    expect(() => validateReleaseTag('main')).toThrow()
    expect(() => validateReleaseTag('v1.2.3/other')).toThrow()
  })
  it('Given 已存在其他标签或旧提交的运行 When 检索 Then 只匹配当前标签与提交，避免重复触发', () => {
    const runs: ReleaseRun[] = [
      { head_sha: 'old', head_branch: 'v1.2.3', status: 'completed', conclusion: 'success', html_url: 'old' },
      { head_sha: 'current', head_branch: 'v1.2.4', status: 'queued', conclusion: null, html_url: 'other' },
      { head_sha: 'current', head_branch: 'v1.2.3', status: 'in_progress', conclusion: null, html_url: 'correct' },
    ]
    expect(findReleaseRun(runs, 'v1.2.3', 'current')?.html_url).toBe('correct')
    expect(findReleaseRun(runs, 'v1.2.3', 'missing')).toBeUndefined()
  })
})
