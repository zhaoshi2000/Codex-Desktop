# 开发与验收说明

## 集成方式

不是把 CC Switch 的 Rust/Tauri 全量工程嵌入官方 Codex 桌面程序。新客户端使用 Node.js 本地服务与 Electron 可选外壳；UI 独立实现，真实编程功能交给 Codex App Server。CC Switch 兼容部分集中在 `server/providers.mjs`：`settingsConfig.auth.OPENAI_API_KEY`、`settingsConfig.config` TOML、模型目录的读写。

这样可避免手工改动原来正在使用的 Codex 配置，并把 GUI、凭据和执行内核的职责分开。每个供应商独立 CODEX_HOME。源代码中的官方服务方名称和截图模型标签不代表官方授权、联名或模型可用性。

## 调用流程

```text
Web / Electron renderer
  -> authenticated localhost HTTP API
  -> Service / Vault / Store
  -> JSONL stdin/stdout
  -> codex app-server (separate native process)
  -> selected Responses API upstream

Codex reverse approval requests
  -> RpcProcess request event
  -> Service approval queue
  -> SSE notification / UI approval dialog
  -> explicit user decision
  -> JSON-RPC result to Codex
```

没有在浏览器里直接发送中转 API Key。前端负责将用户在表单中输入的 Key 经本机受令牌保护的 API 交给凭据库，之后查询配置只拿到 `hasKey`，不回显保存的密钥。

## 重点源码

- `server/rpc.mjs`：原生可执行文件发现、initialize/initialized 握手、UTF-8 流解析、双向请求、超时、子进程退出处理。
- `server/service.mjs`：中转切换、独立配置生成、thread/start/resume、turn/start/interrupt、事件整理、人工审批、MCP/技能管理。
- `server/providers.mjs`：供应商校验、有限 TOML 标量解析、CC Switch 导入/导出、模型查询、JSON 额度映射。不是任意 TOML 编辑器。
- `server/index.mjs`：127.0.0.1 HTTP 服务、严格 Host/Origin 和随机令牌、SSE、明确路由白名单、实例锁。没有把整个磁盘映射为静态资源。
- `server/store.mjs`：JSON 索引和分会话文件、原子写入、节流保存、崩溃恢复。未引入数据库第三方依赖。
- `server/vault.mjs`：AES-GCM 凭据库与 Windows DPAPI 主密钥保护。
- `web/app.js`：图形页面、项目菜单、模型菜单、Ultra 滑块、表单、审批与对话；`styles.css` 对应参考图布局。
- `electron/main.cjs`：桌面外壳、contextIsolation、受限 IPC、关闭任务确认、官方登录链接打开。

## 主要 API

所有 API 使用 `X-AstroGate-Token`，只接受来自自身来源的浏览器调用；写操作为 `POST application/json`。

| 路由 | 用途 |
|---|---|
| GET `/api/state` | UI 状态；不返回凭据正文 |
| GET `/api/session?id=...` | 本应用会话详情 |
| GET `/api/events` | SSE 状态、消息、审批、诊断事件 |
| POST `/api/provider/save` | 新建/更新供应商，Key 留空保留原值 |
| POST `/api/provider/select` | 切换新任务默认供应商；运行中拒绝 |
| POST `/api/provider/import` | 导入 CC Switch 兼容 JSON；返回警告 |
| POST `/api/provider/test` | GET 供应商 `/models` 并更新可选目录 |
| POST `/api/models` | 从内核 `model/list` 读取真实声明 |
| POST `/api/usage` | 读取真实额度，无可用数据返回 null 百分比 |
| POST `/api/send` | 传入 project/session、文本、模型、强度、权限、文本附件 |
| POST `/api/stop` | 中断当前轮或停止尚在初始化的内核 |
| POST `/api/approval` | 显式回复某个待处理请求 |
| POST `/api/mcp/save` | 配置工具；启用要求 trusted=true |
| POST `/api/skill/save` | 保存受限文件名的本机 SKILL.md |

`server/index.mjs` 的 switch 是实际接口契约。此表只列常用项；不要用未实现的路由猜测功能。

## UI 状态规则

正在运行的任务不因切换页面而中断。一个客户端一次允许一个执行任务。供应商只能在任务停止后切换。会话保存自己的 providerId、threadId 和 cwd，不把既有会话转发给另一个供应商。项目移除只解绑本应用关联，不删除磁盘目录。归档也是本应用的显示/持久化元数据，不冒充官方全局归档同步。

前端只显示内核提供的思考摘要，不要求或展示隐藏的原始思维链。代码块先转义模型文本，再生成有限 Markdown 标签；不能执行模型生成的 HTML。

## 在 Windows 交付前的人工验收

本次未在 Windows 执行以下验证。真实分发时必须补测：

1. 用普通用户运行 Setup / Start，包含中文、空格目录；关闭并重新打开，确认配置与会话保存。
2. 验证 `check-engine.mjs` 找到预期的 Codex 0.162.1。核对自定义供应商 TOML 被内核接受。
3. 用测试中转 Key 发送“只读列出项目文件”；检查实际 `/responses` 请求、返回模型和计费。不仅测试 `/models`。
4. 在新建的临时 Git 项目内请求创建一个无风险测试文件，核对实际文件、审批策略和工具输出；切勿先用重要生产项目。
5. 请求一个需审批操作，分别拒绝、允许单次、取消；验证停止任务和进程关闭行为。
6. 完全访问权限仅在专门测试目录逐次授权；测试 Windows 沙箱初始化失败时不能静默退到完全访问。
7. 关闭应用后检查 vault.json 中没有明文 Key，跨 Windows 用户或篡改密文时必须解密失败，原始用户 .codex 不应被覆盖。
8. 用供应商真实额度接口验证百分比字段、账户匹配、跨域 Key 限制和错误状态。
9. 构建 Electron EXE，检查依赖许可证与内核二进制被纳入安装包，测试安装/卸载路径、桌面快捷方式、窗口关闭及原生目录选择。
10. 需要公开分发时再配置代码签名、安装包 SHA256、依赖审计与版本升级策略。

## 本地开发与测试

```sh
node server/index.mjs
npm test
npm run check
```

HTTP UI 无打包步骤。修改 web 文件后刷新页面即可；更改 server 文件需要重启。启动 URL 的 token 为能力凭据，不应记录在共享日志、截图或 Git 中。

测试夹具仅在 `tests` 手动引用，打包清单不包含 tests。HTTP 行为与 JSON-RPC 传输测试是真实本地进程/套接字交互，但其模型输出是明确标记的测试数据；绝不把这些输出当作上游兼容性证据。
