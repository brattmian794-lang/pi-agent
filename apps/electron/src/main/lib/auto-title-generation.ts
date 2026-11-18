import type { AgentSessionMeta } from '@proma/shared'
import { createFallbackTitle } from './title-generation'

const DEFAULT_SESSION_TITLE = '新 Agent 会话'

interface AutomaticTitleSessionMeta extends Pick<AgentSessionMeta,
  'title' | 'explorationParentSessionId' | 'explorationTitleInitializedAt'> {}

/** 由编排层注入会话存储与生成入口，测试无需加载 Electron 或访问真实用户数据。 */
export interface AutomaticTitleEnvironment {
  getSessionMeta: () => AutomaticTitleSessionMeta | undefined
  updateSessionMeta: (updates: Partial<AutomaticTitleSessionMeta>) => void
  generateTitle: () => Promise<string | null>
  onTitleUpdated: (title: string) => void
}

/** 首条消息自动命名，保留分支初始化守卫及生成期间的手动命名保护。 */
export async function autoGenerateSessionTitle(
  userMessage: string,
  environment: AutomaticTitleEnvironment,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  const { getSessionMeta, updateSessionMeta, generateTitle, onTitleUpdated } = environment
  try {
    const meta = getSessionMeta()
    if (!meta) return
    const isDefaultSessionTitle = meta.title === DEFAULT_SESSION_TITLE
    const isFirstExplorationMessage = Boolean(
      meta.explorationParentSessionId && !meta.explorationTitleInitializedAt,
    )
    if (!isDefaultSessionTitle && !isFirstExplorationMessage) return

    // 分支先保存初始化守卫，避免连续发送消息时启动多个竞争请求。
    const explorationTitleInitializedAt = isFirstExplorationMessage ? Date.now() : undefined
    if (explorationTitleInitializedAt) updateSessionMeta({ explorationTitleInitializedAt })

    const title = await generateTitle()
      ?? (isFirstExplorationMessage ? createFallbackTitle(userMessage) : null)
    if (!title || signal?.aborted) return

    const latestMeta = getSessionMeta()
    const canApplyDefaultTitle = isDefaultSessionTitle && latestMeta?.title === DEFAULT_SESSION_TITLE
    const canApplyExplorationTitle = Boolean(
      isFirstExplorationMessage
      && latestMeta?.title === meta.title
      && latestMeta.explorationTitleInitializedAt === explorationTitleInitializedAt,
    )
    if (!latestMeta || (!canApplyDefaultTitle && !canApplyExplorationTitle)) return

    updateSessionMeta({ title })
    onTitleUpdated(title)
    console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
  } catch (error) {
    if (signal?.aborted) return
    console.warn('[Agent 编排] 自动标题生成失败:', error)
  }
}
