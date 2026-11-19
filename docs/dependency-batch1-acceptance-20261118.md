# 依赖升级第一批验收记录（2026-11-18）

当前结论：**第一批绝大多数可执行验收已完成；仍有真实 Windows Authenticode 集成与中文 IME/UI 交互缺证，故不进入第二批，也不宣称全部验收关闭。** 本轮修复测试夹具隔离和本地 updater feed，完成专用测试 appId 下的下载、正常 NSIS 更新重启及恢复场景。正式安装目录、正式卸载注册项均未修改。

## 基线与环境

- 基线：`main`，`e29779b98b50cce0ebe76a0c1da9ccd231f1a5e2`（`v0.19.73-beta.1`）；所有检查在该提交加当前工作区上执行，未提交。
- Windows `10.0.26200.9974` x64；Bun `1.4.4`；宿主 Node `22.20.0`；Electron `43.2.0` / 内置 Node `24.18.0`。
- 保留原有未提交修改：`AGENTS.md`、`README.md`、`apps/electron/scripts/dev-kill.ts`、根 `package.json` 及未跟踪 `.pi/`、计划/开发文档和 `scripts/`；本轮未覆盖这些内容。
- 依赖版本未变更；Electron patch 因本轮工程/验证代码更新为 `0.19.75-beta.1`，与 `bun.lock` workspace 元数据一致。

## 按批准契约逐项验收

| 验收条款 | 状态 | 本轮实际证据 |
|---|---|---|
| 原报告的 5 项失败已修复/替代 | 已满足（Windows 可执行范围） | Planning Electron SQLite、项目指令 junction 边界、updater junction、确定性持久化失败、删除拒绝后重试用例均通过；本轮 controller 10/10、updater cache 9/9。Windows 文件级 symlink 仍受 `EPERM` 限制；使用无特权 junction 验证主要链接边界。 |
| 全量测试、类型检查和 Electron 构建 | 已满足 | 最终 `bun test`：609 pass、5 skip、0 fail，614 项/92 文件/1447 断言；`bun run typecheck`、updater typecheck、`bun run electron:build` 均退出 0。5 个 skip 是原有 POSIX/Git Bash 平台条件，报告后文列明。 |
| Markdown/HTML、ZIP/XML、图片和文档异常输入 | 已满足（定向范围） | 浏览器 HTML 清洗 5 项通过；新增解析测试 15 项通过。ZIP/XML/Sharp 私有辅助逻辑的库级用例与产品 `resolveTargetPath`、`extractTextFromFile` 测试边界见下文。 |
| updater 下载/失败恢复、native、编辑器交互与 IME | 部分满足 | v5 normal、install-failure、agent-guard、cancel-install、startup-recovery、cleanup、interrupted、corrupt、offline、disk-full、no-update 结构化报告通过；invalid-signature 拒绝路径通过显式注入，真实 Authenticode 子进程集成未通过（Windows 环境阻断）。node-pty Electron 冒烟通过；两个 native helper 仅支持 macOS。CodeMirror 基础输入/焦点/滚动通过；真实中文 IME 与完整产品编辑器交互未能在隔离 GUI 实测。 |
| 基线、环境、日志、版本复核和回退范围 | 已满足 | 日志、逐场景报告、源文件哈希与 diff 归档于 `apps/electron/out/dependency-batch1-acceptance-20261118/`，该目录被忽略且不自动共享。scratch 保留 v5 包和测试目录。 |
| diff、用户改动、版本和锁文件一致 | 已满足 | diff check 通过；根和包依赖声明及 22 个第一批直接依赖解析与锁版本匹配；Electron 版本 `0.19.73 → 0.19.75-beta.1`，锁文件同步。 |

## 修复与新增验证

### 原有 5 项失败

1. `planning-manager.test.ts`：不再读取可能被其他用例 mock 的 `require('electron')` 返回值；从 `electron/package.json` 定位包目录，读取 `path.txt`，验证二进制存在后执行。子进程设置 `HOME` 与 `USERPROFILE`，增加进程错误检查、30 秒子进程期限及 40 秒测试期限。真实 SQLite 事务、隔离、提醒与版本冲突断言保留。
1. `planning-manager.test.ts`：从 Electron 包 `path.txt` 解析二进制，规避全量测试 mock 污染；子进程显式使用 HOME/USERPROFILE 隔离，保留 SQLite 回归。
2. `project-instruction-resolver.test.ts`：POSIX 保留文件 symlink；Windows 用 junction 验证根规范化、越界目标及 AGENTS 目录链接拒绝。文件 symlink 权限不足未提权。
3. updater 链接路径使用 junction/dir 并断言 lstat/realpath；状态持久化失败改为普通文件阻塞父目录；删除失败使用实例级 unlink 注入，检查失败保留并重试成功。未增加跳过或移除断言。

### 解析定向测试的覆盖边界

ZIP/XML 和图像覆盖的私有辅助路径有部分库级断言，不等价于 OfficeCLI、完整 Office 文件链路或真实签名行为集成验收。

- adm-zip / JSZip：跨库压缩读写、Unicode/空文件/二进制、CRC 读取、路径条目归一化、损坏和截断 ZIP 拒绝。这是内存读写，**未验证磁盘解压器完整防穿越链路**。
- 产品 `resolveTargetPath`：根内点路径、父目录越界、Windows 两种分隔符与 NUL。
- xmldom：命名空间、CDATA、实体、Unicode、异常 XML 诊断、SYSTEM 文件实体不展开。这是库级用例，不代表所有产品 XML 调用都会拒绝容错结果。
- sharp：透明 PNG 转白底 JPEG，检查尺寸、格式及完整解码像素；伪造和截断图像拒绝。操作与产品私有归一化路径相同，未调用依赖模型配置/网络的视觉入口。
- 产品 `extractTextFromFile`：真实 DOCX 多段/格式 run/表格/顺序、XLSX 多行/共享字符串/数字，损坏 Office 包与缺少 Word 主文档时拒绝。
- 探测还观察到既有保真限制：DOCX 的 `w:br` 分隔符会丢失，officeparser `4.2.0` 对 XLSX 共享富文本只提取首个 run。测试与本记录明确保留这些限制，不把内容存在解释为完整格式保真，也不在本轮升级第二批解析库。

### 浏览器与 native

浏览器依赖验证页使用 MarkdownIt、DOMPurify 和 CodeMirror。实际 Chromium 检查：安全 Markdown/HTML 内容和 HTTPS 链接保留；script/iframe/style、事件属性、内联样式、javascript URL、编码危险协议和 SVG 事件被清除。CodeMirror 聚焦、滚动至文末及 CDP 文本插入 `input` 事件通过。文本插入不代表 IME composition。

曾尝试以独立 Edge profile 和一次性 Electron BrowserWindow shell 实测中文 IME；Edge 未生成可定位的独立窗口，Electron shell 进程退出且未出现窗口。唯一可见 Edge 属用户配置，未操作。故真实中文候选/提交、compositionend 和产品编辑器组合行为未验收。

`node-pty` 在 Electron `43.2.0` / Node `24.18.0` 中真实创建 cmd.exe、输入命令、收取标记输出并以 exit 0 结束。验证脚本在输出归档后显式退出，不能据此声称后台 ConPTY 句柄自然释放已验证。Agent Island / EventKit helper 构建脚本明确仅限 macOS，Windows 为不适用。

## 实际命令及退出码

工作目录为仓库根，除非另注。日志已从本会话 scratch 归档至 `apps/electron/out/dependency-batch1-acceptance-20261118/`；该目录不入 Git，不随本文自动共享。安装包体积较大，留在会话 scratch 的 `batch1-fixtures/` 与 `batch1-fixtures-v2/`，本文和归档日志记录 SHA-256；会话删除时 scratch 工件会被删除。

| 命令 | 退出码 / 结果 | 日志 |
|---|---|---|
| `bun test`（最终） | 0；609 pass、5 skip、0 fail；614 项/92 文件/1447 断言 | `bun-test-final-continued.log` |
| `bun run typecheck` | 0；6 个 workspace | `typecheck-final-continued.log` |
| `bun run --filter='@proma/electron' typecheck:updater` | 0 | `updater-typecheck-final-continued.log` |
| `bun run electron:build` | 0；Vite renderer 5761 modules | `electron-build-final-continued.log` |
| updater controller/cache focused tests | controller 10 pass；cache cleanup 9 pass | `controller-test-clean.log`、`updater-focused-postfix.log` |
| updater 旧版隔离复制测试 | 10 pass、0 fail（含 Windows fixture copy） | `controller-test-clean.log` |
| v5 normal 更新 | 0；0.19.0-test.1 → 0.20.0-test.1；下载哈希、NSIS 安装替换、不同 PID 外控重启均通过 | `updater/normal-v5/` |
| v5 install-failure | 0；安装失败后旧版恢复 | `updater/install-failure-v5/` |
| v5 agent-guard | 0；Agent 活跃保护、空闲后真实安装及新版重启通过 | `updater/agent-guard-v5/` |
| v5 cancel-install / startup-recovery / cleanup | 三场景 0；取消不安装，注入退出码 23 后可恢复新版；owned-root 清理保留 sentinel | 对应 `updater/{cancel-v5,startup-recovery-v5,cleanup-v5}/` |
| v5 interrupted/corrupt/offline/disk-full/no-update | 五场景均 0；响应断流、SHA-512 损坏、连接拒绝、ENOSPC、无新版状态均按预期处理 | `updater/fault-*-v4b/` |
| v5 invalid-signature 注入场景 | 0；真实 feed 下载后由测试 harness 注入签名拒绝，updater 错误状态/恢复通过 | `updater/signature-injection-v5/` |
| Windows 原生 Authenticode signature 场景 | 阻断，见下 | `updater/fault-invalid-signature-v4b/`、`verify-authenticode.log` |
| 工作区 manifest/lock 对照和 22 个直接版本解析 | 0；无偏差 | `manifest-check-final.log`、`installed-check-final.log` |
| NSIS / appId隔离 | normal v5 使用新 appId `com.proma.updater.test.batch1`，测试注册项与正式 `Proma 0.22.97` 分离 | `fixture-v5-*.log`、各 v5 报告 |
5 个跳过项分别为 3 项 POSIX Shell 用例（Windows 且未设 `DEV_TEST_SH`）及 2 项真实 Git Bash 跨会话用例（未设 `PROMA_TEST_GIT_BASH`）；均为既有平台门控，不计通过。
复现浏览器验证：将配套 HTML 复制到独立临时目录，以 `dependency-browser-check.js` 为输出文件名打包 TS，然后在实际浏览器打开 HTML。页面显示自动检查和输入事件；真实中文 IME 仍需实际选择候选并提交，检查可信 composition 事件。避免把持续写入的测试日志放在 BrowserPreview 页面同一目录，防止 live reload 重置输入状态。

### 5 个跳过项

| 用例 | 明确跳过前提 |
|---|---|
| POSIX Shell：从其他目录调用中文空格路径并 `--check` | 当前 Windows，未设置 `DEV_TEST_SH` |
| POSIX Shell：缺少 Bun 返回 127 | 同上 |
| POSIX Shell：无效参数非零退出 | 同上 |
| 两个真实 Git Bash HTTP 服务的跨会话隔离停止 | 未设置 `PROMA_TEST_GIT_BASH`；需要 Git Bash 与 Python/curl 环境 |
| Shell 命令自然失败保留退出码及输出 | 未设置 `PROMA_TEST_GIT_BASH` |

以上均为原有平台/显式环境门控，本轮未新增跳过，不计为通过。Windows PowerShell 对应用例实际通过。

## 第一批版本复核

registry 精确查询和安装解析复核均成功：第一批 22 个直接依赖按所属 workspace 与 lockfile 解析版本逐项匹配。DOMPurify `3.4.18`、PostCSS `8.5.33`、Slack Web API `8.4.0` 高于计划目标但同主版本；字体延后和可选 Radix 试点不在本批必需项。完整列表与旧 runtime-sync 遮蔽目录处理见前版验收记录上文归档。

锁定版本：Jotai `2.20.3`；DOMPurify `3.4.18`；adm-zip `0.5.18`；xmldom `0.8.15`；JSZip `3.10.2`；semver `7.8.6`；node-addon-api `8.9.2`；CodeMirror language/state/view `6.13.1/6.7.6/6.43.15`；highlight.js `11.12.0`；Shiki 两个 workspace `3.23.0`；markdown-it `14.3.3`；PostCSS `8.5.33`；Autoprefixer `10.6.2`；concurrently `9.2.5`；electron-updater `6.8.11`；rebuild `4.2.1`；Undici `7.30.2`；Zod `4.6.7`；Slack `8.4.0`；飞书 SDK `1.76.0`。字体和可选 Radix 试点不列为本批阻断，不执行第二批升级。

22 个目标版本均通过 registry 精确查询；随后按各依赖所属 workspace 核对实际解析安装版本与锁记录，**22/22 直接依赖均匹配**。命令为 `bun "$env:PI_SCRATCH_DIR\installed-check.mjs"`，退出 0。DOMPurify `3.4.18`、PostCSS `8.5.33`、Slack Web API `8.4.0` 高于原计划目标，均为同主版本；版本存在性已复核，不能单凭查询通过推断全部功能兼容。

第一次解析核验发现 runtime dependency sync 在 `apps/electron/node_modules` 留下 node-addon-api `7.1.1`、Undici `8.10.2`、semver `7.8.5` 目录，遮蔽直接依赖锁定版本；highlight.js 按其所属 workspace `packages/core` 核对。执行 `bun install --force --frozen-lockfile --ignore-scripts` 后，确认并将三个由 sync 生成的遮蔽目录移至 session scratch 备份区；根依赖安装内容未修改，随后 22/22 按 owner workspace 解析通过。备份保留于 scratch `runtime-shadow-backups`，不删除；第二次全量测试/类型检查/构建均在正确解析和恢复后的 Electron 二进制下通过。其他旧 semver/highlight.js 记录是传递依赖，不等于直接版本漂移。

## 真实 updater 验证
v5 使用新 appId `com.proma.updater.test.batch1` 重新构建旧/新包。normal 实际从本地 HTTP feed 下载 216,050,578 字节，feed 记录完整响应；electron-updater 下载完成且 SHA-256 一致，NSIS 将 scratch-owned install 目录替换为目标 ASAR，外控确认新版 `0.20.0-test.1` 且 PID 改变。报告 `restartedVersion` 与目标一致。

随后 v5 的 install-failure、agent-guard、cancel-install、startup-recovery、cleanup 均通过；interrupted、corrupt（正确长度的 22-byte 损坏内容并由 SHA-512 mismatch 拒绝）、offline、disk-full、no-update 也均通过。场景报告、事件和日志完整归档在表列目录。

复核 Windows NSIS 注册复用是关键：旧批次共用 appId 会让多轮 silent install 争用卸载注册项。v5 采用全新 batch appId；每次安装后先归档报告，再仅对 owner marker 确认位于 session scratch 的 PromaUpdaterTest 卸载注册项做备份和移除，保持重复场景互相隔离。正式 Proma 进程、exe、asar 时间戳与正式卸载注册项在每轮前后均未变化。本轮未运行正式 updater feed，也未将其指向测试 feed。

v4b normal 的早期失败是安装目录/注册项复用导致验收脚本检查错误。v5 的目标隔离目录真实 NSIS 替换及新版重启已通过；不再将旧批次失败作为当前产品更新失败结论。
修正版真实运行结果：`isolated-v2/proma-updater-tests/run-ctbVt6` 的 normal 报告为 **failed**。初始 NSIS 安装超过 240 秒，控制器中止安装器，错误为“旧版安装超时”，未到达应用启动步骤。宿主进程查询曾看到“PromaUpdaterTest 安装”窗口，但桌面工具无法定位该窗口，无法读取提示并在隔离边界内排除阻断。未放宽环境白名单或使用普通用户环境强行重试；安装失败恢复、启动失败恢复及清理场景因共享初装前提失败而未执行，不记为通过。首轮 normal 的新版启动超时根因仍未确认，不能归因于依赖升级。结束时核对无本次测试应用或初装安装器残留进程。

## 本轮改动与回退边界

本轮修改的既有文件：Electron `package.json`、`bun.lock`；Planning/项目指令/updater 缓存清理测试及缓存清理实现；updater 测试的 `controller.ts`、`controller.test.ts`、`run.ts`、`build-fixtures.ts`。

新增：解析回归测试、浏览器 TS/HTML 验证入口、PTY 验证入口及本文。生成的构建、运行时同步、专用安装包和验证日志是本地验证输出。

回退只针对上述本轮文件及具体 hunks：原本干净的既有文件可在确认本轮之后无人追加修改时按路径恢复到基线；删除新增验证文件即可撤销本轮工具。不得执行整仓 `reset` / `clean`，不得恢复或删除原有的 AGENTS、README、开发脚本、根 package 或未跟踪文档/脚本。已装测试包的清理只允许本次拥有且带 marker 的测试目录，不清理普通应用或其他会话目录。

## 遗留阻断

- 系统中文 IME 候选选择与提交、完整产品编辑器的实际交互未得到通过证据。
- 真实 updater 首轮 normal 新版启动超时；隔离修正版 normal 初装 240 秒超时。依赖初装的恢复与清理场景无法验收，安装器窗口对桌面工具不可用，根因未确认。
- Windows 文件级软链接的原始场景受 `EPERM` 限制；已用实际 junction 覆盖主要平台链接边界，但不把两者描述为完全等价。

- 未执行 macOS/Linux 冒烟或签名 staging，不作跨平台发布结论；Windows 构建明确跳过仅限 macOS 的 Agent Island 与 EventKit native helper。

- Windows 真实 Authenticode 检查仍阻断：专用 v4b 的 electron-updater 子进程停在 `Verifying signature`，超时未产生错误事件。对同一隔离临时包执行 PowerShell `Get-AuthenticodeSignature` 返回 `NotSigned`（1.4 秒）；相同 Electron 子进程的隔离复现也返回 JSON `Status: 2`（约 2.8 秒），因此 verifier 挂起原因未确认。v5 `invalid-signature` 通过显式测试注入验证 updater 错误分支，但不冒充真实 Authenticode 集成通过。用例/日志已归档并标记 unmet。
- 系统中文 IME 候选选择、compositionend 和完整产品编辑器交互未得到真实 GUI 证据；独立 GUI 窗口不可用。不能以 CDP `Input.insertText` 代替。
- Windows 文件级 symlink 创建受 `EPERM` 限制；junction 已覆盖主要授权边界。macOS/Linux、签名 staging 未运行；两个 native helper 仅 macOS 适用。
