# omo-slim 身份查证与接入可行性

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- 调研日期：2026-10-14
- 语境：ocrc 评估以 openchamber（github.com/openchamber/openchamber）作面板基座；用户问「参考 omo-slim 能否接入」。部署拓扑：**Windows/Mac 跑 openchamber 面板；EL7/glibc 2.17 只当被控端（跑 opencode v2，已实测原生可跑）；ocrc 的 IM 通道插件以共生拓扑住被控端 opencode 配置数组。**
- 结论置信度：高（身份、形态、license、交互面均有一手来源直接证据）

## 1. 身份确证：「omo-slim」= oh-my-opencode-slim

「omo-slim」不是一个独立名字，而是社区对 **oh-my-opencode-slim** 的通用简称（其生态内项目 issue/README 一律以 "OMO-Slim"/"omo-slim" 指代它）。

主仓库与发行物：

| 项 | 值 | 来源 |
|---|---|---|
| GitHub | https://github.com/alvinunreal/oh-my-opencode-slim | `gh repo view` 实测 |
| npm | `oh-my-opencode-slim@3.0.4`（latest，122 个版本） | `npm view oh-my-opencode-slim` 实测 |
| 描述 | "Lightweight agent orchestration plugin for OpenCode - a slimmed-down fork of oh-my-opencode" | npm package.json |
| license | MIT | npm + GitHub licenseInfo 双证 |
| 活跃度 | 9.5k★ / 580 fork；最近 push 2026-10-13（调研前 1 天）；npm 3 天前发版；最新 release companion-v0.1.5（2026-10-11） | gh api / npm 实测 |
| 官网 | https://ohmyopencodeslim.com | repo homepageUrl |

**排除的同名候选**（均非 opencode 语境下的「omo-slim」）：

- `joshua-zyy/pi-omo-slim`、`foxytanuki/pi-omo-slim`：pi（另一 agent harness）的多代理发行版，非 opencode。
- `YanzuoLu/oh-my-claude-code-slim`：OMO-slim 编排模式向 Claude Code 的移植，衍生品而非本体。
- npm 无裸名 `omo-slim` 包（`npm view omo-slim` → 404）。
- 注意与 **oh-my-opencode**（code-yeongyu，npm `oh-my-opencode`，license SUL-1.0 非开源协议）区分：slim 是它的社区精简 fork，但已独立演化为 V3 架构，star 数与活跃度远超上游。openchamber 官方 entrypoint 集成的是上游 oh-my-opencode（见 §3）。

## 2. 解剖：它是什么

**形态**：opencode 的**多代理编排插件**（单一 npm 包，bin CLI + plugin 双导出），不是配置集也不是 fork 分支。核心：

- 7 个专职 agent（Orchestrator/Explorer/Oracle/Council/Librarian/Designer/Fixer），按任务路由到不同模型（"mix any models"）；Orchestrator 把专家派发为后台任务并行执行再汇合。
- 附带 skills（deepwork/codemap/reflect 等）、`/preset` 运行时模型切换、LSP/AST 工具、可选桌面悬浮窗 Companion、Tmux/Zellij 等 multiplexer 面板集成。

**装在 opencode 哪个配置位**（一手来源：README "Manual Installation" + docs/opencode-v2-compatibility.md）：

- 安装器把包路径写进 opencode 配置的 **`plugin` 数组**（v1 键；v2 宿主为 `plugins:`）——与 ocrc IM 通道插件**同一配置位、同一加载机制**。
- 自身配置在独立文件 `~/.config/opencode/oh-my-opencode-slim.json[c]`（及项目级 `.opencode/oh-my-opencode-slim.json[c]`）。
- 双导出设计：`server`（v1 plugin hooks）+ `setup`（v2 promise-plugin），单包同时兼容 opencode v1（≥1.17.10）与 v2（**要求 v2.0.7+**）。

**与 opencode 2.x 的关系**：官方兼容文档明确支持 `opencode2`，基线 v2.2.25 实测于 OpenCode v2.0.7，v3 已按 v2 优先设计（后台编排、服务端 preset 持久化等）。**与 ocrc 的 pin 冲突**：其 npm 依赖 pin `@opencode-ai/plugin`/`sdk` **1.18.32**（v1 SDK 面），但运行时对 v2 宿主走自带的 v2 适配器（compile-time mirror pin `@opencode/plugin` 2.0.18）。即：包元数据是 1.18，运行行为已适配 v2。

## 3. 与 openchamber 的交互面（一手证据）

两者**没有代码级依赖，但社区里高频同框跑，且 openchamber 官方已有「装 oh-my-opencode」的一等支持**：

1. **openchamber 官方 docker-entrypoint 一键开关**（`scripts/docker-entrypoint.sh` L52-64）：环境变量 `OH_MY_OPENCODE=true` 时，entrypoint 自动 `npm install -g oh-my-opencode` 并执行 `oh-my-opencode install --no-tui --skip-auth ...`（注意：集成的是上游 **oh-my-opencode**，不是 slim；slim 需自己往被控端 opencode 配置 `plugin`/`plugins` 数组加条目）。`docker-compose.yml` 有对应注释开关。来源：openchamber/openchamber master，2026-10-14 实测。
2. **真实用户在 openchamber 上跑 omo-slim 的 bug 单**（issue #1435，2026-10-04，closed）：OpenChamber 2.1.0 + OpenCode 2.0.21 + omo-slim 3.0.2，OpenChamber 的 "Safety Net" 权限自动批准与 omo-slim 后台子任务的 `task_reply` 竞态 → 已修复。证明二者共存是受支持的真实场景，且权限交互面已有修复迭代。
3. **功能缺口单**（issue #1474，2026-10-07，open）：omo-slim 的 `/preset` 是 TUI-only 命令，**openchamber 的命令列表只来自 OpenCode server command API，看不到 `/preset`**——提出服务端化。即预设切换在面板侧目前要手改 JSON。
4. **社区 fork**：pxzleo/oh-my-opencode-slim 自述含 "OpenChamber compatibility fixes"（单 commit squash，2026-08-27，基于 V2 时代代码，中文 commit：子任务续跑/权限透传/宿主 MCP 优先级等）；另有 `tuancon254/oc2-omo-slim-template`（opencode v2 + omo-slim 模板）。均为非官方周边，不改变上游判断。

**定位总结**：omo-slim 是**纯 opencode 引擎侧组件**。openchamber 对它没有（也不需要）专门 API；面板只是经 OpenCode server 的会话/命令/权限面间接看到它的效果。openchamber 的缝是：a) 配置目录挂载（`~/.config/opencode`）；b) entrypoint 的 OMO 开关（针对上游版）；c) server command API（目前缺 `/preset`）。

## 4. 接入判定（按三机分工）

**判定：能接入 —— 且接入面 100% 在 EL7 被控端，与面板宿主 OS 无关。**

按用户拓扑（Win/Mac 跑 openchamber 面板；EL7 被控端跑 opencode v2 + ocrc 插件住配置数组）：

| 层 | 落点 | 说明 |
|---|---|---|
| omo-slim 本体 | **EL7 被控端**，opencode v2 配置的 `plugins:`（v1 语义为 `plugin`）数组 | 纯 Node 包 + agent/skill 配置资产，随被控端 opencode 进程加载生效。与 ocrc IM 通道插件**同位共存**（两个数组条目，互不冲突；ocrc 走 CardBus/IM 通道，omo-slim 走 agent 编排，触碰面不同） |
| openchamber 面板侧 | Windows/Mac，**无需任何集成** | 面板经 OpenCode server 间接看到编排效果；但 `/preset` 不可见（#1474），切预设要手改被控端 `oh-my-opencode-slim.jsonc` |
| ocrc 侧 | **无需改动** | ocrc 不改 opencode 内核、只经官方插件机制；omo-slim 是另一个官方机制内的插件。风险点仅在共存的插件间事件/权限面（见下） |

**依赖与风险清单**：

1. **opencode v2 ≥ 2.0.7**：omo-slim v3 对 v2 宿主的硬下限（其 v2 兼容文档明示，旧 v2 不支持）。
2. **EL7 运行时可行性待验**：omo-slim 依赖 `@ast-grep/cli`、jsdom、turndown 等（8.2MB unpacked），Node 版本要求与 glibc 2.17 下 ast-grep 原生二进制能否跑，需在被控端实测——**这是唯一真正的接入风险**，opencode 本体已实测可跑不代表插件依赖链可跑。官方 Docker 镜像（openchamber entrypoint 路径）可作为替代：把 EL7 当宿、容器跑 opencode+插件。
3. **权限面竞态已知已修**：OpenChamber Safety Net × omo-slim 后台子任务权限等待的竞态（#1435）在 3.0.2 后修复链已收敛；接入时锁 ≥3.0.4 并复测权限审批流。若 openchamber 面板侧也开自动批准，需复验同款竞态。
4. **`/preset` 面板不可见**（#1474，open）：预设切换暂无法从 openchamber 触发；短期可接受（手改配置 + 新会话生效），长期可跟踪上游把命令注册到 server command API。
5. **license 无障碍**：MIT，可随 ocrc 分发链打包/引用。
6. **与 ocrc 的 N 系列分层相容**：omo-slim 属「引擎侧配置资产」，对着 opencode 官方插件机制生效；若 ocrc 面板想展示其子代理活动，属卡片流增量（sdelta 里已有 task/子会话语义可映射），非必须。

**一句话**：omo-slim = MIT 的 opencode 多代理编排插件（oh-my-opencode 的精简社区延续版），接进去 = 在 EL7 被控端 opencode v2 配置 `plugins` 数组加一条，openchamber 面板与 ocrc 均零改动；前置条件是 v2 ≥ 2.0.7 + EL7 上插件原生依赖实测通过。

## 附：证据索引（均为 2026-10-14 实测抓取）

- `npm view oh-my-opencode-slim` → 3.0.4 / MIT / 122 versions / published 3 days ago / deps pin `@opencode-ai/*` 1.18.32
- `gh repo view alvinunreal/oh-my-opencode-slim --json` → 9504★ / 580 fork / MIT / pushedAt 2026-10-13 / homepage ohmyopencodeslim.com
- README（master）：Manual Installation（写 `plugin` 数组）、配置文件 `~/.config/opencode/oh-my-opencode-slim.json`、v2 host 行为段
- docs/opencode-v2-compatibility.md（master）：v1/v2 双导出、v2.0.7+ 下限、`@opencode/plugin` 2.0.18 mirror pin
- openchamber/openchamber `scripts/docker-entrypoint.sh` L52-64 + `docker-compose.yml` L29：`OH_MY_OPENCODE=true` 自动装 oh-my-opencode
- alvinunreal/oh-my-opencode-slim issue #1435（closed，OpenChamber 2.1.0 共存竞态）、#1474（open，openchamber 看不到 `/preset`）
- `gh search code "oh-my-opencode" --repo openchamber/openchamber` → entrypoint/compose 命中
- pxzleo/oh-my-opencode-slim（fork，squash 单提交 "OpenChamber兼容"）——非官方参考
