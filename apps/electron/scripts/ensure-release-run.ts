import { spawnSync } from 'node:child_process'

export interface ReleaseRun { head_sha: string; head_branch: string; status: string; conclusion: string | null; html_url: string }
export function findReleaseRun(runs: ReleaseRun[], tag: string, commit: string): ReleaseRun | undefined {
  return runs.find((run) => run.head_branch === tag && run.head_sha === commit)
}
export function parseGithubRemote(remote: string): { owner: string; repo: string } {
  const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error('origin 必须是 GitHub 仓库地址')
  return { owner: match[1]!, repo: match[2]! }
}
export function validateReleaseTag(tag: string): void {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(tag)) throw new Error('标签格式无效，例如 v0.19.70-beta.12')
}
function git(args: string[], input?: string): string {
  const result = spawnSync('git', args, { encoding: 'utf8', input, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`Git 命令失败：${args[0]}（${result.error?.message ?? result.stderr.trim()}）`)
  return result.stdout.trim()
}
function credential(): string {
  const lines = git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n').split(/\r?\n/)
  const password = lines.find((line) => line.startsWith('password='))?.slice(9)
  if (!password) throw new Error('未找到 GitHub 凭据，请先配置 Git Credential Manager')
  return password
}
interface GithubRuns { workflow_runs: ReleaseRun[] }
async function github<T>(url: string, token: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(url, {
    method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'proma-release-dispatch', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}（${method} ${new URL(url).pathname}）`)
  return response.status === 204 ? undefined as T : await response.json() as T
}
export async function ensureReleaseRun(tag: string): Promise<ReleaseRun> {
  validateReleaseTag(tag)
  const { owner, repo } = parseGithubRemote(git(['remote', 'get-url', 'origin']))
  const refs = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split(/\r?\n/)
  const annotated = refs.find((line) => line.endsWith(`refs/tags/${tag}^{}`))
  const lightweight = refs.find((line) => line.endsWith(`refs/tags/${tag}`))
  const commit = (annotated ?? lightweight)?.split(/\s+/)[0]
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error(`远程标签不存在或无法解析: ${tag}`)
  const token = credential()
  const api = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/release.yml`
  const lookup = async (): Promise<ReleaseRun | undefined> => {
    const result = await github<GithubRuns>(`${api}/runs?per_page=100&branch=${encodeURIComponent(tag)}`, token)
    return findReleaseRun(result.workflow_runs, tag, commit)
  }
  const existing = await lookup()
  if (existing) return existing
  await github<void>(`${api}/dispatches`, token, 'POST', { ref: tag })
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const run = await lookup()
    if (run) return run
  }
  throw new Error('GitHub 已接受触发请求，但 30 秒内未查询到运行；请在 Actions 页面检查，勿重复触发')
}
if (import.meta.main) {
  const tag = process.argv[2]
  if (!tag) throw new Error('用法：bun run scripts/ensure-release-run.ts v版本号')
  const run = await ensureReleaseRun(tag)
  console.log(`[发布] ${tag}: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`)
  console.log(`[发布] ${run.html_url}`)
  if (run.status === 'completed' && run.conclusion !== 'success') process.exitCode = 1
}
