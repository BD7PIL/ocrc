# harness 优点吸收总账（best-of）

> **用途**：把散落在五处的「合并各家优点」记录收口成一张可核对的账。
> **口径（2026-10-11 定）**：只记**事实 + 证据**（`file:line` / commit），逐项标注
> 「已落地 / 部分 / 未落地 / 不做 / 待裁决」。**建议只作裁决输入**，本批不改
> `docs/PRODUCT.md` / `docs/ARCHITECTURE.md` 的既有裁决文本。
> **生成方式**：全库 grep 抽查（非逐行重读四家源码）。全历史「融合 / 对标 / 优点 / 选型」
> 0 命中——无更早的独立设计文档可摘，本文件即首份收口。

## 0. 五处记录索引

| # | 位置 | 内容 | 在 ocrc git? |
|---|---|---|---|
| 1 | `docs/PRODUCT.md:157-164` | 参照系：六家吸收清单（ZCode / dsh / opencode web / OpenCode-Client / grinev / anomalyco opencode） | ✅ |
| 2 | `docs/PRODUCT.md:15` + `docs/ARCHITECTURE.md:74-82` | HarnessAdapter seam：opencode 1.18 首个适配器；opencode V2、**pi** 为后续适配目标（裸名） | ✅ |
| 3 | `/home/demo/OCWF/docs/ocrc-fork-development-plan.md:44-56` | 参考三角（OCRC fork / zcode bots / dsh-remote-web-ui）+ OmO 迁移闸门 | ❌ **外部本地库**（不在本仓库） |
| 4 | `docs/next-phase.md:14-15` | OmO 上游已迁 senpi 自有引擎（v5.1.x 全系） | ✅ |
| 5 | `NOTICE:20-28` + `web-next/src/styles/theme.css:12` + commit `66ddc0fb` | 落地证据（归属声明 / 寄存器出处 / 最早移植提交） | ✅ |

## 1. 总表：来源 × 优点 × 状态

### ZCode（`zai-org/ZCode`，Apache-2.0）
| 优点 | 状态 | 证据 |
|---|---|---|
| 前端母版（三栏壳 / 左栏四视图 / 命令中心 / composer 控制簇 / 快捷键三层 / 19 种 SidePane 页签 / ConversationStatusPanel / Automations / BotsDialog / SettingsPage / 远程三目标 / 分享快照 / 工作台分割树） | **已落地** | `web-next/vendor/zcode/`（rc.3 起 `/` 即 ZCode 壳）；CHECKLIST 102✅ |
| 桌面壳参考（Electron 41 + 每窗口 Host utilityProcess + IPlatformService + autoUpdater） | **未落地（规划）** | IPlatformService 接缝已用于 web：`web-next/src/zcode/platform.ts` |

### DeepSeek harness（`deepseek-ai/deepseek-harness`，MIT，244k★）
| 优点 | 状态 | 证据 |
|---|---|---|
| 三层语义令牌 static→alias→specific | **已落地** | `web-next/src/styles/theme.css:12-17,32,65,192` |
| superellipse 全局表 | **已落地** | `theme.css:437-440`（`@supports (corner-shape: superellipse(1.5))`） |
| 滚动条全局表 | **已落地** | `theme.css:444-459` |
| 焦点环全局表 | **已落地** | `theme.css:483`（`*:focus-visible`） |
| 0.5px 发丝描边 + 双层柔光高程 | **已落地** | `theme.css:162`（发丝高程三件套；描边画进 box-shadow 不占布局） |
| ContextMeter | **已落地（等价物）** | vendor `chat-input-toolbar/contextUsage.tsx`（ZCode 自带，非 dsh 移植） |
| TurnNavigator | **已落地（等价物）** | vendor `v4/ConversationTurnNavigator.tsx` |
| 字号一等设置（10–22px） | **已落地，量程不同** | vendor `lib/uiFontSize.ts`：**12–20px**、默认 14（dsh 的 10–22 未采用） |
| RiskConfirmation | **未落地为独立组件；概念由 approval dock 覆盖** | 全库 0 命中；approval/question dock = `web-next/src/zcode-services/pendingInteractions.ts`（U1） |
| TextShimmer | **已落地（等价物）** | vendor `components/ai-elements/shimmer.tsx` |

### opencode web（`sst/opencode` `packages/app`）
| 优点 | 状态 | 证据 |
|---|---|---|
| 24ms 限速流式 | **已落地** | `web-next/src/components/markdown/PacedText.tsx:1` + `components/cards/tool/pure.ts:9`（`PACE_MS = 24`） |
| Markdown 渲染进 Worker | **未落地** | 0 命中（现网直接渲染；ZCode vendor 成前端本体后此项优先级下降） |
| 行级虚拟化时间线 | **部分** | ocrc 时间线未做；vendor 在 `GitPane.tsx` / `ModelTrajectoryTimeline.tsx` 用 `@tanstack/react-virtual`；`pure.ts:80` 注 `@pierre/diffs` 虚拟化视图为 later-register |
| PART_MAPPING 注册表 | **已落地（等价物）** | `web-next/src/components/cards/tool/ToolBlock.tsx`（PART registry 的 tool 分支，`toolRendererKind` 分发） |
| composer dock 模式 | **已落地** | vendor 输入簇 + `pendingInteractions` dock 投影 |
| 边框做进 box-shadow 的复合阴影 | **已落地** | `theme.css:162`（与 dsh 发丝高程同一处实现） |
| 主题即 JSON | **未落地** | 0 命中（主题走 CSS token 文件，非 JSON 运行时） |
| CSP + 主题脚本哈希 | **未落地** | 0 命中（`src/lib/insecure-context.ts` 的 sha256 是 FIPS 回退，与 CSP 无关） |

### OpenCode-Client（Mrsandman327，**无许可证，只吸收思路**）
| 优点 | 状态 | 证据 |
|---|---|---|
| 设置管理信息架构（Provider / 映射 / 项目 / 技能源） | **已落地** | provider+baseURL：`src/core/settings-service.ts:114,152`；项目级 agents：U4 `src/core/settings-project.ts`；技能源：`src/core/skills-manager.ts` + `src/transport/web/routes/settings.ts:77` |
| 文件层原子写 + JSONC 校验路线 | **已落地** | `src/core/settings-service.ts:11`（JSONC-validate → backup → atomic write）+ `settings-project.ts:40` `atomicWrite` |
| 知识库→资产化闭环 | **不做（本体）** | `docs/PRODUCT.md:162` 明示「知识库本体不做」 |

### grinev/opencode-telegram-bot（MIT）
| 优点 | 状态 | 证据 |
|---|---|---|
| 媒体输出（相册） | **已落地（仅图片）** | M8-2：`src/transport/telegram/index.ts:736-751`——图片相册（cap 3，逐张 `sendPhoto`）；document / video / audio 未接 |
| session 深命令 | **已落地** | `src/transport/telegram/handlers.ts`：`/sessions` `/session` `/undo` `/redo` `/compact` `/usage` `/agent` `/model` `/files` |

### opencode（`anomalyco/opencode`，dev 分支）
| 优点 | 状态 | 证据 |
|---|---|---|
| 桌面端 Electron + health-poll 生命周期 | **未落地（规划）** | ocrc Desktop 规划中 |
| provider `options.baseURL` 网关覆盖 | **已落地** | `src/core/settings-service.ts:114,152` |
| loopback 强制 no_proxy | **已落地** | `src/core/remote-host.ts:129-131` + `src/core/remotes.ts:35` |

### pi 家族
| 优点 | 状态 | 证据 |
|---|---|---|
| future adapter（裸名） | **已记录未落地** | `docs/PRODUCT.md:15` / `docs/ARCHITECTURE.md:78` |
| 上游引擎关系 | **已记录** | `docs/next-phase.md:14-15`（OmO 上游迁 senpi v5.1.x） |
| 作为 ocrc 适配器的可行性 | 见 §3 | 外部 desk research |

## 2. HarnessAdapter 现状

- **接缝**：docs 名 **HarnessAdapter**（0.27 规划），代码实为 `AgentBackend`：`src/core/agent/backend.ts:192-326`。
- **三实现**：
  - `OpencodeBackend`（`opencode-backend.ts`）——SDK typed routes + raw `ocFetch`（SDK 未类型化的端点）；pin 1.18.x。
  - `AcpBackend`（`acp-backend.ts`）——stdio ACP；**自持事件源**（`onEvent`）+ 自持久化（`acp-store`）+ tombstone 删除 + `session/load` 重同步（`resyncIfStolen`）。
  - `V2Backend`（`v2-backend.ts`）——ctx 域调用；能力多关，诚实空实现。
- **注册**：`src/cli/host-backends.ts:82-99`，经 `OCRC_BACKENDS` 选择。
- **新 backend 成本边界**：`docs/ARCHITECTURE.md:431-434`。
- **已知先例**：kimi 探针硬编码 `host-backends.ts:44-69`。
- **ACP tradeoff（决定性）**：ACP 系**无法复刻 opencode 的 live shared session**——「用户在自己终端里跑、ocrc 旁路同看同一会话」这种体验只有直连 opencode HTTP API 才有（`docs/research/ACP_BACKEND_DESIGN.md:318-337`）。任何新 harness 走 ACP 都得接受这个降级。

## 3. pi 家族：已知事实 + 可行性

**本库已知（均为「记录」级，非核实）**：
- `docs/PRODUCT.md:15` / `docs/ARCHITECTURE.md:78`：pi 与 opencode V2 并列的 future adapter，**裸名**。
- `docs/next-phase.md:14-15`：OmO（oh-my-openagent）上游已迁 senpi 自有引擎（v5.1.x 全系），opencode 只是它兼容列里的一项 → OmO 对 ocrc 是**可撤依赖**。
- 本地技能（oh-my-openagent `references/senpi.md`）：pi 家族 = Senpi / oh-my-pi(omp) / gajae-code(gjc)；配置目录 `~/.senpi` `~/.pi` `~/.omp` `~/.gjc`；senpi = OmO v5 自有引擎（`packages/senpi-task`）。
- 本机**从未使用过** pi（上述目录均不存在）。

**外部 desk research（2026-10-11）** — 方法注：本机 WebFetch 内容提取层失效（连
`example.com` 都返回空），改用只读 `curl` + `gh api`，零写操作；下列陈述均可溯源。

**身份（已验证）**

| 名字 | 仓库 | 作者 / 组织 | 许可证 | ★ | npm | 配置目录 |
|---|---|---|---|---|---|---|
| **pi** | `earendil-works/pi`（原 `badlogic/pi-mono`，GitHub 自动重定向） | Mario Zechner（@badlogic） | MIT | 114k | `@earendil-works/pi-coding-agent`（bin `pi`） | — |
| **senpi** | `code-yeongyu/senpi` | code-yeongyu | MIT | 476 | `@code-yeongyu/senpi`（装 `pi` + `senpi` 两个 bin） | `~/.senpi/agent` |
| **omp / oh-my-pi** | `can1357/oh-my-pi`（Stencil Labs） | can1357 | MIT | 35k | `@oh-my-pi/pi-coding-agent` v18.9.2（bin `omp`） | `~/.omp/agent` |
| **gjc / gajae-code** | `Yeachan-Heo/gajae-code` | Yeachan-Heo | MIT | 2.9k | `gajae-code` v0.18.9（bin `gjc`） | — |

- 四者都是 **pi-mono 后代**（senpi / omp 明示 fork，gjc 有 `docs/porting-from-pi-mono.md`）——
  本地技能「同族 + 共享会话格式」的说法成立，但**四者交叉兼容无直接测试证据**（不确定）。
- **senpi-task**：npm / PyPI 均 404；实为 OmO 仓库内**私有包** `@oh-my-opencode/senpi-task`
  （`omo-senpi` 背后的 task 引擎）——即本地技能所称「senpi = OmO v5 引擎」的真实落点。
- **OmO v5 关系（已验证）**：OmO README 原文 "It runs on senpi, our fork of pi"
  （★70k，npm v5.1.30，**license SUL-1.0 / 非 OSI**）；senpi 是 v5 原生运行时；OmO 仍保留
  OpenCode 插件版（LazyCodex）；senpi 与 OmO 同作者。→ 印证 `docs/next-phase.md:14-15`。
- **假阳性已排除**：Inflection Pi 聊天机器人（pi.ai）、Raspberry Pi、npm `pi-ai`（名称占位）、
  Senpi-ai（Hyperliquid 交易技能组织）、`senpi_ebi`（事件相机科研）——均与编码代理无关。

**形态**：全部为 CLI/TUI 编码代理（非库优先），均带编程入口；TypeScript（gjc 运行时用 Bun），
omp 另含 Rust N-API 原生扩展。

**集成面（协议）——决定性**

| | stdio JSON-RPC | ACP | HTTP / 服务器 | MCP | SDK |
|---|---|---|---|---|---|
| pi | RPC 模式 = 严格 **JSONL**（自定义协议，**非** JSON-RPC；`pi --mode rpc`） | **未发现** | 无 | 客户端 | TS SDK |
| senpi | 继承 pi | **未发现** | **app-server：Codex 兼容 JSON-RPC over WS / stdio / unix**（`senpi app-server --listen ws://127.0.0.1:18990`，Bearer，`/healthz`） | 继承 | 继承 |
| omp | `omp --mode rpc`（NDJSON） | **`omp acp`**（JSON-RPC stdio；写操作经 `session/request_permission` 门控；`modes/acp/acp-mode.ts`） | 无 | 有 | Node SDK |
| gjc | `gjc acp`（stdio 前端） | **ACP**（`gjc setup paseo` 注册为 provider；文档含 initialize 握手） | 无公开 REST | 可作 MCP server | `gjc sdk session` CLI |

**优点（如存在）**：pi——极简核心 + extension / skill / theme 机制，RPC 事件契约文档质量高。
omp——ACP 实现最完整（fs / terminal 路由 + 权限门），内嵌 ripgrep / bash 免 fork-exec。
gjc——外部控制面克制（broker + capability-scoped attachment，凭据不外露）。
senpi——app-server 对标 Codex JSON-RPC，适合无头托管。

**作为 ocrc HarnessAdapter 的可行性：候选逐项（优缺点 × 影响面）**

> 影响面维度定义见 §4.0（分层 / 文件 / 工作量 / 依赖 / 回归风险 / 门禁）。

**omp（`can1357/oh-my-pi`，MIT，★35k）—— ACP 首选**
- **优点**：有 `omp acp`（JSON-RPC stdio，代码 + 文档双证），fs/terminal 路由 + 权限门最完整
  → 接现有 `AcpBackend` 的迁移成本最低；内嵌 ripgrep/bash 免 fork-exec。
- **缺点 / 代价**：含 **Rust N-API 原生扩展** → 需跨平台预编译工件，**EL7 / glibc 2.17 下限有风险**；
  fork 生态，长期维护不确定。
- **影响面**：分层 = **核心**。文件：`src/cli/host-backends.ts`（注册）+ 复用 `acp-backend.ts`。
  工作量 **M**。依赖：omp 二进制在目标平台（x86_64 / arm64 / EL7）可得。回归风险 **低**
  （`OCRC_BACKENDS` 选择，纯加法不改现有）。门禁：隔离栈 E2E + 权限 dock 联调。
- **建议**：**立项时首选**，但先做「omp 在目标平台能否运行」的可行性验证（半日）。

**gjc（`Yeachan-Heo/gajae-code`，MIT，★2.9k）—— ACP 次选**
- **优点**：有 `gjc acp`；外部控制面克制（broker + capability-scoped attachment，凭据不外露）。
- **缺点 / 代价**：`gjc acp` 是**薄前端**，依赖**常驻 SDK broker 守护进程** → 多一个进程要纳入
  adopt/spawn 生命周期模型；运行时用 Bun。
- **影响面**：分层 = **核心** + **宿主**（broker 进程生命周期）。工作量 **M–L**。回归风险低（加法），
  主要复杂点是 broker 生命周期。
- **建议**：**次选**；除非 omp 平台验证失败。

**pi / senpi 本体**
- **优点**：pi 极简核心、extension / skill / theme 机制；senpi app-server 对标 Codex JSON-RPC
  （无头托管友好）。
- **缺点 / 代价**：**本体无 ACP**。pi 的 RPC 是**自定义 JSONL（非 JSON-RPC）** → 自建桥 **L**；
  senpi app-server 是 **WS JSON-RPC，非 opencode HTTP 形状** → 无法复用 `OpencodeBackend`，
  新写适配层 **M–L**。
- **影响面**：分层 = **核心**（新适配层，非 AcpBackend）。senpi 线另需 **SUL-1.0（非 OSI）法务复核**。
- **建议**：**不作首选**。

- **共同降级**：任何 ACP 后端都接受「无 live shared session」（§2）。
- **还差验证**：① 实跑 `omp acp` / `gjc acp` 握手 + 权限流；② senpi app-server 长连接 / 多会话行为；
  ③ 四 fork 会话格式互操作实测；④ 版本锁定（senpi 用日历版本；`senpi-task` 私有不可 pin）；
  ⑤ **OmO 的 SUL-1.0 非 OSI 许可证法务复核**（若走 senpi 线）。

> **对既有记录的修正输入**：`docs/PRODUCT.md:15` / `docs/ARCHITECTURE.md:78` 把 **pi** 列为
> future adapter——但 pi 本体无 ACP；**能直接进 `AcpBackend` 的现实候选是 omp 或 gjc**。
> 表述是否修订由用户裁决（本批不改）。

## 4. 吸收对账：逐项 优缺点 × 影响面 × 建议

### 4.0 评估维度（判据）

- **优点**：这项给 ocrc 用户 / 工程带来什么（对齐 PRODUCT 第一条定位）。
- **缺点 / 代价**：引入成本、维护负担、依赖、许可证、与既有裁决的冲突。
- **影响面**（六项）：
  1. **分层归属**（PRODUCT 第二条：核心 / 壳 / 宿主 / 分发）——不属于任何层的不做；
  2. **文件 / 子系统**；
  3. **工作量** S（< 1 人日）/ M（1–3）/ L（> 3）；
  4. **依赖 / 前置**；
  5. **回归风险**（是否触碰冻结项：配色口径、右栏 ≥ 中栏、EL7 下限、air-gap、发布冻结）；
  6. **门禁**（双端测试 + CDP + 隔离栈 E2E）。
- **建议**：做 / 不做 / 待裁决 **+ 理由**（不裸给结论）。

### 4.1 已落地项：价值 · 代价 · 维护面 · 隐患

> 已落地项的「优点」即其生效中的收益；下表补的是**合并的影响面残留**——当初付的代价、
> 今天要维护什么、有什么隐患。已落地项没有「做不做」问题，只有「维护 / 回退」问题。

| 项 | 优点（生效中） | 代价（已付） | 维护面 / 隐患 |
|---|---|---|---|
| 三层语义令牌 | 组件只消费 alias 层，换肤零改组件（M9 换色已证） | 多一层间接，新人找值要跳三层；raw 层与 ZCode verbatim 强耦合 | token 名是**冻结契约**，改名波及全部组件；ZCode 升级要同步 raw 层 |
| superellipse | 连续曲率外观，1 行全局生效 | 依赖实验特性 `corner-shape` | 老引擎回落为普通圆角 → 外观不一致（可接受，渐进增强）；`@supports` 门控 |
| 滚动条全局表 | 明暗统一 | 全局 `*::-webkit-scrollbar` 选择器 | 组件局部滚动条皮肤需让位；双引擎路径已门控 |
| 焦点环全局表 | 无障碍一致 | 与组件自定义 ring 冲突 | 已用 `box-shadow: none !important` 压制（`theme.css:478` 注释即此）——新增组件若自画 ring 需注意 |
| 0.5px 发丝高程 | 描边不占布局（画进 box-shadow） | 半像素 | 高 DPI 下可能糊；被组件局部 box-shadow 覆盖时失效 |
| ContextMeter / TurnNavigator / TextShimmer | 免移植，随 vendor 维护 | 是 ZCode 实现而非 dsh 原版 | 要改 = 改 vendor（PATCHES 登记制）；行为/外观以 vendor 为准 |
| 字号一等设置 | 全站缩放，只动 `--ui-font-size` 不连带图标（设计正确） | 量程窄（12–20，≠ dsh 10–22） | 改量程 = 改 vendor 常量（见 4.4） |

### 4.2 未落地 / 部分项：逐项分析

**RiskConfirmation（独立组件）**
- 优点：危险操作独立二次确认的视觉模式。
- 缺点 / 代价：与 U1 的 approval/question dock **功能重叠**——dock 已承载「权限问询 + 三键应答」；
  再加一套确认 UI = 两套确认模型，认知与维护双份。
- 影响面：分层 = **壳**。若做，落在 vendor 交互面 + `zcode-services/pendingInteractions.ts` 投影层，
  会**与 dock 争同一槽位**。工作量 **S–M**。回归风险 **中**（确认模型分叉）。
- 建议：**不做独立组件**。语义已由 dock 覆盖；若未来要更强风险语义，给现有 approval 卡加
  risk 元数据即可（S）。判据：单一确认模型 + 右栏 ≥ 中栏。

**opencode web · Markdown 渲染进 Worker**
- 优点：长 Markdown / 大 diff 解析不卡主线程。
- 缺点 / 代价：Worker 生命周期 + 消息序列化成本；测试面复杂化；vendor 成前端本体后，ocrc 的
  markdown 组件只在卡片流用，再套 Worker 要绕开 vendor 渲染路径。
- 影响面：分层 = **壳**。文件 `web-next/src/components/markdown/`。工作量 **M**。
  依赖：**需先有实测瓶颈**。回归风险 **中**（流式渲染路径）。
- 建议：**待裁决，实测驱动**。前置 = `docs/perf-remediation-brief.md` 的实测结论；无数据不做。

**opencode web · 行级虚拟化时间线**
- 优点：超长会话滚动不掉帧。
- 缺点 / 代价：虚拟化与「流式插入 + 滚动锚定到任意历史」冲突（行高动态）；ocrc 卡片流时间线要
  重写布局；vendor 只在 `GitPane`/`ModelTrajectory` 局部用 react-virtual，不能直接借。
- 影响面：分层 = **壳**。文件 `web-next/src/components/cards/`。工作量 **L**。
  回归风险 **高**（流式 + 滚动锚定是既有 P0 行为）。
- 建议：**待裁决，实测驱动**。先量长会话帧率；有瓶颈再立项。

**opencode web · 主题即 JSON**
- 优点：主题可运行时导入导出 / 分发。
- 缺点 / 代价：为「运行时主题市场」服务，ocrc **无多主题分发需求**；现有 CSS token 已实现明暗双主题
  + 回肤取用（persimmon 封存）。
- 影响面：分层 = **壳**（且要重写 `theme.css` 架构）。工作量 **L**。
  回归风险 **高**（与 M9 冻结的配色口径冲突）。
- 建议：**不做**。判据：无需求 + 与冻结口径冲突 + 收益为零。

**opencode web · CSP + 主题脚本哈希**
- 优点：严格 CSP 防 XSS；脚本哈希免 nonce。
- 缺点 / 代价：构建期产哈希 + 注入；CSP 会限制 inline `<style>` / style 属性 → 与 vendor 注入样式面
  冲突（需逐块哈希或 nonce）；**威胁模型不匹配**（LAN / 内网 + 单用户自用）。
- 影响面：分层 = **壳 + 分发**（构建链 vite + 部署）。工作量 **M**。
  回归风险 **高**（CSP 一开 vendor 注入样式可能全挂，需实测）。
- 建议：**不做**。判据：威胁模型不匹配 + 与 vendor 冲突。

**grinev · 媒体输出 document / video / audio**
- 优点：完整媒体回传（不止图片）。
- 缺点 / 代价：TG 各类型尺寸 / 格式限制；host 要读任意文件并判 mime；**安全面**（任意文件外发
  要白名单 + 大小门禁）。
- 影响面：分层 = **核心**（transport）。文件 `src/transport/telegram/index.ts`。工作量 **S–M**。
  回归风险 **低**（加法）。
- 建议：**待裁决，按需**。图片相册已覆盖多数场景；有真实需求再接。

### 4.3 不做项（附判据）

| 项 | 判据 |
|---|---|
| OpenCode-Client 知识库闭环 | 越界到通用知识管理，与「驾驶舱」定位不符；会引入新存储 / 索引子系统（核心膨胀）；PRODUCT 第五条已明确不做。 |
| opencode web 主题即 JSON | 无需求 + 与冻结配色口径冲突（见 4.2）。 |
| opencode web CSP + 哈希 | 威胁模型不匹配 + 与 vendor 注入样式冲突（见 4.2）。 |
| dsh RiskConfirmation 独立组件 | 与 approval dock 功能重叠（见 4.2）。 |

### 4.4 待裁决项（带理由）

| 项 | 选项 A | 选项 B | 建议 |
|---|---|---|---|
| dsh 字号量程 | 维持 12–20（零改动） | 放宽到 10–22（改 vendor 常量 2 处，S 级） | **维持**——dsh 原值是参考非硬需求；为对齐参考值改 vendor 不划算。要改须过 PATCHES 登记 |
| 性能三项（Worker / 虚拟化） | 实测驱动，无数据不做 | 按母版追齐 | **A**——不因「母版有」而追；以 `perf-remediation-brief.md` 实测为准 |
| pi 家族适配器 | 维持裸名「pi」 | 改判为「omp（首选）/ gjc」 | **B 更准确**（pi 本体无 ACP）；是否立项另议，立项先做 omp 平台验证 |

## 5. 建议与下一步（供裁决，不改既有裁决）

1. **字号量程（4.4）**：S 级低风险，但**建议维持现状**——除非有实际用户诉求。理由：dsh 的 10–22
   是参考值而非硬需求，为对齐它去改 vendor 常量（还要过 PATCHES 登记）收益不足。
2. **性能三项**：全部**实测驱动，当前不建议做**。理由：三者回归风险均中—高（流式 / 滚动锚定 /
   vendor 注入样式），无实测瓶颈时引入是净负担。下一步先补 `perf-remediation-brief.md` 的数据。
3. **pi 家族（§3）**：建议把 `docs/PRODUCT.md:15` / `docs/ARCHITECTURE.md:78` 的 future adapter 从
   「pi」修正为「**omp / gjc（ACP 路径）**」——理由是 pi 本体无 ACP、接不进现有 `AcpBackend`。
   **是否立项**由你裁决；若立项，第一步是 **omp 在目标平台（含 EL7）的可行性验证**（半日量级），
   这是把 §3 从「可信」推到「已验证」的唯一路径。
4. **需要你点头的只有两件**：① 是否修订 future adapter 的命名表述；② 是否要我先做 omp 平台验证。
   其余（不做项 / 维持现状）不需要动作。
