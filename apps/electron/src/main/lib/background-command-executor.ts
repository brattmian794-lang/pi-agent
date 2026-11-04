import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentRuntimeEnv } from './agent-runtime-env'
import { mergeRuntimeEnv } from './agent-runtime-env'
import { WINDOWS_BACKGROUND_RUNNER } from './background-command-windows-runner'

export interface BackgroundCommandExecution {
  ready: Promise<number>
  exited: Promise<{ exitCode: number | null; error?: string }>
  stop(): Promise<void>
}
export interface BackgroundCommandExecutionInput {
  command: string
  cwd: string
  runtimeEnv?: AgentRuntimeEnv
  onOutput(text: string): void
}
export function quoteShell(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}
function wslPath(value: string): string {
  return value.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/')
}
function wslArgs(runtime: AgentRuntimeEnv): string[] { return runtime.wslDistro ? ['--distribution', runtime.wslDistro] : [] }
async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}
async function runControl(executable: string, args: string[]): Promise<void> {
  await within(new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`进程组控制失败（${code}）`)))
  }), 5_000, '进程组控制超时')
}

/** 本次启动的 Job/进程组持有控制权，绝不从磁盘旧 PID 恢复控制权。 */
export function executeBackgroundCommand(input: BackgroundCommandExecutionInput): BackgroundCommandExecution {
  const runtime = input.runtimeEnv
  const marker = `PROMA_READY_${randomUUID().replace(/-/g, '')}`
  const env = mergeRuntimeEnv(process.env, runtime?.env)
  const isWsl = process.platform === 'win32' && runtime?.shellKind === 'wsl'
  const isWindowsJob = process.platform === 'win32' && !isWsl
  const bashCommand = `${input.command}\n__proma_status=$?\nwait\nexit "$__proma_status"`
  // 使用 echo 输出一行控制记录，避免不同 Shell 对 printf 转义的差异。
  const announce = `echo ${quoteShell(marker)}:"$$" >&2\n`
  let executable: string
  let args: string[]
  if (isWsl) {
    executable = runtime.wslCommand ?? 'wsl.exe'
    const exports = Object.entries(runtime.env).map(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      ? `export ${key}=${quoteShell(key === 'PROMA_CLI' ? wslPath(value) : value)}` : '').join('\n')
    args = [...wslArgs(runtime), '--cd', wslPath(input.cwd), '--exec', 'setsid', '--wait', 'bash', '-c', `${announce}${exports}\n${bashCommand}`]
  } else if (isWindowsJob) {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const shell = runtime?.shellKind === 'git-bash' ? runtime.shellPath ?? 'bash.exe' : powershell
    const shellArgs = runtime?.shellKind === 'git-bash' ? ['-c', bashCommand]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-InputFormat', 'Text', '-EncodedCommand',
        Buffer.from(`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);\n${input.command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`, 'utf16le').toString('base64')]
    env.PROMA_BG_EXECUTABLE = shell
    env.PROMA_BG_ARGUMENTS = Buffer.from([shell, ...shellArgs].map(quoteWindowsArgument).join(' '), 'utf8').toString('base64')
    env.PROMA_BG_CWD = input.cwd
    env.PROMA_BG_MARKER = marker
    executable = powershell
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-InputFormat', 'Text', '-EncodedCommand', Buffer.from(WINDOWS_BACKGROUND_RUNNER, 'utf16le').toString('base64')]
  } else {
    executable = runtime?.shellPath ?? '/bin/bash'
    args = ['-c', `${announce}${bashCommand}`]
  }
  const child = spawn(executable, args, { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWindowsJob && !isWsl, windowsHide: true })
  child.stdin.on('error', () => { /* 退出与停止请求可能同时发生 */ })
  if (!isWindowsJob) child.stdin.end()
  let readyPid: number | undefined
  let resolveReady!: (pid: number) => void
  let rejectReady!: (error: Error) => void
  let finished = false
  let resultError: string | undefined
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stderr = ''
  child.stdout.on('data', (data: Buffer) => input.onOutput(stdoutDecoder.write(data)))
  const consumeStderr = (flush = false): void => {
    let index: number
    while ((index = stderr.indexOf('\n')) >= 0 || (flush && stderr.length > 0)) {
      const line = index >= 0 ? stderr.slice(0, index + 1) : stderr
      stderr = index >= 0 ? stderr.slice(index + 1) : ''
      const prefix = `${marker}:`
      const value = line.trim().startsWith(prefix) ? Number(line.trim().slice(prefix.length)) : NaN
      if (Number.isSafeInteger(value) && value > 0) { readyPid = value; resolveReady(value) }
      else if (!line.startsWith('#< CLIXML')) input.onOutput(line)
    }
    if (stderr.length > 4096) { input.onOutput(stderr); stderr = '' }
  }
  child.stderr.on('data', (data: Buffer) => { stderr += stderrDecoder.write(data); consumeStderr() })
  const exited = new Promise<{ exitCode: number | null; error?: string }>((resolve) => {
    child.once('error', (error) => { resultError = error.message; rejectReady(error) })
    child.once('close', (exitCode) => {
      finished = true
      stderr += stderrDecoder.end()
      consumeStderr(true)
      const tail = stdoutDecoder.end()
      if (tail) input.onOutput(tail)
      if (!readyPid) rejectReady(new Error(resultError ?? `后台进程启动失败（${exitCode}）`))
      resolve({ exitCode, error: resultError })
    })
  })
  const readyWithTimeout = within(ready, 15_000, '后台进程启动超时')
  return {
    ready: readyWithTimeout, exited,
    async stop() {
      if (finished) return
      if (isWindowsJob) {
        if (!child.stdin.writable) throw new Error('后台进程控制通道已断开')
        child.stdin.write('stop\n')
      } else if (isWsl) {
        const pid = await readyWithTimeout
        await runControl(runtime.wslCommand ?? 'wsl.exe', [...wslArgs(runtime), '--exec', 'bash', '-c', `kill -KILL -- -${pid}`])
      } else {
        if (!child.pid) throw new Error('后台进程尚未启动')
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if (!finished && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await within(exited, 10_000, '等待受管进程树退出超时')
    },
  }
}
