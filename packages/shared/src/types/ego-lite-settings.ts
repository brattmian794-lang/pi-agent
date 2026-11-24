export const EGO_LITE_SETTINGS_IPC = {
  GET: 'ego-lite-settings:get',
  CHANGE: 'ego-lite-settings:change',
  PROBE: 'ego-lite-settings:probe',
  START: 'ego-lite-setup:start',
  CANCEL: 'ego-lite-setup:cancel',
  STATUS: 'ego-lite-setup:status',
} as const

export type EgoProfileMode = 'current' | 'workspace'

export interface EgoLiteSettings {
  egoLiteEnabled: boolean
  browserExecutionBackend: 'builtin' | 'egoLite'
  /** current 复用现有默认 Profile；workspace 要求独立的非默认 Profile。 */
  egoLiteProfileMode: EgoProfileMode
}

/** 单次交互只改变开关、后端或配置模式，启用不会隐式选择后端。 */
export type EgoLiteSettingsChange = boolean | EgoLiteSettings['browserExecutionBackend'] | EgoProfileMode

export interface EgoSetupState {
  stage: 'idle' | 'detecting' | 'downloading' | 'installing' | 'starting' | 'configuring' | 'ready' | 'failed' | 'cancelled' | 'cancelling'
  message: string
  percent?: number
  workspaceId?: string
}

export function isEgoSetupActive(stage: EgoSetupState['stage']): boolean {
  return ['detecting', 'downloading', 'installing', 'starting', 'configuring', 'cancelling'].includes(stage)
}
