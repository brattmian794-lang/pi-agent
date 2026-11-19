# 依赖升级第一批验收记录（2026-11-18）

**结论：第一批的依赖版本、代码修复、解析回归、全量测试、类型检查、构建和隔离 updater 主要场景已通过。仍有 Windows 真实 Authenticode 子进程和真实中文 IME/产品编辑器交互缺少通过证据；因此不进入第二批，也不宣称所有环境验收条件全部关闭。**

## 基线与环境

- 基线：`main`，HEAD `e29779b98b50cce0ebe76a0c1da9ccd231f1a5e2`（`v0.19.73-beta.1`）；变更未提交，验证针对该基线加当前工作区。
- Windows `10.0.26200.9974` x64；Bun `1.4.4`；宿主 Node `22.20.0`；Electron `43.2.0`（内置 Node `24.18.0`）。
- 保留开始前的用户改动：`AGENTS.md`、`README.md`、`apps/electron/scripts/dev-kill.ts`、根 `package.json` 和未跟踪 `.pi/`、升级计划/开发文档、`scripts/`。
- 未升级第二批依赖，不提交、推送、打标签或发布。Electron patch 按工程约定递增至 `0.19.75-beta.1` 并同步 `bun.lock` workspace 元数据。

## 验收摘要

| 验收项 | 结论 | 证据 |
|---|---|---|
| 原报告五项失败及主要边界 | 通过（Windows 可执行范围） | Planning Electron SQLite；项目指令 junction；updater junction、确定性持久化失败、删除拒绝后重试。Windows 文件 symlink `EPERM` 未实测，POSIX 分支保留。 |
| 全量测试/类型检查/构建 | 通过 | `bun test`：610 pass、5 skip、0 fail，615 项、92 文件、1450 assertions。主工程/updater 类型检查及 Electron 构建均退出码 0。 |
| Markdown/HTML、ZIP/XML、图像、文档输入 | 通过（定向范围） | Chromium HTML 清洗五项通过；解析回归十五项通过。私有辅助路径和产品入口覆盖边界见下文。 |
| updater 下载和恢复 | 部分通过 | normal、安装失败恢复、Agent 守护、取消安装、启动故障恢复、cleanup、interrupted、corrupt、offline、ENOSPC、no-update 均通过。真实 Authenticode 子进程未通过；签名拒绝替身只覆盖错误分支。 |
| CodeMirror/中文 IME | 部分通过 | 基础焦点、滚动、文本输入/input 事件通过；真实中文候选、可信 compositionend、完整产品编辑器操作未验证。 |
| native helper/node-pty | 部分通过 | Electron 中真实 node-pty 创建 cmd.exe、输入输出和退出码 0 通过。Agent Island/EventKit helper 只支持 macOS，Windows 不适用。 |
| 版本、diff、归档 | 通过 | 第一批二十二个直接依赖按 workspace 与锁版本匹配；`git diff --check` 通过；日志及报告已归档。 |

## 原始失败修复

1. Planning 测试从 Electron 包 `path.txt` 解析可执行文件，避免其他测试的 `electron` mock 污染；隔离 HOME/USERPROFILE，保留 SQLite 事务和冲突断言。
2. 项目指令测试在 Windows 用真实 junction 验证根规范化、越界目标和 AGENTS 目录链接拒绝；POSIX 保留文件 symlink。未提升权限绕过 Windows `EPERM`。
3. updater 链接路径按平台创建 junction/dir，并以 lstat/realpath 检查链接和危险路径拒绝。
4. 状态持久化失败用普通文件阻塞状态目录父路径，替代 `/dev/null`。
5. 删除拒绝采用实例级 `removePendingFile` 故障注入，验证状态保留及解除故障后的真实删除重试；默认仍使用 `unlinkSync`，安全校验不变。

## 文档、HTML 与解析回归

新增 `dependency-parsing-regression.test.ts`：JSZip/adm-zip 跨库读写、损坏/截断 ZIP；产品 `resolveTargetPath` 根内归一化及越界拒绝；xmldom namespace/CDATA/异常 XML/外部实体；Sharp 正常转码及坏图拒绝；产品 `extractTextFromFile` 的 DOCX/XLSX 正常和异常输入。

ZIP/XML、Sharp 的部分检查是库级用例，不等于磁盘解压、OfficeCLI、视觉网络服务或全部私有预览链验收。现有解析器的 DOCX `w:br` 分隔符丢失和 officeparser `4.2.0` XLSX 共享富文本只取首 run 保真限制已记录；本轮不进入第二批。

Chromium 依赖页检查正常 Markdown/HTML 内容保留及 script/iframe/style、事件属性、内联样式、危险 URL、编码危险协议、SVG 事件清除，五项通过。CodeMirror 主动 focus 后 `view.hasFocus=true`，文末 scrollTop 为 1663；CDP `Input.insertText` 之后观察到实际文本及 `input` 事件。它不产生真实系统 IME 候选/composition 证据。

曾尝试独立 Edge profile 和一次性 Electron shell；均没有可定位的隔离 GUI 窗口。只发现用户现有 Edge，未操作。中文候选选择、可信 `compositionend` 和产品编辑器交互未验收。

## updater 隔离与真实场景

updater 测试实例只在 packaged + `proma.updaterTest` 元数据 + 显式测试根时启用，使用受限环境白名单和隔离 HOME/APPDATA/TEMP/userData。测试 Electron 使用 `no-proxy-server`，解决 Windows 系统代理绕过回环 feed 的问题；生产包不设置该开关。Windows 旧版从 `win-unpacked` 复制到本次 owner-marked scratch root；不运行旧版 NSIS 前置安装。新版仍由真实 electron-updater 下载并由真实 NSIS 更新。

v5 normal：本地 feed 完整响应 216,050,578 字节，SHA-256 与 fixture 清单一致；隔离 scratch install ASAR 替换为 `0.20.0-test.1`；旧实例退出码 0，外控确认不同 PID 的新版，报告 `restartedVersion` 与目标一致。normal 场景通过。

v5 `install-failure` 故障注入后旧版恢复；`agent-guard` 验证 Agent 活跃时旧实例保持运行、空闲后安装；`cancel-install` 取消后不安装；`startup-recovery` 注入退出码 23 后能恢复目标版本；`cleanup` 只清理本轮 owned root 并保留 sentinel。`interrupted`、`offline`、`disk-full`、`no-update` 通过。修正 Content-Length 后，`corrupt` 返回 22-byte payload，updater 明确以 SHA-512 mismatch 拒绝并通过。

专用 `invalid-signature` 场景在**仅打包测试构建**内显式注入拒绝结果；验证 updater 错误状态，不冒称真实 Authenticode 通过。真实 Windows Authenticode 场景中 electron-updater 子进程停在 `Verifying signature` 且状态仍为 downloading。同一隔离临时 exe 由独立 PowerShell `Get-AuthenticodeSignature` 约 1.4 秒返回 `NotSigned`；使用相同 execFile shell 命令约 2.8 秒返回 `Status: 2`。挂起根因未确认。

v5 fixture 构建命令请求 `--app-id com.proma.updater.test.batch1`。可直接核验的是每次 NSIS `/D`、测试 exe/ASAR 和报告路径都指向对应 owner-marked scratch root，以及卸载注册项路径指向测试 scratch。effective appId metadata 未从最终 ASAR/安装工件独立提取验证，本报告不以命令行传参代替该检查。正式 Proma `0.22.97` exe/asar 时间戳 `2026-11-18 11:10:16` 未变化，正式卸载记录仍在；现存 startup-recovery 测试卸载记录位于 scratch，本轮只归档其快照，不再运行卸载器。未调用正式 updater feed，未终止正式 Proma 进程。

## 最终检查和证据

| 检查/场景 | 结果 | 证据 |
|---|---|---|
| `bun test` | 0；610 pass、5 skip、0 fail；615 项/92 文件/1450 assertions | `apps/electron/out/dependency-batch1-acceptance-20261118/bun-test-final-continue3.log` |
| `bun run typecheck` / updater typecheck | 均退出 0 | 同目录 `typecheck-final-continue3.log`、`updater-typecheck-final-continue3.log` |
| `bun run electron:build` | 退出 0；Vite 5761 modules | 同目录 `electron-build-final-continue3.log` |
| controller/cache focused tests | 20 pass；controller 11、cache cleanup 9 | 同目录 `updater-focused-final.log` |
| v5 normal/恢复/守护/清理场景 | 报告均通过 | 同目录 `updater/` 的逐场景目录及 `continued-summary.json` |
| 下载错误/no-update 场景 | interrupted、corrupt、offline、disk-full、no-update 通过 | 同目录 `updater/` 逐场景报告 |
| 签名拒绝注入/真实 Authenticode | 注入分支通过；真实子进程阻断 | 同目录签名报告及 Authenticode 日志 |
| 二十二项直接版本 registry/lock/安装解析核对 | 按 workspace 匹配 | `registry-results.log`、`manifest-check-final.log`、`installed-check-final.log` |

5 个既有 skip：POSIX Shell 三项（Windows 未设置 `DEV_TEST_SH`）和 Git Bash 跨会话两项（未设置 `PROMA_TEST_GIT_BASH`）；未新增 skip，不计通过。macOS/Linux/staging 未执行；native helper 在 Windows 不适用。

## 变更与剩余项

本轮修改 Electron patch/lock、原五项失败用例及 updater test controller/fixture/feed/run/harness；新增解析回归、浏览器依赖检查、PTY 冒烟和本报告。初始用户改动保留，未提交/发布/升级第二批。`git diff --check` 通过。证据与历史注册项备份位于 Git 忽略的本地输出或 session scratch。

仍未关闭：Windows 真实 Authenticode 子进程挂起；中文 IME/产品编辑器实际 GUI 操作未验证；Windows 文件级 symlink `EPERM`；macOS/Linux/staging 未执行。因此不能宣称所有平台验收均关闭。

## 继续执行补充（2026-11-18）

- updater harness 仅对 `isUpdaterTestEnabled()` 已确认的 packaged 测试实例设置 `no-proxy-server`，使 Windows 回环 feed 直连；feed server 记录 HTTP 方法、路径、Range、响应长度和未完成关闭事件。生产应用不走该测试分支。
- Windows 旧版起点只从 fixture 的 `win-unpacked` 复制到新的 owner-marked scratch run root。真实 updater 下载仍使用 NSIS 包；正常 v5 场景证实下载哈希、ASAR 替换、版本更新及不同 PID 新版重启。
- v5 构建命令显式传入独立 appId 参数；可直接复核的是 scratch `/D` 目标及测试卸载路径。最终有效打包 appId 元数据未从安装包独立提取，因此不以命令行传参声称该字段已验收。正式 Proma `Proma.exe`/`app.asar` 最后修改时间仍为 `2026-11-18 11:10:16`。
- 本轮最终源码后检查：`bun test` 610 pass、5 skip、0 fail；主工程/updater typecheck 和 Electron build 均退出 0。
- v5 结构化 updater 报告、feed 日志及 appId/卸载信息快照位于忽略输出目录 `apps/electron/out/dependency-batch1-acceptance-20261118/updater/`；各测试 run 保留 owner marker。startup-recovery 产生的测试注册项仍指向 scratch；其记录快照已归档，本轮未再次运行卸载器。
- 未关闭项仍是 Windows 真实 Authenticode updater 子进程 hang、中文 IME/产品编辑器 GUI 无法实测、Windows 文件 symlink `EPERM` 以及 macOS/Linux/staging 缺证。签名故障注入只证明 updater 拒绝状态分支可测，不代表真实系统签名集成通过。
