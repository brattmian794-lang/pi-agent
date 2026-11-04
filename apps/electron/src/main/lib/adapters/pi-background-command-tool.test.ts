import { describe, expect, it } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createManagedPiShellTool, hasShellBackgroundOperator, type PiBackgroundCommandClient } from './pi-background-command-tool'

function fixture() {
  const foreground: string[] = []
  const background: string[] = []
  const tool: ToolDefinition = {
    name: 'bash', label: 'Bash', description: 'test shell', parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params) { foreground.push((params as { command: string }).command); return { content: [{ type: 'text', text: 'done' }], details: {} } },
  }
  const client: PiBackgroundCommandClient = {
    start: async (input) => { background.push(input.command); return { id: 'managed-command', sessionId: 'session-a', command: input.command, cwd: input.cwd, startedAt: Date.now(), status: 'running' } },
    list: async () => [], output: async () => null,
  }
  const managed = createManagedPiShellTool(tool, client)
  const run = (params: { command: string; runInBackground?: boolean }, signal?: AbortSignal) => managed.execute('call', params, signal, undefined, { cwd: process.cwd() } as Parameters<ToolDefinition['execute']>[4])
  return { foreground, background, run }
}

describe('Pi 显式后台 Shell', () => {
  it('Given 普通前台命令 When 执行 Then 仍使用原 SDK 工具', async () => {
    const fixture = fixtureFactory()
    await fixture.run({ command: 'printf done' })
    expect(fixture.foreground).toEqual(['printf done'])
    expect(fixture.background).toEqual([])
  })
  it('Given 显式后台参数 When 启动 Then 原样传入主进程并返回稳定命令ID', async () => {
    const test = fixtureFactory()
    const result = await test.run({ command: 'python -m http.server', runInBackground: true })
    expect(test.foreground).toEqual([])
    expect(test.background).toEqual(['python -m http.server'])
    expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('managed-command') })])
  })
  it('Given 旧式 nohup 后跟健康检查 When 执行 Then 整段脚本交给受管进程树而非读取末尾PID', async () => {
    const test = fixtureFactory()
    const command = 'nohup python server.py >server.log 2>&1 & NEW_PID=$!; echo "$NEW_PID" >server.pid; sleep 1; curl localhost:8765'
    await test.run({ command })
    expect(test.background).toEqual([command])
    expect(test.foreground).toEqual([])
  })
  it('Given 引号、注释、重定向和逻辑与 When 检测兼容后台语法 Then 不误判普通命令', () => {
    for (const command of ['echo "a&b"', "echo 'a&b'", 'echo ok && echo done', 'echo ok >out 2>&1', 'echo ok &>out', 'echo ok # & no job', 'echo a\\&b']) expect(hasShellBackgroundOperator(command)).toBe(false)
    expect(hasShellBackgroundOperator('server &')).toBe(true)
  })
  it('Given 启动前已取消 When 执行 Then 不启动新进程', async () => {
    const test = fixtureFactory()
    await expect(test.run({ command: 'server', runInBackground: true }, AbortSignal.abort())).rejects.toThrow('已取消')
    expect(test.background).toEqual([])
  })
})
const fixtureFactory = fixture
