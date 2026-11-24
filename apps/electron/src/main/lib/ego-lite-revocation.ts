/** 每个外部运行只订阅创建时的授权。撤销同步通知所有句柄，下一代使用独立信号。 */
let authorization = new AbortController()

export function egoLiteAuthorizationSignal(): AbortSignal {
  return authorization.signal
}

export function revokeEgoLiteRuns(): void {
  const previous = authorization
  authorization = new AbortController()
  previous.abort()
}
