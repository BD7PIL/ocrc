# LLM 配置 / per-agent 模型 / fallback / MCP-skills 同步调研（批次 5 依据）

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- 日期：2026-10-15
- 性质：三向一手源查证（openchamber 源码级、opencode v2 2.0 分支源码+官方 schema、omo-slim 仓库文档级），回答用户六问并立项批次 5「配置与凭据桥」。
- 落地记录：本批次交付（第五工具 / env 注入 / 白名单修订 / ocrc-remote 配置桥）。

## 1. openchamber 有没有 LLM KEY 配置？

**有，完整 UI，但刻意只做薄客户端**。Settings → Providers：每 provider 的 key 表单、OAuth/设备码、自定义 OpenAI-compatible provider（`packages/ui/src/components/sections/providers/`）。保存路径（代码实证）：经**引擎自己的 `/api/credential` HTTP API**（`ProvidersPage.tsx` → `integration.connect.key()`），openchamber 从不直接读写 auth.json 文件；`routes.js` 对 credential-listing 请求直接 403（`credential_list_refused`），文档原话 "Provider sign-ins are stored by OpenCode, not OpenChamber"。它写进 opencode.json 的 provider 块不含 secrets，key 字段支持 `{env:VAR}` 引用。仅 Google 有 env 别名镜像（`provider-env-aliases.js`）。

## 2. 能不能给每个 subagent 配 LLM？

**能，三层**：
1. **openchamber Agents 页**：per-agent 持久化 model+variant 编辑，写 `~/.config/opencode/agents/<name>.md`（平铺复数目录，`getUserAgentPath`）或 opencode.json agents 段（`writeSectionEntry`），可覆盖内置 build/plan（`AgentsPage.tsx`）。
2. **引擎原生**：opencode.json `agent.<name>.model`（v2 单数键，schema 实证），`mode:"subagent"`；未设置的 subagent 继承调用它的主 agent 模型。继承序：per-agent model > 全局 model。
3. **omo-slim**：`presets.<name>.<agent>.model`（每 agent 独立 `provider/model` 或数组链）；优先级 plugin config < 根 agents < **opencode.json（最终覆盖）**（`docs/configuration.md`）。

## 3. LLM 轮转 fallback（引擎 vs 面板 vs omo-slim）

| 层 | 跨 provider fallback | 有什么 |
|---|---|---|
| opencode v2 引擎 | **无**（schema 零 fallback 字段，搜证） | 仅同模型重试：2s 起指数退避 cap 30s、尊重 retry-after；429/5xx/传输错可重试，auth/quota/内容策略不重试（`session/retry.ts`） |
| openchamber | **无**（全库 failover 0 命中） | Auto Model Routing = Jev 分类按消息路由（Trivial/Research/Implement/Hard）+ 单一 fallback model（分类失败/超时/低置信才落）；"No retry loop"（`routing/DOCUMENTATION.md`） |
| omo-slim | **有** | `fallback.enabled/maxRetries/retryDelayMs/continuationPolicy` + per-agent model 数组链 + `ForegroundFallbackManager`（401/402/403/429/5xx 触发，重试预算耗尽推进链条，`downProviders`/`quotaExhaustedProviders` 健康跟踪）。**v2 宿主限制**：自动 foreground fallback 禁用（abort+重放待上游原子切换），改 in-place retry-hook 用 `session.switchModel` 原地换模型（官方兼容表 v1 ✅ / v2 ❌） |

## 4. 远程拉起的 opencode v2 怎么接收 KEY？（优先级 config > auth.json > env）

1. **隧道内引擎 credential API**：openchamber Providers 页对外部引擎即此路径，key 落 EL7 的 `~/.local/share/opencode/auth.json`（0600，`{type:"api"|"oauth",...}`）。
2. **ocrc `sync-auth`**（0.26 已有；批次 5 工具化为 `ocrc_remote_sync_auth`）。
3. **opencode.json 内联**：`provider.{id}.options.apiKey`，支持 `{env:VAR}` / `{file:PATH}` 替换（`config/paths.ts substitute()`）——air-gap 机可用 `{file:~/.secrets/key}`。
4. **标准 env**（models.dev 每 provider 的 env 清单，如 OPENAI_API_KEY / AWS_*）。注意：openchamber Settings 的 env 注入只达它自己 spawn 的引擎；external 模式须被控端自设——批次 5 的 `remotes.json` per-host `env` 字段（`buildExtraEnvExports` 单引号转义注入 serve 命令）补齐 ocrc 拉起场景。
5. **air-gap 形态 B**：key 放被控端本地 + `ssh -R` 代理出网（既有裁决，不变）。

## 5. omo-slim fallback（详见 §3 表格第三行）

配置文件：被控端 `~/.config/opencode/oh-my-opencode-slim.json[c]`（或项目级 `.opencode/`，优先级更高）。批次 5 已把它纳入 syncConfig 白名单——面板宿主与被控端的 omo fallback/模型链配置可同步。

## 6. MCP / skills 远端同步

- **引擎 v2**：skills 支持 `skills.urls`（拉 `{url}/index.json` 入缓存）= 官方唯一远端原语；另有 auth.json `wellknown` 条目远程拉 org 配置（含 env 注入 + MCP 默认）。MCP 无跨机同步（2.0 export/import 是会话导出）。
- **openchamber MCP 页**：全功能（local/remote、OAuth、mcpServers JSON 导入、状态徽标）但**写面板宿主磁盘**（`mcp.servers` 段）——外部引擎收不到。
- **omo-slim**：零同步；skills 已改插件进程内注册（旧盘拷贝 sync 退役），内置 context7/gh_grep 两个 HTTP MCP 自动注入。
- **ocrc**：syncConfig 白名单（批次 5 扩至 `agents`/`skills` 复数目录 + omo 配置）+ `ocrc_remote_sync_workspace`（任意目录）——该格是 ocrc 覆盖上游空白之处。

## 7. 批次 5 立项的缺口判定（本调研唯一新发现）

**openchamber UI 写的 agents/MCP/provider 配置落在面板宿主磁盘，外部引擎收不到**（key 例外——走引擎 credential API 能到）。上游路径实锤（源码级）：user 层 = `$OPENCODE_CONFIG_DIR > $XDG_CONFIG_HOME > ~/.config/opencode` 下的 `opencode.json`（优先 jsonc 若已存在），agents = 平铺 `<configDir>/agents/<name>.md`，MCP = 同文件 `mcp.servers`；每次写自带 `.openchamber.backup`；引擎 spawn 时注入 `OPENCODE_CONFIG=~/.config/openchamber/opencode.managed.json`（仅 plugins 数组层）。

**桥的机制（E3 实测定案）**：
- `OPENCODE_CONFIG` 附加层与全局配置**合并**（两层都进 document 列表；bridge 层 `agent` 段实测覆盖内置 agent 字段——E3 marker 实验通过）。选型仍取**分键合并写回被控端主 opencode.json**：不依赖 env、adopt 模式用户自管引擎同样生效、与 syncConfig 家族语义一致。
- 合并策略：面板段（agent/mcp.servers/providers）逐叶覆盖，被控端独有键全保留，ocrc 自有键（plugins 数组、mcp.ocrc）自然不碰；应用前远端 `.ocrc-bak` 兜底。

## 附：证据索引（全部 2026-10-15 抓取）

- openchamber `main`（post-2.3.2）：`packages/ui/src/components/sections/providers/ProvidersPage.tsx`、`packages/web/server/lib/opencode/{auth,providers,lifecycle,agents,mcp,shared,config-entity-routes,managed-config-file}.js`、`packages/docs/content/docs/{providers,mcp,auto-model-routing}.mdx`、`lib/routing/DOCUMENTATION.md`
- opencode v2（`2.0` branch，2.0.29）：`packages/opencode/src/auth/index.ts`、`provider/provider.ts`、`config/{config.ts,paths.ts}`、`session/{retry,processor,prompt}.ts`、`skill/{index,discovery}.ts`、schema `https://opencode.ai/config.json`、docs `/providers` `/config` `/agents` `/mcp-servers`
- omo-slim（master）：`src/config/{constants,schema,runtime}.ts`、`src/hooks/foreground-fallback/`、`src/cli/providers.ts`、`docs/{configuration,preset-switching,opencode-v2-compatibility,skills,mcps}.md`、`.out-of-scope/{preset-fallback,smart-routing}.md`
