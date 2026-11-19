# 开发模式启动指南

本文适用于从源码启动 Proma（pi-agent），不用于安装发行版或打包发布。所有依赖与脚本统一使用 **Bun**，不要混用 npm / pnpm。

## 1. 环境准备

通用要求：

- Git、可用的桌面图形环境，以及当前稳定版 Bun（安装方法见 <https://bun.sh>）。安装后重新打开终端，确认 `bun --version` 能运行。仓库未声明 Bun 最低版本，本次脚本验证使用 Bun 1.4.4。
- 建议使用 Node.js 22 LTS；Electron 原生模块重建链会调用 Node 工具。用 `node --version` 确认。
- 网络能够访问依赖源、Electron 下载源及 GitHub Releases。首次启动可能下载 OfficeCLI，并构建原生辅助程序；准备阶段较慢不等于应用卡死。
- 将完整仓库克隆到本地。新入口支持中文和空格路径；若第三方原生工具报路径错误，可换到较短路径复现排查。

| 平台 | 补充要求 |
| --- | --- |
| Windows | PowerShell 5.1 或 PowerShell 7。Windows x64 的 node-pty 优先使用预构建产物；若不可用或使用其他架构，需要 Python 3 与 Visual Studio C++ Build Tools（含 Windows SDK）。 |
| macOS | 安装 Xcode Command Line Tools（`xcode-select --install`），准备 Python 3；原生辅助程序使用 `xcrun` / Swift，node-pty 可能需要编译。 |
| Linux | 推荐桌面版 Ubuntu/Debian，准备 Python 3、make、g++（例如 `sudo apt install python3 make g++`），并安装当前 Electron 所需的 GTK、NSS、音频等系统库。无 DISPLAY / Wayland 会话的纯服务器不能直接启动 GUI。安全与支持范围见 [Linux 说明](./linux.md)。 |

不要使用 `sudo` / 管理员权限作为常规启动方式，也不要为了启动而关闭 Electron sandbox。

## 2. 首次安装依赖

进入**仓库根目录**（包含本项目根 `package.json` 的目录）：

```sh
git clone https://github.com/brattmian794-lang/pi-agent.git
cd pi-agent
bun install
```

如果已拿到源码，跳过克隆。依赖有变化或切换分支后重新运行 `bun install`；依赖安装不由启动入口自动执行。

## 3. 预检与启动

### Windows PowerShell

在仓库根目录运行：

```powershell
# 仅检查，不启动 GUI、不下载资源
.\scripts\start-dev.ps1 --check

# 启动开发模式
.\scripts\start-dev.ps1
```

也可以从任意目录调用，路径有空格时使用调用运算符 `&`：

```powershell
& 'E:\项目开发\pi-agent\scripts\start-dev.ps1' --check
& 'E:\项目开发\pi-agent\scripts\start-dev.ps1'
```

如果组织策略禁止 `.ps1`，不要修改全局执行策略或绕过组织限制；可直接运行相同公共入口（同样禁用自动清理）：

```powershell
bun 'E:\项目开发\pi-agent\scripts\start-dev.ts' --check
bun 'E:\项目开发\pi-agent\scripts\start-dev.ts'
```

### macOS / Linux

在仓库根目录运行，无需赋予脚本可执行权限：

```sh
sh ./scripts/start-dev.sh --check
sh ./scripts/start-dev.sh
```

从其他目录调用时使用完整路径并加引号，例如：

```sh
sh '/home/user/开发 项目/pi-agent/scripts/start-dev.sh' --check
sh '/home/user/开发 项目/pi-agent/scripts/start-dev.sh'
```

所有入口支持 `--help`，不接受其他自定义参数。预检只检查关键 JS 依赖和 Electron 二进制是否存在，不保证原生 ABI、系统库、网络和 GUI 会话均可用。

### 启动后会发生什么

新入口最终在仓库根目录执行已有的 `bun run dev`，不另起一套构建流程：

1. 启动 Vite（固定 `127.0.0.1:5173`，端口占用即报错，不自动换端口）。
2. 同步开发用 runtime 依赖、准备 node-pty、构建平台原生辅助程序、准备 OfficeCLI 和资源。
3. 监听 main、agent-runtime、terminal-runtime、preload 的构建输出；等待首次 bundle 就绪后由 electronmon 启动 Electron。

**安全区别：**新入口设置 `PROMA_DEV_SKIP_CLEANUP=1`，跳过既有 `dev-kill.ts` 的自动进程清理，不会为了腾出端口杀掉其他应用。直接运行传统 `bun run dev` / `dev:kill` 仍沿用旧清理行为，不建议在同时运行其他 Electron 应用时使用这些命令。

首次成功应看到 Vite 地址、bundle 构建完成及桌面窗口。浏览器打开 Vite 不是完整应用，部分能力依赖 Electron preload / IPC。进入应用后通过设置配置模型渠道与凭据；启动脚本不需要或保存 API Key，也不自动改写用户配置。

## 4. 日常开发、热更新与停止

- 后续启动直接再次运行对应平台的启动入口；先停止旧的本项目开发实例，避免应用单实例锁或端口冲突。
- renderer 修改由 Vite 热更新；main / preload 编译产物变化触发 electronmon 重启。
- agent-runtime / terminal-runtime 有独立构建监听，但不在 electronmon 的重启列表中；需要重新启动应用/对应会话才能确保加载新 runtime，最稳妥的方式是停止后重新启动入口。
- 修改依赖、原生模块、构建脚本后，停止并重新安装/启动，不依赖热更新。
- 停止：在启动终端按 **Ctrl+C**，等待监听任务结束并关闭本次开发窗口。仅关闭窗口不一定会结束 Vite 和监听器。若有残留，仅在任务管理器/活动监视器中核实命令行与仓库路径后结束**本项目**进程；不要按 `electron` / `node` 名称批量终止。

## 5. 常见故障

| 现象 | 处理方式 |
| --- | --- |
| `Bun not found` / 未找到 Bun | 安装 Bun 后重开终端，确认 `bun --version`；检查 PATH，不要改用 npm。Windows PowerShell 5.1 的缺少 Bun 提示使用英文以避免无 BOM 的脚本编码影响显示。 |
| 依赖不完整 / 模块找不到 | 在仓库根运行 `bun install`，再执行 `--check`。不要从其他平台复制 node_modules。 |
| Electron 二进制缺失 / 安装脚本未完成 | 确认下载网络与代理后，根目录执行 `bun node_modules/electron/install.js`，再预检。若依赖本身缺失，先 `bun install`。 |
| 5173 端口被占用 | 先停止旧的本项目开发终端。Windows 用 `Get-NetTCPConnection -LocalPort 5173 -State Listen` 查看 PID，再通过 `Get-Process -Id <PID>` 核对；macOS/Linux 用 `lsof -nP -iTCP:5173 -sTCP:LISTEN`（需安装 lsof）。确认归属后自行停止该服务，不自动杀进程。 |
| node-pty ABI / 编译失败 | 确认对应系统原生工具链就绪；在 `apps/electron` 执行 `bun run rebuild:node-pty:dev`。切换架构/平台后重新安装依赖。 |
| OfficeCLI 下载失败 | 确认能访问 GitHub Releases，检查代理与证书后重试启动。不要关闭校验或下载不明二进制；该准备步骤会校验已有资源。 |
| macOS 原生辅助程序失败 | 检查 `xcode-select -p` 与 `xcrun --find swiftc`，确保命令行工具版本支持源码使用的系统 API。 |
| Linux 缺共享库 / 无法连接显示器 | 在实际桌面会话启动，根据报错补齐 Electron 依赖库；不要将禁用 sandbox 作为解决方案。 |
| electronmon 等待但无新窗口 | 确认旧开发应用已退出，检查前面的 bundle / 原生准备日志；停止旧终端后重启，不删除用户数据目录或批量终止其他 Electron 应用。 |

入口成功返回 0；缺少 Bun 返回 127，参数错误返回 2，预检/启动器异常返回 1；开发子命令失败时传回其退出码。执行失败时查看终端完整日志。

## 6. 开发检查与验证范围

在仓库根运行：

```sh
bun test scripts/start-dev.test.ts
bun run typecheck
```

macOS/Linux 测试默认使用 `/bin/sh` 验证 Shell 入口。Windows 如已安装 Git Bash，可显式指定其实际路径以运行 Shell 用例（否则这些用例跳过）：

```powershell
$env:DEV_TEST_SH = 'D:\Program Files\Git\bin\bash.exe'
bun test scripts/start-dev.test.ts
```

Shell 语法也可单独检查：`sh -n scripts/start-dev.sh`。

BDD 测试覆盖命令调度、中文空格路径、仅预检、缺失工程/依赖/Electron、无效参数和退出码；Windows 上还实际调用 PowerShell 入口。测试不启动真实 Electron，不下载第三方资源。

本次交付在 Windows 验证公共逻辑和 PowerShell 入口，并检查 Shell 语法/入口行为；macOS/Linux 的原生工具链、真实 Electron GUI、三平台 Ctrl+C 进程树退出仍需对应平台人工冒烟验证。`--check` 通过不能代替上述实测。
