import type { UpdateStatus } from '../../src/main/lib/updater/updater-types'

export type UpdaterTestScenario = 'normal' | 'interrupted' | 'corrupt' | 'invalid-signature' | 'offline' | 'disk-full' | 'no-update' | 'agent-guard' | 'cancel-install' | 'install-failure' | 'startup-recovery' | 'cleanup'

export interface UpdaterTestStep {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  at: string
  detail?: string
}

export interface UpdaterTestReport {
  schemaVersion: 1
  runId: string
  scenario: UpdaterTestScenario
  mode: 'local-feed' | 'staging'
  platform: NodeJS.Platform
  arch: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'passed' | 'failed' | 'skipped'
  startVersion: string
  targetVersion: string
  restartedVersion?: string
  packageHashes: Record<string, string>
  exits: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null }>
  errors: string[]
  steps: UpdaterTestStep[]
  paths: { root: string; logs: string; events: string; state: string }
}

export interface InstanceState {
  schemaVersion: 1
  version: string
  pid: number
  startedAt: string
  updatedAt: string
  agentActive: boolean
  updateStatus: UpdateStatus
  exePath: string
  appPath: string
  rendererUrl?: string
  lastCommand?: string
  error?: string
}
