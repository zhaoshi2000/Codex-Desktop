# AstroGate Codex Desktop

**Codex 风格图形工作台 + GPT 中转供应商管理。版本 0.1.0，源码交付版。**

这是独立实现的桌面界面，通过官方开源 `codex app-server` 执行编程任务，并兼容 CC Switch 的 Codex 供应商 JSON / TOML 结构。不是把官方桌面程序的私有界面直接解包修改，也不是 CC Switch 全部功能的完整移植。

## 先启动使用

### Windows：最少步骤

1. 把压缩包**完整解压**到可写目录，例如 `D:\Apps\AstroGate-Codex`。不要直接在压缩包里运行，不建议放入需要管理员权限的 Program Files。
2. 第一次运行 **`Setup-Windows.cmd`**。确认下载后，它会在需要时安装便携式 Node.js 22，并安装官方 Codex **0.162.1**。需要连接 Node.js 与 npm 下载源；不需要管理员权限，不覆盖你的系统 Node 或原 Codex 配置。
3. 双击 **`Start.cmd`**。Windows 优先用 Edge / Chrome 的独立应用窗口打开图形界面；没有可用应用窗口时退回默认浏览器。运行期间保留启动器窗口。
4. 进入 **设置 → 模型供应商 → 添加供应商**，填写名称、Base URL、API Key 和真实模型 ID，保存后点击该供应商的“使用”按钮。
5. 添加本机项目文件夹，选择模型与推理强度，输入开发任务并发送。额外文件/命令权限会显示审批窗口。

已安装 Node.js 22+ 和 Codex 的电脑可以直接运行 `Start.cmd`。内核未被自动发现时，进入 **常规 → Codex 可执行文件**，填写 `codex.exe` 的绝对路径，或运行 `Install-Engine.cmd`。

**图形界面本身不依赖 npm 安装，也不要求运行 Electron。** 开发任务需要真实 Codex 内核与有效的中转凭据 / 官方账号。没有凭据时可管理配置和项目，但不会产生模拟模型回答。

### 已有 Node.js 的命令行方式

```powershell
cd D:\Apps\AstroGate-Codex
npm run install:engine
npm start
```

`npm start` 不需要先安装 Electron。`npm run install:engine` 安装到本文件夹 `.runtime/codex`。

### 原生 Electron 桌面与 EXE 打包

压缩包内**没有预编译 EXE，也没有捆绑 Electron、Node 或 Codex 二进制**。提供了原生 Electron 外壳和打包配置。需要在有网络的 Windows x64 环境执行：

```powershell
npm install
npm run install:engine
npm run desktop
# 生成 Windows 安装程序
npm run build:win
# 或生成便携式 EXE
npm run build:portable
```

也可双击 **`Build-Windows.cmd`**。成功后安装程序位于 `release/`。默认未配置代码签名，不宣称有可信发布者签名。应保留真实构建日志，并在目标 Windows 电脑验收后分发。

固定的顶层构建依赖：Electron `44.7.2`、electron-builder `26.0.12`。离线交付环境无法执行 npm 安装，因此此包没有假造 `package-lock.json`；首次联网安装会生成锁文件，应把实际锁文件提交进你自己的仓库以固定后续依赖解析。

`.github/workflows/build-windows.yml` 提供手动触发的 Windows 构建流程。只有你自行上传到仓库并触发后才会运行；本次交付未修改任何 GitHub 仓库，也未触发线上构建。

## 已实现的界面与功能

| 模块 | 实现内容 |
|---|---|
| 工作台 | Codex 风格浅色布局、左右侧栏、消息输入框、项目上下文、深色与跟随系统外观 |
| 中转供应商 | 添加/编辑/切换/移除，Base URL、Key、默认模型、模型显示名、自定义额度接口 |
| CC Switch 兼容 | 供应商 JSON 单项/集合导入，TOML 中选中供应商解析，本机 Codex 中转配置只读导入，无 Key 配置导出 |
| 模型与强度 | 截图所示七个名称作为预设，可输入真实模型 ID；读取 `/models` 或内核目录；强度滑块、紫色 Ultra |
| 项目与会话 | 本机目录选择、分区、置顶、编辑、资源管理器打开、移除关联、最近排序、重命名、归档、恢复、导出 |
| 编程任务 | App Server 双向 JSON-RPC，线程开始/恢复、流式文字、命令与文件变更显示、停止、计划和 Token 事件 |
| 操作审批 | 单次命令/文件审批、当前轮额外权限、交互问题回答、基础 MCP 表单请求；未知反向调用拒绝而非自动批准 |
| MCP | 本地 stdio / 远程 HTTP 配置、显式信任与启用、凭据存储、内核状态读取 |
| Skills | 编辑本机 SKILL.md、保存/删除并同步到本应用管理的内核目录 |
| 使用情况 | 供应商 JSON 路径映射或官方内核额度窗口，显示实际剩余百分比；没数据就显示“未提供 / —” |
| 附件 | 最多 6 个文本/代码文件，每个最大 512 KiB、总量最大 3 MiB；作为文本传入内核 |

**加速按钮仅为界面开关**，按参考图要求保留闪电图标与开关状态，不发送 `service_tier`，不承诺提速，也不假装切换计费档位。

预设的模型显示名和 ID 不构成可用性保证。请把默认模型改成你的供应商实际接受的模型 ID。读取到模型目录后，强度按目录显示；没有能力声明时允许选择预设档位，但不支持的档位会明确报错，不会偷偷映射成低档位。

## 中转配置示例

```text
供应商名称：AstroGate
Base URL：https://你的中转域名/v1
API Key：在本机界面填写
默认模型：供应商文档列出的实际模型 ID
```

不要把 `/responses`、`/chat/completions` 写进 Base URL。填写的根路径不会自动追加 `/v1`。供应商必须支持 Codex 需要的 **Responses API、流式响应和相应工具调用**。仅测试 `/models` 成功不能证明任务执行一定兼容。

任务最终由本机 Codex 内核直接连接你选定的供应商，API 请求不经过 AstroGate 的额外远程服务器。供应商切换不会改变原会话的归属；已有会话始终使用创建时绑定的供应商，防止把旧上下文意外发送给新供应商。运行中不能切换/修改正在使用的供应商。

### 剩余额度百分比

在供应商编辑页展开“额度百分比：接口与字段映射”，例如接口返回：

```json
{"data":{"total":100,"remaining":27}}
```

填写总量路径 `data.total`，剩余路径 `data.remaining`，显示 **27%**。或者直接指定一个 `0–100` 的剩余百分比字段。也可用“总量 − 已用量”计算剩余量。负数、缺值、零总额或明显超范围数据不伪造百分比。

本版额度查询限 GET、Bearer 认证、无查询字符串 URL 和简单点号 JSON 路径。不能直接执行 CC Switch JavaScript 用量脚本。使用模型 Key 查询时，额度接口必须与模型 Base URL **同源**；跨域需填写独立额度 Key，避免把模型 Key 发给其他域名。

官方账号使用内核返回的 rate-limit 窗口，多个窗口取最低的剩余百分比并展示各窗口。API 中转额度与 ChatGPT 订阅额度不混算。

## 数据与安全边界

- `Start.cmd` / Node 模式默认数据目录为当前用户 `~/.astrogate-codex`；可用 `ASTROGATE_DATA_DIR` 指定另一目录。Electron 模式默认使用系统应用数据目录下的 `astrogate-codex-desktop/data`。**这两种启动模式默认不共享数据**，不要误认为原记录消失；可以在各自“数据与存储”页查看实际目录。
- 供应商配置使用本应用自己的 `codex-homes/<供应商ID>`。不会自动改写你的 `~/.codex`、CC Switch 数据库或其活跃配置。只在点击明确的“复制本机官方登录态”时读取并复制登录文件。
- Key 在本应用凭据库中用 AES-256-GCM 存储。Windows 主密钥由当前用户 DPAPI 保护；其他系统为权限 `0600` 的本地主密钥文件。**这不能抵御同一用户权限下的恶意程序，也不能保证整份用户资料泄露时的安全。** Windows DPAPI 行为未在本次 Linux 环境验证。
- 主中转 Key 不写入生成的 TOML，通过环境变量传给内核。本地进程仍可能读取其环境；不要在不可信电脑使用。官方 Codex 自身登录文件仍由内核按其 `auth.json` 规则保存。MCP 自定义环境变量会写入本应用隔离的 MCP TOML 段，文件限制为当前用户访问（非 Windows），不宣称所有内核文件都已加密。
- 本地 HTTP 服务只监听 `127.0.0.1` 随机端口，API 使用随机访问令牌，校验 Host / Origin，没有开启跨域访问。不要把带 `#token=` 的启动地址发给别人，不要把本地端口反向代理到公网。
- 默认“工作区访问”，完全访问必须每轮明确确认。真正的文件隔离、网络权限与操作审批由 Codex 内核和操作系统提供；本界面不冒充额外的系统沙箱。
- 导出会话可能包含私有代码和你自己输入的秘密。凭据库、自动保存的 Key 和官方登录文件不会包含在常规导出中，但无法保证对话正文没有秘密。
- MCP 本地命令属于第三方代码，启用前确认来源可信。仅装入已明确启用的插件，不自动执行导入配置中的 Shell 或 JavaScript 用量脚本。

## 当前交付范围 / 未做成的部分

这是可运行源码和图形界面，不是“全量官方 Codex 桌面客户端 + 全量 CC Switch”的完整复刻。以下能力没有被冒充为已完成：

- 没有预编译、签名或 Windows 实机验收过的 EXE；本次没有下载真实 Codex/Electron 二进制。
- 没有使用真实付费 API Key 联调。实际任务能力还要在你的中转和 Windows 环境验收。
- 官方应用页仅调用内核的 `app/list` 并显示真实返回值，**不是完整插件市场**；不实现 Gmail / GitHub 等官方应用的安装、OAuth 全链路管理。实际授权在官方界面完成。
- 未实现语音、桌面宠物、邀请好友、云电脑、浏览器远程操控、桌面快照、自动更新和 ChatGPT 家长控制等无关云端功能。参考图里这些菜单没有做成会误导用户的假开关。
- 不实现多任务并发、本地终端模拟器、Git 图形分支/差异面板、完整历史迁移、CC Switch 路由/聚合/自动故障转移、SQLite 备份导入。
- 附件目前只支持文本和代码，不支持图片/PDF/二进制。MCP 复杂嵌套 JSON Schema 交互需要后续扩展。

## 验证

```sh
npm test
npm run check
node scripts/check-engine.mjs
```

`npm test` / `npm run check` 不需要 npm 依赖，可直接使用 Node.js 22+。测试使用 `tests/fixture-rpc.mjs` 作为**明确标记的测试进程**，没有任何生产模式的假模型后端。`check-engine.mjs` 只在真实内核安装后检查版本，不验证 API 授权。

浏览器测试脚本为 `tests/ui-smoke.py`；见 `docs/TEST_REPORT.md`，其中说明了受限 Chromium 环境的渲染方式和验证边界。

## 目录

```text
server/      本地 HTTP API、Codex JSON-RPC、配置与凭据、项目/会话持久化
electron/    独立桌面窗口、原生文件夹选择、受限 IPC
web/         原生 JavaScript / CSS 图形界面，无前端构建依赖
scripts/     环境安装、版本检查、语法检查
tests/       单元/集成测试与明确标记的 RPC 测试夹具
docs/        开发说明、验收报告、接口说明
licenses/    上游许可说明
```

详细架构和二次开发位置见 `docs/DEVELOPMENT.md`。原始上游地址和许可见 `THIRD_PARTY_NOTICES.md`。
