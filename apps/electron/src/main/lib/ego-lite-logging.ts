type EgoLogEvent = 'client_open_started' | 'client_open_succeeded' | 'client_open_failed'
  | 'task_space_open_started' | 'task_space_opened' | 'task_space_open_unconfirmed'
  | 'action_succeeded' | 'action_failed' | 'dispatch_stopped' | 'dispatch_rejected'

/** 只传入固定原因码、计时和不透明标识，不传原始输入、输出或异常。 */
export function logEgoLite(level: 'info' | 'warn' | 'error', event: EgoLogEvent, context: Record<string, string | number | boolean>): void {
  try { console[level](`[Ego Lite] ${event}`, context) } catch { /* 诊断输出不能阻断浏览器 */ }
}
