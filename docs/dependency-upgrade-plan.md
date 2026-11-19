# 项目依赖升级计划

## 评估依据

本计划基于 2026-11-12 使用 Bun 1.4.4 执行的只读检查：

```text
bun outdated --recursive --no-save --frozen-lockfile
```

“目标版本”优先采用 Bun 输出的 `Update`，即当前依赖声明范围内可以升级到的版本；跨主版本的 `Latest` 仅作为后续评估目标，不视为可直接升级版本。升级前应重新运行过时依赖检查，确认 registry 版本没有变化。

静态评估未覆盖 CI 平台、测试覆盖率、签名/发布流水线和部分补丁实现细节。表中工期为工程评估，不是实测值；每个批次实际耗时取决于测试环境和回归结果。

## 依赖升级清单

### 可在当前声明范围内升级

| 名称 | 当前版本 | 目标版本 | 升级影响范围 | 工作量 | 风险点与依赖关系 |
|---|---:|---:|---|---|---|
| `jotai` | 2.20.2 | 2.20.3 | 全局状态管理 | 低 | 保持在 2.x；3.x 不在本次目标内 |
| `@codemirror/language` | 6.12.4 | 6.13.1 | 编辑器语言支持 | 低 | 与 state、view 一起升级 |
| `@codemirror/state` | 6.7.1 | 6.7.6 | 编辑器状态 | 低 | 与 language、view 一起升级 |
| `@codemirror/view` | 6.43.9 | 6.43.15 | 编辑器视图 | 低 | 与 language、state 一起升级 |
| `@modelcontextprotocol/sdk` | 1.29.0 | 1.32.2 | MCP 工具和 transport | 中 | 同时是 `@proma/core` peer dependency，需确认版本范围和 transport 行为 |
| `@pierre/diffs` | 1.1.20 | 1.6.4 | Diff 展示 | 中 | 检查 React props、主题和 Shiki 集成 |
| `@slack/web-api` | 8.1.1 | 8.3.0 | Slack Web API | 低 | 与 Bolt 的鉴权、事件流程一起回归 |
| `@xmldom/xmldom` | 0.8.11 | 0.8.15 | XML 解析 | 低 | 建议留在 0.8.x，0.9.x 另行评估 |
| `adm-zip` | 0.5.17 | 0.5.18 | ZIP 处理 | 低 | 回归导入导出、解压路径和异常输入 |
| `dompurify` | 3.4.5 | 3.4.17 | HTML/XSS 清洗 | 低 | 回归 Markdown、富文本和 HTML 渲染 |
| `mammoth` | 1.12.0 | 1.13.0 | DOCX 解析 | 中 | 回归表格、图片、样式和异常文档 |
| `sharp` | 0.35.3 | 0.35.5 | 图片处理 | 中 | 原生二进制；需检查平台包和 Electron 构建 |
| `highlight.js` | 11.11.1 | 11.12.0 | 代码高亮 | 低 | 检查语言识别和 HTML 输出 |
| `shiki`（`@proma/core`、`@proma/ui`） | 3.22.0 | 3.23.0 | 代码高亮、Diff 渲染 | 中 | 两个 workspace 包需同步升级；注意 transformer API |
| `@electron/rebuild` | 4.2.0 | 4.2.1 | 原生模块重建 | 低 | 与 Electron、node-pty、sharp 构建联动 |
| `@larksuiteoapi/node-sdk` | 1.73.0 | 1.76.0 | 飞书 API/事件 | 中 | 回归事件签名、WebSocket 和 API 请求 |
| Radix 全部直接依赖 | 见下表 | 见下表 | React UI 控件和无障碍交互 | 中 | 按基础 primitive 到上层控件升级；整体回归焦点、键盘、portal、ARIA |
| `autoprefixer` | 10.5.4 | 10.6.2 | CSS 构建 | 低 | 与 PostCSS、Tailwind 一起验证 |
| `concurrently` | 9.2.4 | 9.2.5 | 开发进程编排 | 低 | 检查退出码和信号转发 |
| `electron-updater` | 6.8.9 | 6.8.11 | 应用自动更新 | 中 | 回归下载、校验、失败恢复和安装调度 |
| `jszip` | 3.10.1 | 3.10.2 | ZIP 读写 | 低 | 回归导入导出 |
| `markdown-it` | 14.3.0 | 14.3.3 | Markdown 解析 | 低 | 检查插件、自定义渲染和清洗链 |
| `node-addon-api` | 8.9.1 | 8.9.2 | Native addon API | 低 | 与 native helper 构建验证 |
| `postcss` | 8.5.26 | 8.5.32 | CSS 构建 | 低 | 与 Tailwind、Vite 构建验证 |
| `semver` | 7.8.5 | 7.8.6 | 版本比较 | 低 | 影响版本判断和更新逻辑 |
| `undici` | 7.29.0 | 7.30.2 | HTTP/fetch | 中 | 回归代理、超时及 Electron 网络请求 |
| `zod` | 4.3.6 | 4.6.7 | 配置、IPC 和 provider schema | 中 | 回归合法/非法输入和错误格式 |

### Radix 组件明细

| 名称 | 当前版本 | 目标版本 | 工作量 | 风险点与依赖关系 |
|---|---:|---:|---|---|
| `@radix-ui/react-alert-dialog` | 1.1.23 | 1.2.1 | 中 | 与 Dialog 和基础 primitive 联动 |
| `@radix-ui/react-collapsible` | 1.1.20 | 1.2.1 | 中 | 回归受控状态和展开/收起行为 |
| `@radix-ui/react-context-menu` | 2.3.7 | 2.4.1 | 中 | 回归键盘、焦点和菜单行为 |
| `@radix-ui/react-dialog` | 1.1.23 | 1.3.1 | 中 | 回归 portal、焦点管理和 ESC 关闭 |
| `@radix-ui/react-dropdown-menu` | 2.1.24 | 2.2.1 | 中 | 依赖 menu、focus 和 portal 组件 |
| `@radix-ui/react-label` | 2.1.15 | 2.1.17 | 低 | 检查 label 与表单关联 |
| `@radix-ui/react-popover` | 1.1.23 | 1.3.1 | 中 | 回归定位、滚动和焦点行为 |
| `@radix-ui/react-scroll-area` | 1.2.18 | 1.4.0 | 中 | 回归滚动条及虚拟列表 |
| `@radix-ui/react-select` | 2.3.7 | 2.4.1 | 中 | 回归键盘操作、焦点和表单值 |
| `@radix-ui/react-separator` | 1.1.15 | 1.2.0 | 低 | 检查横/纵向显示 |
| `@radix-ui/react-slider` | 1.4.7 | 1.6.1 | 中 | 回归拖拽、键盘和数值边界 |
| `@radix-ui/react-slot` | 1.3.3 | 1.5.0 | 中 | 基础组件；先于依赖它的上层控件验证 |
| `@radix-ui/react-switch` | 1.3.7 | 1.4.1 | 低 | 回归受控状态和表单提交 |
| `@radix-ui/react-tabs` | 1.1.21 | 1.2.1 | 中 | 回归键盘导航和选中状态同步 |
| `@radix-ui/react-toast` | 1.2.23 | 1.3.1 | 中 | 回归队列、关闭和通知时序 |
| `@radix-ui/react-tooltip` | 1.2.16 | 1.4.1 | 中 | 回归延时、portal 和无障碍行为 |

### Tiptap 组件组

Bun 检查发现 Tiptap 的普通扩展当前解析在 3.29.2，可升级至 3.33.1；表格和任务扩展固定在 3.19.0，需作为一组处理。版本目标应以升级时重新查询 registry 为准。

| 名称 | 当前版本 | 建议目标 | 工作量 | 风险点与依赖关系 |
|---|---:|---:|---|---|
| `@tiptap/core` | 3.29.2 | 3.33.1 | 中 | 扩展基础，应先升级 |
| `@tiptap/pm` | 3.29.2 | 3.33.1 | 中 | 与 core 同步 |
| `@tiptap/react` | 3.29.2 | 3.33.1 | 中 | 与 React 18、core 同步 |
| `@tiptap/starter-kit` | 3.29.2 | 3.33.1 | 中 | 检查默认 schema 变化 |
| `@tiptap/suggestion` | 3.29.2 | 3.33.1 | 中 | 与 Mention 扩展联动 |
| `@tiptap/extension-code-block-lowlight` | 3.29.2 | 3.33.1 | 中 | 依赖 core 和 lowlight |
| `@tiptap/extension-link` | 3.29.2 | 3.33.1 | 中 | 回归链接解析和点击行为 |
| `@tiptap/extension-mention` | 3.29.2 | 3.33.1 | 中 | 回归 suggestion 和输入行为 |
| `@tiptap/extension-placeholder` | 3.29.2 | 3.33.1 | 低 | 回归编辑器状态和占位显示 |
| `@tiptap/extension-underline` | 3.29.2 | 3.33.1 | 低 | 回归 schema 和 Markdown 转换 |
| `@tiptap/extension-table` | 3.19.0 | 3.33.1 | 高 | 与 table-cell/header/row 同步升级 |
| `@tiptap/extension-table-cell` | 3.19.0 | 3.33.1 | 高 | 与 table/header/row 同步升级 |
| `@tiptap/extension-table-header` | 3.19.0 | 3.33.1 | 高 | 与 table/cell/row 同步升级 |
| `@tiptap/extension-table-row` | 3.19.0 | 3.33.1 | 高 | 与 table/cell/header 同步升级 |
| `@tiptap/extension-task-item` | 3.19.0 | 3.33.1 | 高 | 与 task-list、schema 同步升级 |
| `@tiptap/extension-task-list` | 3.19.0 | 3.33.1 | 高 | 与 task-item 同步升级 |

## 分批计划

### 第一批：低风险、低工作量

**顺序**

1. 先升级 `jotai`、`dompurify`、`adm-zip`、`@xmldom/xmldom`、`jszip`、`semver`、`node-addon-api`。
2. 成组升级 CodeMirror language/state/view。
3. 升级 `highlight.js`、Shiki 3.x、`markdown-it`。
4. 升级 `postcss`、`autoprefixer`、`concurrently`。
5. 升级 `electron-updater`、`@electron/rebuild`、`undici`、`zod`。
6. 最后升级字体、Slack Web API 和飞书 SDK 等功能型依赖。

**顺序理由**：先处理独立 patch 和小版本，再处理有内部配套关系的编辑器/高亮包；最后处理服务集成和 updater，降低故障定位范围。Radix 中 label、separator、switch 可作为本批末尾试点，其余建议放在第二批成组验证。

**预计耗时**：依赖调整和类型检查约 0.5–1 个工作日；加上 Electron 构建和定向回归约 1–2 个工作日。

**验证事项**：

- `bun run typecheck`
- `bun test`
- Markdown、HTML 清洗、ZIP/XML、图片及文档解析
- CodeMirror 输入、焦点、滚动和输入法
- updater 测试及失败恢复路径
- `bun run electron:build`
- 当前开发平台上的 native helper 和 `node-pty` 冒烟验证

### 第二批：中等复杂度、少量适配

**顺序**

1. 升级 MCP SDK，并确认 `@proma/core` peer 范围满足。
2. 升级 Radix：先 slot/基础 primitive，再 Dialog、Popover、Select、Dropdown/Menu 等上层控件。
3. 升级 Tiptap core、pm、react、starter-kit，再升级普通扩展；表格和任务列表单独成组处理。
4. 升级 `mammoth`、`sharp`、`@pierre/diffs`、Slack/飞书集成。

**顺序理由**：peer dependency 和基础 UI primitive 是上层控件的前置；Tiptap 核心先于扩展；`sharp` 和 Diff 组件分别依赖原生构建环境和 Shiki 版本稳定。

**预计耗时**：约 3–5 个工作日，视 UI 自动化和文档样例覆盖情况调整。

**验证事项**：

- MCP server/transport、工具发现和调用、错误处理
- Dialog、Select、Popover、菜单、Tooltip 的键盘/焦点/portal/ARIA 行为
- Tiptap Markdown、表格、任务列表、Mention、链接和代码块
- Slack/飞书鉴权、事件、WebSocket 和失败重试
- DOCX 解析、图片处理和 Diff 渲染
- `bun run typecheck`、`bun test`、`bun run electron:build`

### 第三批：大改动、核心链路或重构

建议拆成独立升级项目，不要在同一个批次一次跨多个主版本。

| 子项目 | 建议顺序 | 工作量/预计耗时 | 关键验证 |
|---|---|---|---|
| Pi Agent runtime 1.4.0 -> 1.5.2 | 先检查 `pi-ai` patch，再成组升级 Pi AI、agent-core、coding-agent 和 TUI override | 高，3–7 个工作日 | Agent 会话、provider、工具、权限、MCP、CLI、Electron runtime；patch 适配 |
| Electron 43.2.0 -> 45.3.1 | 先升级 Electron，再重建 node-pty、sharp、native helpers，最后评估 builder/updater | 高，3–7 个工作日；多平台签名另计 | ABI、Windows/macOS/Linux 打包、启动、终端、图片处理、自动更新和恢复 |
| React 18 -> 19 | React/React DOM 与类型包同步升级，再检查 Radix、Tiptap 和 `@proma/ui` | 高，3–6 个工作日 | Renderer、共享 UI、弹窗/表单、编辑器、类型检查和生产构建 |
| 构建链主版本 | 评估 TypeScript 7、Vite 8、plugin-react 6、esbuild 0.28；逐项迁移 | 高，5–10 个工作日 | 主进程 CJS、preload、renderer、external 清单、CI 和打包产物 |
| Tailwind 4 | 独立处理配置和 CSS 迁移 | 高，3–6 个工作日 | 全 UI 样式、主题、插件、响应式和生产 CSS |
| 文档与图表主版本 | 分别评估 Shiki 4、Mermaid 12、PDF.js 6、officeparser 8、pdf-parse 2、KaTeX 0.19 | 高，按组件约 2–5 个工作日 | 真实文档样本、worker/打包、API、渲染输出和异常输入 |

**前置依赖**：

- Pi runtime 升级必须先确认本地 `pi-ai` patch 的变更内容和适用性；Pi 系列需成组升级。
- Electron 升级是原生 ABI、node-pty、sharp 和打包验证的前置，升级前需准备目标平台构建环境。
- React 19 应先于依赖 React 运行时的类型包和组件库主版本迁移，所有相关包需协同验证。
- TypeScript、Vite、plugin-react、esbuild 是互有关联但不能仅凭版本号断定兼容；每次只推进一个构建链主版本并跑完整构建。

## 可延后或可跳过项

### 可延后

- `@pierre/diffs`、`mammoth`、`@larksuiteoapi/node-sdk`、`@slack/web-api`：若近期没有相关功能需求，可单独排期。
- `@fontsource-variable/inter`、`ink-mde`：更新收益较低，不影响其他升级。
- `officeparser`、`pdf-parse`、PDF.js、Mermaid、KaTeX：建议等有明确兼容性、安全或业务需求时再安排。

### 当前可跳过，不建议为追新而升级

- Pi runtime 1.4.0 -> 1.5.2：存在 override 和 `pi-ai` 本地 patch；没有明确需求时保持当前版本。
- React 18 -> 19、TypeScript 5 -> 7、Tailwind 3 -> 4：属于生态/工具链迁移，不是普通 patch 更新。
- Vite 6 -> 8、plugin-react 4 -> 6、esbuild 0.24 -> 0.28：先评估兼容矩阵；Vite 6 范围内可先更新至 6.4.6。
- Shiki 3 -> 4、Mermaid 11 -> 12、PDF.js 4 -> 6：先采用当前主版本内的更新或延后。
- `lucide-react` 0.x -> 1.x、`officeparser` 4 -> 8、`pdf-parse` 1 -> 2：无具体需求时跳过本轮主版本迁移。

## 配置一致性事项

审计时发现 `apps/electron/package.json` 声明版本为 `0.19.71`，而当时的 `bun.lock` workspace 元数据记录为 `0.19.70-beta.14`。开始依赖升级前应先确认当前发布版本来源及 lockfile 更新流程；建议作为独立配置核对事项处理，不要和第三方依赖升级混在同一变更中。

## 执行前检查清单

- 重新运行 Bun 过时依赖检查，确认目标版本仍有效。
- 确认当前分支和已有工作区改动，避免覆盖其他变更。
- 核实 CI 操作系统、Electron 签名/打包能力和原生模块测试环境。
- 查看 `@earendil-works/pi-ai` patch 内容，决定 Pi 升级是否可行。
- 确认 Electron workspace 版本与 lockfile 元数据差异应如何处理。
- 每批升级独立提交或保持可独立回退，并记录类型检查、测试、Electron 构建和目标平台冒烟结果。

本计划仅供执行参考；生成此文档时未更新依赖或 lockfile。
