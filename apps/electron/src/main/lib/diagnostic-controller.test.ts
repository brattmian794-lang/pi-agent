import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from './diagnostic-log'
import { DiagnosticController, isDiagnosticRecord, isDiagnosticSender } from './diagnostic-controller'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'diagnostic-controller-'))
  directories.push(directory)
  let persisted = false
  let failSave = false
  let destination: string | undefined = join(directory, 'export.log')
  const notifications: boolean[] = []
  const create = () => new DiagnosticController({
    log: new DiagnosticLog(join(directory, 'logs')),
    readEnabled: () => persisted,
    saveEnabled: (enabled) => { if (failSave) throw new Error('权限不足'); persisted = enabled },
    notify: (state) => { notifications.push(state.enabled) },
    chooseDestination: async () => destination,
    metadata: { version: 'test-version', platform: 'win32', arch: 'x64' },
  })
  return { directory, create, notifications, failSave: () => { failSave = true }, choose: (path?: string) => { destination = path } }
}

describe('诊断控制层', () => {
  test('Given 默认关闭 When 开启、重建服务、关闭 Then 即时生效、重启恢复且历史仍可导出', async () => {
    const setup = fixture()
    const controller = setup.create()
    expect(controller.getState().enabled).toBe(false)
    controller.record({ level: 'log', values: ['关闭前消息'] })
    expect((await controller.exportLogs()).status).toBe('empty')
    controller.setEnabled(true)
    controller.record({ level: 'error', values: ['错误消息'] })
    const restarted = setup.create()
    expect(restarted.getState().enabled).toBe(true)
    restarted.setEnabled(false)
    restarted.record({ level: 'warn', values: ['关闭后消息'] })
    expect((await restarted.exportLogs()).status).toBe('exported')
    const result = readFileSync(join(setup.directory, 'export.log'), 'utf8')
    expect(result).toContain('错误消息')
    expect(result).toContain('test-version')
    expect(result).not.toContain('关闭前消息')
    expect(result).not.toContain('关闭后消息')
    expect(setup.notifications).toEqual([true, false])
  })

  test('Given 持久化失败或无效值 When 切换 Then 运行状态保持关闭且不发更新', () => {
    const setup = fixture()
    const controller = setup.create()
    expect(() => controller.setEnabled('true')).toThrow()
    setup.failSave()
    expect(() => controller.setEnabled(true)).toThrow('权限不足')
    expect(controller.getState().enabled).toBe(false)
    expect(setup.notifications).toEqual([])
  })

  test('Given 保存取消或不可写目标 When 导出 Then 返回取消或抛出可处理错误', async () => {
    const setup = fixture()
    const controller = setup.create()
    setup.choose()
    expect((await controller.exportLogs()).status).toBe('cancelled')
    controller.setEnabled(true)
    controller.record({ level: 'log', values: ['用于导出'] })
    setup.choose(join(setup.directory, 'missing', 'out.log'))
    await expect(controller.exportLogs()).rejects.toThrow()
  })

  test('Given 外部窗口、子 frame、非法载荷 When 校验 Then 拒绝且只允许主窗口主 frame 和有界文本', () => {
    expect(isDiagnosticSender(1, 1, true)).toBe(true)
    expect(isDiagnosticSender(2, 1, true)).toBe(false)
    expect(isDiagnosticSender(1, 1, false)).toBe(false)
    expect(isDiagnosticSender(1, undefined, true)).toBe(false)
    expect(isDiagnosticRecord({ level: 'log', values: ['正常'] })).toBe(true)
    for (const input of [null, { level: 'debug', values: [] }, { level: 'log', values: [{}] }, { level: 'error', values: ['a'.repeat(16385)] }, { level: 'log', values: Array(21).fill('') }]) {
      expect(isDiagnosticRecord(input)).toBe(false)
    }
    const setup = fixture()
    const controller = setup.create()
    controller.setEnabled(true)
    expect(() => controller.record({ level: 'error', values: [new Error('invalid')] })).not.toThrow()
  })
})
