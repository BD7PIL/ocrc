# omo-slim 配置面：键名、热重载、发现顺序、写路径（批次 5.1 调研归档）

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **日期**：2026-10-15
- **性质**：批次 5.1（omo-slim 配置的 UI 控制）的调研 + E4 spike 实证归档。所有结论一手源：omo-slim 3.0.4 包内源码/schema（e1-lab npm 缓存）+ e2-lab 隔离栈实测（HOME=/tmp/e2-lab/home，引擎 4398，stub LLM 4310）。配套实现：`extensions/ocrc-remote` 0.4.0 的 `/omo/config` 端点 + 面板「omo 编排」区块。

## 1. 配置文件机制

| 事实 | 结论 | 来源 |
|---|---|---|
| 文件名/位置 | 被控端 `~/.config/opencode/oh-my-opencode-slim.json` **或** `.jsonc`（双格式支持） | omo-slim 源码 + E4 实测 |
| installer 生成格式 | **`.json`**（`--no-tui` 非 TUI 模式实测，2 250 B 基准文档） | E4-1 实测 |
| 活跃预设 | 顶层 `"preset"` 字符串键 = `presets` 对象的键名 | 源码 + schema |
| installer 首装行为 | 同时改写 opencode.json：**加 `"plugin": ["oh-my-opencode-slim"]`（V1 键）+ 关 explore/general 内置 agent + lsp:true**，另写 tui.json | E4-1 实测 |
| V1/V2 分键 | v2.0.27 引擎接受 V1 `plugin` 键加载 omo（与 ocrc 的 V2 `plugins` 分键而治），agents 面出现全部 6 个 omo 代理（orchestrator/oracle/librarian/explorer/designer/fixer） | E4-1 实测 |
| fallback 缺省 | 基准配置**无 fallback 段** = schema 默认（enabled:true, maxRetries:3, initialRetryDelayMs:0, retryDelayMs:500, continuationPolicy:"retry-primary"） | schema 1570-1609 行 + E4 |
| per-agent 模型链 | `presets.<名称>.<agent>.model`（字符串或数组=链），另有 variant/skills/mcps | installer 生成的两预设对照 |
| 内置预设 | installer 只生成 `openai`、`opencode-go` 两个；`--preset` 只改活跃键 | installer --help + 实测 |

## 2. 热重载（E4-2 铁证）

外部改配置文件 → omo 插件自身 watcher（非 v2 宿主 config watcher）触发：

```
[2026-10-15T01:53:22.033Z] [plugin] runtime profiles refreshed from disk {"agents":6}
[2026-10-15T01:53:22.034Z] [v2] runtime profiles refreshed {"agents":6}
```

- **两次独立实证**（改 `preset` 键；改 fallback+variant），延迟 <1s（fs.watch + 300ms debounce 语义）。
- **坏配置拒绝换入**：写入 `{ this is not valid json !!!` 后日志出现 `runtime profile refresh from disk failed "config load failed: invalid-json …"`，last-known-good 保留；恢复好文件立即恢复 refresh。→ 桥端点必须服务端先 JSON 校验（422 不落盘），与该语义对齐。
- **不热变的面**：`/api/agent` 注册面（11 agents）在 preset 切到多一个 observer 代理的 opencode-go 后**不变**——代理注册发生在插件加载时，热重载只作用于推理字段（model/variant/temperature/options）与 fallback，对**新的编排子会话**生效。
- **写入的扩展名策略**：`.jsonc` 注释无法在 JSON.stringify 往返中存活。实测决策：**保留原扩展名写入**（若原为 .jsonc 仍写 .jsonc，注释丢失并在响应 `commentsWillBeLost:true` 告知；不写 .json——omo 读侧 .jsonc 优先，留双文件会让新写入被静默忽略）。

## 3. 发现顺序与写路径

- **读**：用户层（`~/.config/opencode/oh-my-opencode-slim.json[c]`）+ 项目层（`.opencode/`）逐层合并，项目层 scalars wins；`.jsonc` 优先于 `.json`。v2 宿主 fs.watch 热重载只监听用户层文件。
- **`/preset` TUI 命令**：只往**用户层**写 `preset` 键；用户层文件不存在时该命令直接失败——本桥的结构化写同样要求远端已有基准配置（409 提示先跑 installer）。
- **项目层**：随批次 4 工作区同步通道已可达（`.opencode/` 在工作区内），不做写 UI（明确不做清单）。

## 4. ocrc 桥实现对齐（0.4.0）

| 端点 | 语义 |
|---|---|
| `GET /omo/config?scope=user` | 服务端拼装远端路径（`$HOME/.config/opencode/oh-my-opencode-slim.json[c]`，不接受任意路径），base64 读回 `{exists, format, size, activePreset, presetNames, fallback, agentChains, parsed, schema(内嵌 vendor), commentsWillBeLost}` |
| `POST /omo/config` | body 二选一：`content`（原始 JSON 逃生门）或 `{preset, fallback}`（结构化）。服务端校验：坏 JSON / 负数重试 / 未知 fallback 字段 / 不存在的预设名 → **422/409 不落盘**；通过则 mktemp + `.ocrc-bak` 兜底 + mv 原子写；响应带备份路径与热重载 note |

vendor schema：`oh-my-opencode-slim.schema.json`（3.0.4 包根，MIT，68 KB）以 TS 模块内嵌（`src/service/omo-schema.ts`，重生成脚本 `scripts/vendor-omo-schema.mjs`），零网络、air-gap 可用。

## 5. 边界（明确不做，详见批次 5.1 计划）

- schema 驱动的 per-agent 模型链完整表单——第一版只读树 + 原始 JSON 逃生门；
- 项目层写 UI——读通即止，写入走工作区同步；
- 面板侧跑 omo installer——被控端一次性动作，文档化（`oh-my-opencode-slim install --no-tui`）；
- 在 ocrc 内重实现 `/preset` TUI——只对齐其持久化语义（写用户层 `preset` 键）。
