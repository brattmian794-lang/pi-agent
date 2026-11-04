import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBackgroundCommand, AgentBackgroundCommandDetails } from '@proma/shared'
import { isAgentBackgroundCommandActive } from '@proma/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

/** 每个会话独立的可移植快照；不保存环境变量或进程控制凭据。 */
export class BackgroundCommandStore {
  constructor(private readonly root: string) {}

  private path(sessionId: string): string {
    return join(this.root, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  }

  read(sessionId: string): AgentBackgroundCommandDetails[] {
    const raw = readJsonFileSafe<{ version: number; entries: AgentBackgroundCommandDetails[] }>(this.path(sessionId))
    if (raw?.version !== 1 || !Array.isArray(raw.entries)) return []
    return raw.entries.filter((entry) => entry && entry.command?.sessionId === sessionId
      && typeof entry.command.id === 'string' && typeof entry.output === 'string').map((entry) => {
      const command: AgentBackgroundCommand = { ...entry.command }
      if (isAgentBackgroundCommandActive(command)) {
        command.status = 'interrupted'
        command.endedAt = Date.now()
        command.error = '上次应用已退出，无法安全恢复此进程的控制权。'
      }
      return { command, output: entry.output.slice(-65_536), truncated: entry.truncated || entry.output.length > 65_536 }
    }).slice(-40)
  }

  write(sessionId: string, entries: AgentBackgroundCommandDetails[]): void {
    mkdirSync(this.root, { recursive: true })
    writeJsonFileAtomic(this.path(sessionId), { version: 1, entries })
  }
}
