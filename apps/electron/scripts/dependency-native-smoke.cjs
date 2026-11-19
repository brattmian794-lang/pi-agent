/** 在 ELECTRON_RUN_AS_NODE=1 下运行，验证当前 Electron 与真实 PTY 二进制。 */
const assert = require('node:assert/strict')
const { appendFileSync } = require('node:fs')
const pty = require('node-pty')
assert.ok(process.versions.electron, '必须由 Electron 执行')
const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
})
let output = ''
let sent = false
const timer = setTimeout(() => { terminal.kill(); console.error('PTY 输入输出超时'); process.exit(1) }, 15_000)
terminal.onData(data => {
  output += data
  if (!sent) {
    sent = true
    terminal.write('echo PROMA_PTY_VERIFIED\r\nexit 0\r\n')
  }
})
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer)
  assert.equal(exitCode, 0)
  assert.match(output, /(?:\r?\n)PROMA_PTY_VERIFIED(?:\x1b\[|\r?\n)/, output)
  const result = JSON.stringify({ status: 'passed', electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, pid: terminal.pid, exitCode, output })
  if (process.argv[2]) appendFileSync(process.argv[2], `${result}\n`, 'utf8')
  console.log(result)
  // ConPTY 的后台句柄可能维持事件循环；终端退出和证据落盘后结束本次独立验证进程。
  process.exit(0)
})
