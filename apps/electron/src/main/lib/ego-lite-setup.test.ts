import { describe, expect, it, mock } from 'bun:test'
import { createEgoLiteSetup } from './ego-lite-setup'
import type { EgoSetupState } from '@proma/shared'

const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function fixture() {
  const records: EgoSetupState[] = []
  return {
    install: mock(async (_signal: AbortSignal, report: (stage: 'downloading', message: string, percent?: number) => void) => { report('downloading', '下载中', 38) }),
    verify: mock(async () => '1.2.3'),
    configure: mock(async (_id: string) => {}),
    enable: mock(() => {}),
    save: (state: EgoSetupState) => { records.push(state) },
    load: () => records.at(-1) ?? null,
    records,
  }
}

describe('一键准备外部浏览器', () => {
  it('重复点击复用同一任务，完成连接与配置才保存开关', async () => {
    const steps = fixture()
    const setup = createEgoLiteSetup(steps)
    setup.start('workspace')
    expect(setup.start('workspace')).toMatchObject({ stage: 'downloading', percent: 38 })
    expect(steps.install).toHaveBeenCalledTimes(1)
    expect(steps.enable).not.toHaveBeenCalled()
    await nextTurn()
    expect(setup.status().stage).toBe('ready')
    expect(steps.configure).toHaveBeenCalledTimes(1)
    expect(steps.enable).toHaveBeenCalledTimes(1)
  })
  it('取消期间等待旧操作退出，随后重试可成功', async () => {
    const steps = fixture()
    let release!: () => void
    steps.install.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const setup = createEgoLiteSetup(steps)
    setup.start('a'); setup.cancel(); setup.start('a')
    expect(setup.status().stage).toBe('cancelling')
    expect(steps.install).toHaveBeenCalledTimes(1)
    release(); await nextTurn()
    expect(setup.status().stage).toBe('cancelled')
    expect(steps.enable).not.toHaveBeenCalled()
    setup.start('a'); await nextTurn()
    expect(setup.status().stage).toBe('ready')
  })
  it.each(['网络异常', '安装目录权限不足', '工作区配置冲突'])('%s 保留原设置，用户可重试', async message => {
    const steps = fixture()
    if (message === '工作区配置冲突') steps.configure.mockRejectedValueOnce(new Error(message))
    else steps.install.mockRejectedValueOnce(new Error(message))
    const setup = createEgoLiteSetup(steps)
    setup.start('a'); await nextTurn()
    expect(setup.status()).toMatchObject({ stage: 'failed', message })
    expect(steps.enable).not.toHaveBeenCalled()
    setup.start('a'); await nextTurn()
    expect(steps.enable).toHaveBeenCalledTimes(1)
  })
  it('重启后识别中断任务，重新检测，无工作区时延后配置', async () => {
    const steps = fixture()
    steps.records.push({ stage: 'installing', message: '安装中' })
    const setup = createEgoLiteSetup(steps)
    expect(setup.status().message).toContain('中断')
    expect(steps.install).not.toHaveBeenCalled()
    setup.start(); await nextTurn()
    expect(steps.configure).not.toHaveBeenCalled()
    expect(setup.status().stage).toBe('ready')
  })
})
