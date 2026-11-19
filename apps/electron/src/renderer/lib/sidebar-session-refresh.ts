/** 只提交最新请求，且全量结果不能覆盖请求期间写入的会话变化。 */
export function createSidebarRefresh() {
  let request = 0

  return {
    invalidate(): void {
      request += 1
    },
    async run<T>(read: () => unknown, load: () => Promise<T>, commit: (result: T) => void): Promise<void> {
      const currentRequest = ++request
      while (currentRequest === request) {
        const before = read()
        let result: T
        try {
          result = await load()
        } catch (error) {
          if (currentRequest === request) throw error
          return
        }
        if (currentRequest !== request) return
        if (read() !== before) continue
        commit(result)
        return
      }
    },
  }
}

/** 委派子行可见时优先定位子行，折叠后回退到高亮的父行。 */
export function getAgentSidebarActiveRowId(
  rowIds: readonly string[],
  prefix: 'agent' | 'agent-archived',
  activeSessionId: string | null,
  activeDelegationSessionId: string | null,
  parentSessionId: string | undefined,
): string | null {
  if (!activeSessionId) return null
  const childId = `${prefix}-child-${activeDelegationSessionId ?? activeSessionId}`
  if (rowIds.includes(childId)) return childId
  const sessionId = `${prefix}-${activeSessionId}`
  if (rowIds.includes(sessionId)) return sessionId
  return parentSessionId ? `${prefix}-${parentSessionId}` : null
}
