import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import cp from 'node:child_process'
import * as installer from './ego-lite-installer'
import { createHash } from 'node:crypto'
import { createEgoLiteRun, ensureEgoLiteProfile, probeEgoLite } from './ego-lite-runtime'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticLog } from './diagnostic-log'
import { installDiagnosticConsole } from '../../lib/diagnostic-console'

const realSpawn = cp.spawn.bind(cp)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3XkAAAAASUVORK5CYII='
const profile = 'Proma-' + createHash('sha256').update('workspace').digest('hex').slice(0, 24)
const name = 'Proma-' + createHash('sha256').update(JSON.stringify(['workspace', 'session'])).digest('hex').slice(0, 24)
const secret = 'secret"; throw Error("bad") //\n%PATH%&'
// 使用真实管道和子进程，只替换启动入口及浏览器模型。探针与动作都执行生产端生成的脚本。
function browser(fault = '') {
  let calls = 0
  spyOn(installer, 'discoverEgoLiteCli').mockResolvedValue('fake-native-ego-browser')
  const spawn = spyOn(cp, 'spawn').mockImplementation(((_bin: string, _args: string[], options: cp.SpawnOptions) => {
    calls++
    const code = `
const source = await Bun.stdin.text();
const fault = ${JSON.stringify(fault)};
if (fault === 'stderr') console.log = (...args) => console.error(...args);
if (fault === 'hang') await new Promise(r=>setTimeout(r,30000));
if (fault === 'probe-error') { console.error('token-must-not-leak'); process.exit(9); }
if (fault === 'overflow') process.stderr.write('x'.repeat(1100000));
const ego = { getBrowserVersion: () => ({currentVersion:'0.5.0.5'}) };
const profile = {id:fault==='current-default'||fault==='default-id'?'Default':'Profile 2', name:${JSON.stringify(profile)}, isDefault:fault==='default'||fault==='current-default'};
const profiles = () => fault==='missing' ? [{...profile, name:'Personal'}]
  : fault==='duplicate' ? [profile,profile]
  : fault==='duplicate-id' ? [profile,{...profile,name:'Personal'}]
  : fault==='case-conflict' ? [profile,{...profile,id:'Profile 3',name:profile.name.toLowerCase()}]
  : [profile];
let exists = fault !== 'new' && !(fault === 'closed' && ${calls} === 2);
const entry = {id:7,name:${JSON.stringify(name)},profileId:fault==='wrong'?'Default':profile.id,ownership:fault==='takeover'?'agentDelegatedToUser':'agent'};
const listTaskSpaces = () => {
  if (['missing','duplicate','default','default-id','duplicate-id','case-conflict'].includes(fault)) throw Error('profile must be resolved before TaskSpace lookup');
  return !exists ? [] : fault==='ambiguous' ? [entry,{...entry,id:8}] : [entry];
};
const taskSpace = (id,opts) => {
  if (opts ? exists || id!==${JSON.stringify(name)} || opts.profileId!==profile.id : !exists || id!==7) throw Error('locator');
  exists = true;
  return {spaceId:7,handOff(){},page(label){if(label!=='p1') throw Error();return {
    goto(url){if(url!=='https://example.org/') throw Error()}, snapshot:()=> '@1 button', click(ref){if(ref!=='@1') throw Error()},
    fill(ref,value){if(ref!=='@1'||value!==${JSON.stringify(secret)}||fault==='lost') throw Error(value)},
    waitForSelector(s){if(s!=='text="done"') throw Error()}, screenshot({path}){return Bun.write(path,Buffer.from('${png}','base64'))}
  }}};
};
await Object.getPrototypeOf(async function(){}).constructor('ego','profiles','listTaskSpaces','taskSpace',source)(ego,profiles,listTaskSpaces,taskSpace);`
    return realSpawn(process.execPath, ['-e', code], {stdio:'pipe', env:options.env})
  }) as unknown as typeof cp.spawn)
  return { calls: () => calls, spawn }
}
const run = () => createEgoLiteRun('workspace', 'session', () => true)
afterEach(() => mock.restore())

describe('Ego Lite v2.2.1 结构化派发', () => {
  it('将打开、成功、关闭后不可用、停止及异常写入本地诊断，不记录页面或原始异常', async () => {
    const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'ego-diagnostics-'))
    const log = new DiagnosticLog(dir, { enabled: true })
    const restore = installDiagnosticConsole(console, (level, values) => log.write('main', level, values))
    const r = run()
    try {
      const cli = browser('closed')
      expect(await r.execute({kind:'observe'})).toBe('@1 button')
      await expect(r.execute({kind:'observe'})).rejects.toThrow('操作失败')
      expect(cli.calls()).toBe(2)
      r.stop()
      r.stop()
      const failing = run()
      spyOn(cp, 'spawn').mockImplementation(() => { throw new Error(secret) })
      await expect(failing.execute({kind:'fill',ref:'@1',value:secret})).rejects.toThrow('操作失败')
      const text = readFileSync(join(dir, 'diagnostic-0.log'), 'utf8')
      expect(text).not.toContain('@1 button')
      expect(text).not.toContain('%PATH%')
      expect(text).not.toContain('Profile 2')
      expect(text).toContain('[main] [error] ["[Ego Lite] action_failed"')
      const entries = text.trim().split(/\r?\n/).map(line => JSON.parse(line.slice(line.indexOf(' ["') + 1)) as [string, Record<string, unknown>])
      expect(entries.map(([event]) => event.replace('[Ego Lite] ', ''))).toEqual([
        'task_space_open_started', 'task_space_opened', 'action_succeeded', 'action_failed', 'dispatch_stopped',
        'task_space_open_started', 'task_space_open_unconfirmed', 'action_failed', 'dispatch_stopped',
      ])
      const runId = entries[0]![1].runId
      expect(entries[1]![1]).toMatchObject({ runId, spaceId: 7, mode: 'reused', profileMode: 'workspace' })
      expect(entries[2]![1]).toMatchObject({ runId, action: 'observe', durationMs: expect.any(Number) })
      expect(entries[3]![1]).toMatchObject({ runId, spaceId: 7, reason: 'task_space_missing' })
      expect(entries[4]![1]).toMatchObject({ runId, reason: 'failure' })
      expect(entries[7]![1]).toMatchObject({ reason: 'unexpected_error' })
      expect(entries[7]![1].runId).not.toBe(runId)
    } finally {
      r.stop()
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('诊断输出异常不改变返回值或停止行为', async () => {
    browser('new')
    spyOn(console, 'info').mockImplementation(() => { throw new Error('日志不可用') })
    const r = run()
    try { expect(await r.execute({kind:'observe'})).toBe('@1 button') } finally { r.stop() }
  })
  it('兼容真实 CLI 从 stderr 返回版本结果', async () => {
    browser('stderr')
    expect(await probeEgoLite()).toBe('0.5.0.5')
  })
  it('返回客户端版本，同一会话使用数字 space 和 p1，交接后停止', async () => {
    const cli = browser()
    expect(await probeEgoLite()).toBe('0.5.0.5')
    const r = run()
    try {
      expect(await r.execute({kind:'navigate',url:'https://example.org'})).toBe('ok')
      expect(await r.execute({kind:'observe'})).toBe('@1 button')
      await expect(run().execute({kind:'observe'})).rejects.toThrow('占用')
      await r.execute({kind:'click',ref:'@1'})
      expect(await r.execute({kind:'fill',ref:'@1',value:secret})).toBe('ok')
      await r.execute({kind:'wait',text:'done'})
      expect(await r.execute({kind:'screenshot'})).toBe(png)
      await r.execute({kind:'handoff'})
      await expect(r.execute({kind:'observe'})).rejects.toThrow('停止')
      expect(cli.calls()).toBe(8)
    } finally { r.stop() }
  })
  it('连接检查失败显示明确原因，不泄露 CLI 原始错误', async () => {
    browser('probe-error')
    await expect(probeEgoLite()).rejects.toThrow('首次引导')
    await expect(probeEgoLite()).rejects.not.toThrow('token-must-not-leak')
  })
  for (const fault of ['wrong','takeover','ambiguous','lost','overflow']) {
    it(`遇到 ${fault} 时停止，不泄露填充值或重放`, async () => {
      const cli = browser(fault)
      const r = run()
      await expect(r.execute({kind:'fill',ref:'@1',value:secret})).rejects.toThrow(fault==='overflow'?'超限':'Ego Lite 操作失败，结果可能未知，请检查浏览器。')
      await expect(r.execute({kind:'click',ref:'@1'})).rejects.toThrow('停止')
      expect(cli.calls()).toBe(1)
    })
  }
  it('同名 space 不存在时才用显式 Profile 创建', async () => {
    browser('new')
    const r = run()
    try { expect(await r.execute({kind:'observe'})).toBe('@1 button') } finally { r.stop() }
  })
  it('安装校验可复用同一 Profile，不创建 TaskSpace；首次操作仍独立检查绑定', async () => {
    const cli = browser('new')
    const signal = new AbortController().signal
    await expect(ensureEgoLiteProfile('workspace', signal)).resolves.toBeUndefined()
    await expect(ensureEgoLiteProfile('workspace', signal)).resolves.toBeUndefined()
    const r = run()
    try { expect(await r.execute({kind:'observe'})).toBe('@1 button') } finally { r.stop() }
    expect(cli.calls()).toBe(3)
  })
  for (const fault of ['missing','duplicate','default','default-id','duplicate-id','case-conflict']) {
    it(`安装校验和首次操作均拒绝 ${fault}，且不触碰 TaskSpace`, async () => {
      browser(fault)
      const expected = new RegExp((fault === 'missing' ? '缺少工作区专属 Profile' : 'Profile 冲突') + '.*' + profile)
      await expect(ensureEgoLiteProfile('workspace', new AbortController().signal)).rejects.toThrow(expected)
      await expect(run().execute({kind:'observe'})).rejects.toThrow(expected)
    })
  }
  it('复用现有默认 Profile，不要求创建工作区 Profile', async () => {
    browser('current-default')
    await expect(ensureEgoLiteProfile('workspace', new AbortController().signal, 'current')).resolves.toBeUndefined()
    const r = createEgoLiteRun('workspace', 'session', () => true, 'current')
    try { expect(await r.execute({kind:'observe'})).toBe('@1 button') } finally { r.stop() }
  })
  it('Profile 校验支持启动前和在途取消；取消后可重试', async () => {
    const cli = browser('hang')
    await expect(ensureEgoLiteProfile('workspace', AbortSignal.abort())).rejects.toThrow('停止')
    expect(cli.calls()).toBe(0)
    const controller = new AbortController()
    const pending = ensureEgoLiteProfile('workspace', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('停止')
    mock.restore()
    browser()
    await expect(ensureEgoLiteProfile('workspace', new AbortController().signal)).resolves.toBeUndefined()
  })
  it('CLI 环境仅包含操作系统白名单', async () => {
    const cli = browser()
    const keys = ['NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'PROMA_TEST_TOKEN']
    const saved = keys.map(k => process.env[k])
    try {
      for (const key of keys) process.env[key] = 'canary'
      await probeEgoLite()
      const opts = cli.spawn.mock.calls[0]![2]!
      const env = opts.env!
      const allowed = process.platform === 'win32' ? ['SystemRoot','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP'] : ['HOME','TMPDIR']
      expect(Object.keys(env).sort()).toEqual(allowed.filter(k => process.env[k] !== undefined).sort())
      for (const key of keys) expect(env[key]).toBeUndefined()
      expect(opts.shell).toBe(false)
    } finally {
      keys.forEach((key,i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    }
  })
  it('未找到原生 CLI 时拒绝启动进程', async () => {
    const cli = browser()
    spyOn(installer, 'discoverEgoLiteCli').mockResolvedValue(undefined)
    await expect(probeEgoLite()).rejects.toThrow('找不到可安全调用')
    expect(cli.calls()).toBe(0)
  })
  it('取消在途命令后不再派发', async () => {
    const cli = browser('hang')
    const r = run()
    const c = new AbortController()
    const pending = r.execute({kind:'click',ref:'@1'}, c.signal)
    await Promise.resolve() // 等待已完成的异步 CLI 查找后再模拟在途取消。
    const child = cli.spawn.mock.results[0]!.value as cp.ChildProcess
    // 模拟系统已收到终止请求，但还没有关闭管道。
    const kill = spyOn(child,'kill').mockReturnValue(true)
    c.abort()
    try {
      await Promise.resolve()
      await expect(run().execute({kind:'observe'})).rejects.toThrow('占用')
      expect(kill).toHaveBeenCalledWith('SIGKILL')
    } finally { kill.mockRestore(); child.kill('SIGKILL') }
    await expect(pending).rejects.toThrow('已送达的写操作结果未知')
    await expect(r.execute({kind:'observe'})).rejects.toThrow('停止')
  })
  it('超过截止时间后停止，即使写操作尚未返回', async () => {
    const cli = browser('hang')
    const r = run()
    await expect(r.execute({kind:'click',ref:'@1'})).rejects.toThrow('超时')
    await expect(r.execute({kind:'observe'})).rejects.toThrow('停止')
    expect(cli.calls()).toBe(1)
  }, 25000)
  it('禁用、非法定位符和主动停止不启动 CLI', async () => {
    const cli = browser()
    await expect(createEgoLiteRun('w','s',()=>false).execute({kind:'observe'})).rejects.toThrow('停止')
    await expect(run().execute({kind:'click',ref:'javascript:alert(1)'})).rejects.toThrow('参数')
    const r = run()
    r.stop()
    await expect(r.execute({kind:'observe'})).rejects.toThrow('停止')
    expect(cli.calls()).toBe(0)
  })
})
