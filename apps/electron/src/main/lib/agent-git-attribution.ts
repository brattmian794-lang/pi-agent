/**
 * pi-agent Git / PR 归因标识
 *
 * 当 Agent 代用户创建 commit 或 PR 时，附带可搜索、可关闭的 pi-agent 标识，
 * 并在 PR 中说明当前 fork 与上游项目，避免伪造 Co-Authored-By 作者。
 */

/** 默认开启：对齐 Claude Code / Cursor「默认归因 + 可关」策略 */
export const DEFAULT_GIT_ATTRIBUTION_ENABLED = true

/** 当前 fork 与上游仓库地址 */
export const PI_AGENT_REPO_URL = 'https://github.com/brattmian794-lang/pi-agent'
export const PI_AGENT_UPSTREAM_URL = 'https://github.com/proma-ai/Proma'

/** Commit trailer（标准 git trailer，不进入 GitHub co-author 列表） */
export const PI_AGENT_COMMIT_TRAILER = 'Made-with: pi-agent'

/** PR / MR 描述底部标识，保留 fork 与上游来源。 */
export const PI_AGENT_PR_ATTRIBUTION =
  `Made with [pi-agent](${PI_AGENT_REPO_URL}) · Fork of [Proma](${PI_AGENT_UPSTREAM_URL})`

export interface GitAttributionConfig {
  /** 是否启用；undefined 视为默认开启 */
  enabled?: boolean
}

/** 解析最终是否启用（缺省 = 默认开启） */
export function isGitAttributionEnabled(config?: GitAttributionConfig | boolean | null): boolean {
  if (typeof config === 'boolean') return config
  if (config && typeof config === 'object' && typeof config.enabled === 'boolean') {
    return config.enabled
  }
  return DEFAULT_GIT_ATTRIBUTION_ENABLED
}

/** 注入到 buildSystemPrompt 的 Git/PR 标识规范 */
export function buildGitAttributionPromptSection(enabled: boolean): string {
  if (!enabled) {
    return `## Git / PR 标识
用户已关闭 pi-agent 标识；除非当次明确要求，不要添加任何 pi-agent 归因。`
  }

  return `## Git / PR 标识
当你代用户创建 commit 或 PR/MR 时，除非用户当次明确拒绝：
- commit 的 message 末尾追加唯一的 \`${PI_AGENT_COMMIT_TRAILER}\` trailer；不要使用 \`Co-Authored-By\`，不要改 author/committer。
- PR/MR 描述末尾追加唯一的 \`${PI_AGENT_PR_ATTRIBUTION}\`。`
}
