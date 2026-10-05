# 调研：OC Manager（Mrsandman327/OpenCode-Client）— opencode 可视化工作台

日期：2026-09-26 ｜ 方法：浅克隆源码通读（`/tmp/oc-manager-research`，49 个 Go 文件 / 9.2k 行 + 53 个前端文件）+ README/作者自述文档比对

## 0. 结论（TL;DR）

**OC Manager 与 ocrc 是互补关系，不是竞争。** 一句话定位：OC Manager 是"坐在本机电脑前"
的可视化管理台（管理 opencode 进程、配置、技能、Git、文件），ocrc 是"人不在电脑前"的
远程通道（TG + 扫码 Web 驱动 opencode 干活）。功能重叠集中在"会话浏览/流式查看"，
其余各自分立。

一句话回答用户的问题：**"一套代码三种形态"的实现 = Wails 桌面窗口和自起 HTTP 服务共用
同一份嵌入的静态前端，桌面走 Wails IPC、Web/手机走 `/api/app-call` 通用 RPC + SSE，
两条通道分发给同一批 Go App 方法。**

| 维度 | OC Manager | ocrc |
|---|---|---|
| 形态 | 桌面应用（本机 GUI） | opencode 进程内插件 + 远程 Web/TG |
| 安装 | 独立 exe（wails3 build） | `npm i -g` + opencode 插件配置 |
| 鉴权 | **无**（默认 127.0.0.1，可改监听地址） | QR 配对 + token + CF Access |
| 移动性 | 手机端 = 局域网内浏览器开 Web 服务 | 任意网络（TG 走 Telegram 云） |
| 写能力 | 全量（文件写/删、Git push、配置改写） | 只读为主（文件预览截断） |
| 成熟度 | 27★、无 LICENSE、无 Release、Wails v3 beta、零测试 | CI 绿、MIT、vitest 双套件 |

## 1. 项目定位与来源

- 仓库 <https://github.com/Mrsandman327/OpenCode-Client>，自称 **"OC Manager — OpenCode 全能工作台"**，README 定位"告别命令行，用直觉操作 AI"（README.md:26,35）。
- 社区规模：27 stars / 6 forks / 249 commits / 无 Releases。**仓库内没有任何 LICENSE 文件**（go.mod 亦无 license 字段）——法律上保留所有权利，不可复用其代码。
- 作者自带文档 `doc/技术方案.md`、`doc/项目架构深度分析.md`、`doc/使用说明.md` 及 10 个分模块 md，写得相当认真（宣称与实现基本一致，见 §5）。
- 同名勿混：`kcrommett/oc-manager`（TypeScript 终端 UI，清理 opencode 元数据）、`chriswritescode-dev` 的 OpenCode Manager（移动优先 Web 界面）均非本项目。

## 2. 三形态架构拆解（"一套代码"如何实现）

**前端是零框架原生 JS**（作者文档自述"原生 HTML/CSS/JS（零构建工具）"，25 个 JS 文件按 core/chat/filebrowser/views 分层；仓库里根本没有 `frontend/src` 和 package.json，只有编译产物 `frontend/dist/` 被直接提交）。`main.go:12` `//go:embed all:frontend/dist` 把整包前端嵌进二进制。

三条消费路径，同一批后端方法：

1. **桌面端**：Wails v3 窗口（`main.go:52`，1280×820，WebView2/WebKitGTK）加载嵌入资源，前端经 Wails bindings 直调 `App` 导出方法（app.go 共 40+ 个导出方法）。
2. **Web 端**：`service/web/frontend_web.go:48` `StartFrontendWebServer` —— 用户在 UI 里手动启停的**按需** HTTP 服务，默认 `127.0.0.1:8081`，`http.FileServer` 直接服务同一份 `frontend/dist`。前端的 Wails 调用在浏览器里不可用，于是走 `POST /api/app-call`（frontend_web.go:132）：`{method, args}` JSON → `bridge.AppCall` **按方法名反射分发**到与桌面绑定完全相同的 App 方法（app_dispatcher.go 的 switch 有 70+ case）。
3. **手机端**：不是独立代码，`frontend/dist/chat/mobile.js:7` 用 `matchMedia('(max-width: 800px)')` 判定后切换抽屉布局 + 单会话模式（作者文档称"手机端抽屉布局 + 长会话窗口化渲染"）。

事件流同理双通道：Go 侧长连接消费 opencode `GET /global/event` SSE（`service/opencode/sse.go:80`），桌面端经 Wails `Emit("oc-event", payload)` 推送，浏览器端经 `GET /events` SSE 转发原始 payload（frontend_web.go:148），带 256 深缓冲 + 满载丢弃前先发 `sse-lagged` 通知让前端全量补齐（sse.go:56-61，设计有想法）。

**⚠️ Web 端零鉴权**：`/api/app-call` 是无条件 RPC 网关，没有任何 token/配对检查；改监听地址为 0.0.0.0 即局域网裸奔，且能调到 `SaveBrowserFile`/`DeleteBrowserEntry`/`GitPush` 这类写方法。这是与 ocrc 安全模型（QR 配对 + token + CF Access 三档）最大的差距，也是我们不可借鉴的部分。

## 3. 与 opencode 的集成方式（与 ocrc 路线完全不同）

OC Manager **不是插件，是外部驾驶舱**：

- **进程管理**：自己 `exec.Command("opencode", "serve", ...)` 拉起 opencode serve（`service/opencode/process.go:82`，默认 127.0.0.1:4096），TCP 探测端口就绪、读 `/doc` 解析 version 做版本检测；停止时 Linux 侧用 `pkill -f "opencode.*--port <port>"`（process_linux.go:23，粗暴但明确自己只该杀自己端口）。也能"发现"已运行的外部 serve 并标记 `external=true` 不杀。
- **API 代理**：`OpenCodeAPI(method, path, body)`（api.go:36）是通用透传代理——前端要什么端点就转发什么，Go 侧不逐个建模。代码里具名的端点只有：`/project`、`/session?directory=&roots=`、`/session/{id}`、`/question` + `/question/{id}/reply|reject`（question 工具应答，api.go:119-185）。
- **事件**：仅 `/global/event` 一条 SSE 全量收（见 §2）。
- **配置/技能/Git 不走 opencode API**，直接操作文件系统：
  - 供应商/模型配置：解析并**改写** `~/.config/opencode/opencode.jsonc`（先 StripComments 再 unmarshal，config/provider/provider.go:34-53）。
  - 技能管理：扫描技能目录 + **符号链接启停**（config/skill/linker.go）、方案（scheme）保存/应用。
  - Git：自己 `exec` git（status --porcelain / log / stage / commit / **push / pull** / discard，service/filebrowser/git_changes.go:15，经 internal/executil 封装代理）。
  - 知识库：独立 `vault/` 目录（exe 同级优先，不可写回退用户配置目录，service/knowledge/dir.go:14-51）存 markdown + frontmatter，独立于 opencode 配置。
  - OMO 配置：实为对 `omo` 模型配置方案的管理（导入/导出/切换，config/omo/），是它自己的方案层概念，非 opencode 原生。

对照 ocrc：我们嵌在 opencode 进程内、直接拿 serverUrl 调 API（SDK + raw fetch），没有进程管理职责；OC Manager 在进程外、职责恰是"把 serve 进程和配置文件管起来"。

## 4. 功能清单与实现要点

README 功能表经源码核验，**宣称与实现一致度高**（未发现空头功能）：

| 功能 | 实现要点（文件） |
|---|---|
| 多会话 Tab（桌面） | 纯前端 `frontend/dist/chat/tabs.js`，各 Tab 独立滚动/渲染 |
| 项目→目录→会话树 | Go 并发拉 `/project` + 各目录 `/session` 合并（api.go:211 GetProjectTree） |
| SSE 实时流 | §2 所述双通道 + lagged 补齐机制 |
| 文件浏览器 | 列表/读/**写/上传/删除/建目录**（app.go:143-181），预览可配（file_preview_config.go） |
| 文件变更 Diff | 折叠目录树 + 左右对照（git_changes.go 拿 porcelain + 自己渲染） |
| Git 面板 | status/log/stage/commit/push/pull/discard 全套（含 push 代理配置） |
| 子任务面板/待办 | 前端消费 SSE 事件里的 subagent/todo 数据（chat/sidepanel.js、tree.js） |
| 命令面板 | 静态+动态 CLI/TUI 命令参考，`/` 唤起搜索（chat/cmd-palette.js） |
| 知识库 @ 引用 | vault markdown + frontmatter 索引（knowledge/），`@` 触发注入上下文 |
| 技能管理 | 扫描+symlink 启停+站内编辑（config/skill/） |
| 供应商/OMO | 改写 opencode.jsonc（provider.go）+ 本地方案切换（config/omo/） |
| 托盘/快捷键/单实例 | tray.go + `GlobalShortcut.Register("Shift+X")` + `SingleInstance` UniqueID（main.go:36-79） |
| 消息窗口化 | 长会话分窗加载（作者文档"消息窗口化与加载更多模块"） |

## 5. 工程质量与成熟度评估

- **无 LICENSE**：法律上不可复用代码（可借鉴交互/架构思路，不可抄实现）。
- **零测试**：`*_test.go`、`*.test.*` 均无；仅 sse 心跳间隔留了"变量便于测试"的注释。
- **Wails v3.0.0-beta.23**：运行时未稳定，beta 升级 breaking 风险由其自担（这也解释了为何我们不该现在选同栈）。
- **无 Release/无版本号**：单分支快速迭代，249 commits 全在 master。
- 代码本身注释密度高、中文注释认真（超时原因、SSE 缓冲设计都有来龙去脉），Go 侧 9.2k 行规模适中；前端零构建是刻意选择（作者文档明说），代价是无类型/无压缩/依赖手拷（marked.min.js 直接 vendor 进仓库）。
- 平台：README 徽章 Windows|Web|Mobile；Linux 有 WebKitGTK 依赖说明与 process_linux.go 分支，理论可用，但主战场显然是 Windows。

## 6. 与 ocrc 重叠/互补矩阵

| 能力 | OC Manager | ocrc | 判定 |
|---|---|---|---|
| 会话列表/树 | 项目→目录→会话树 | 列表 + 工作区分组 | 双方都有，形态不同 |
| 流式查看消息 | SSE 全量 + 窗口化 | grinev 渲染管线 + 渐进节流 | 双方都有 |
| 子代理可见性 | 子任务面板 | PlanHud 跳转 + subs 面板 | 双方都有 |
| Todos | ✅ | ✅ TaskPanel/PlanHud | 双方都有 |
| 文件浏览 | ✅ 读写删传 | ✅ 只读预览（M8 /ls /open） | 重叠但深度不同 |
| Diff 查看 | ✅ 左右对照 | ✅ WorkingDirPanel（读端点） | 双方都有 |
| Git 操作 | ✅ 全套含 push | ❌ | **仅 OC Manager**（形态不合：远控不该 push） |
| 配置改写 | ✅ opencode.jsonc/技能 symlink | ✅ 通道配置 channels.json（自身配置） | 仅 OC Manager 管 opencode 配置 |
| 进程管理 | ✅ 拉起/停止 serve | ❌（插件就在进程内） | 仅 OC Manager |
| 知识库 | ✅ vault + @ 引用 | ❌ | 仅 OC Manager |
| **Telegram 通道** | ❌ | ✅ 33 命令 + 流式卡片 | **仅 ocrc** |
| **通道配置（微信/飞书）** | ❌ | ✅ M9 面板 + 预埋 | **仅 ocrc** |
| **定时任务 schedules** | ❌ | ✅ 双端 | 仅 ocrc |
| **远程安全（QR/外部网络）** | ❌ 零鉴权 | ✅ 配对/token/CF Access | 仅 ocrc |
| 移动端 | 响应式（局域网内） | PWA + TG（任意网络） | 形态不同 |
| 桌面 GUI/托盘/快捷键 | ✅ | ❌（不需要） | 仅 OC Manager |

## 7. 对 ocrc 的可借鉴点与不适用点

**可借鉴（交互与机制层）：**
1. **`sse-lagged` 慢客户端显式通知**：缓冲满 → 丢最旧一条腾位 → 先发"你已滞后"事件 → 前端全量补齐。比我们 ws 断线重拉更精细，若日后我们遇到弱网丢增量（TG 长轮询/Web ws），这是现成答案。
2. **长会话窗口化**（只渲染最近 N 条 + "加载更多"）：我们 feed 全量渲染，超长会话在手机浏览器有内存/卡顿风险——是 PlanHud 之外最值得排期的前端优化。
3. **question 工具应答**（`/question/{id}/reply|reject`）：opencode 新增的交互问询端点，我们的 TG/Web 目前没有对应 UI，值得登记进 command-data-plane 后续批次。
4. **项目→目录→会话树**的分组视角：我们按工作区分组，但它"自动发现所有 directory"兜底 knownDirs 缺失的思路，对我们修"空白 session"类 bug 有参考。

**不适用：**
- Wails/Go 桌面栈：与"opencode 进程内插件"的形态互斥，且 v3 还是 beta。
- `/api/app-call` 无鉴权 RPC 网关：安全模型与 ocrc 相反，绝不引入。
- 直接改写 opencode.jsonc / Git push：远控场景下风险不可控，保持只读。

## 8. 最终结论

- OC Manager 把"本机管理"做全（进程、配置、技能、Git、文件、知识库），ocrc 把"远程驱动"做深（TG 命令面、安全配对、通道生态、定时任务）。两者共用同一个 opencode server API 但部署形态（进程外桌面 app vs 进程内插件）决定了能力边界互不侵蚀。
- 对 ocrc 路线的直接影响：**无需调整**。若用户想要"桌面可视化"，OC Manager 可直接与我们并存使用（它连它的 4096，我们插件在各自实例内）——注意它默认就要管 4096 端口的 serve，与生产 octg 实例同端口，共存时须避免让它"停止服务"误杀生产实例（其 pkill 按端口过滤，风险有限但仍建议生产机器上只看不点）。
- 若未来 ocrc 出"桌面伴侣"需求，正确路径仍是 Web PWA 桌面化（PWA install），而不是复刻 Wails 路线。
