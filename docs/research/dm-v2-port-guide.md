# deep-memory 0.15.0：opencode v2 适配与共存/缓存指南

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **日期**：2026-10-15
- **性质**：批次 D2/D3 交付文档。deep-memory v0.15.0（tag `v0.15.0`，commit 321b545）在自研项目 `opencode-deep-memory` 上落地 opencode v2 原生支持；配套 E5 spike 判决见 [dm-v2-compat-verdict.md](dm-v2-compat-verdict.md)，三项目对比见 [context-managers-dcp-headroom-deepmemory.md](context-managers-dcp-headroom-deepmemory.md)。
- **验收现场**：e5-lab 隔离栈（v2.0.27 + stub LLM），全链实测——原生加载、注入落真实 LLM 请求（stub 抓包逐 turn 可见 `<deep-memory-context>` 块）、强制 compaction 写 `checkpoint.md` + `checkpoint.raw.json`。生产 :4096/:4199 全程零接触。

## 1. v2 适配要点（移植时踩过的坑，全部实测）

| # | 事实 | 对策（已实现于 src/v2/entry.ts） |
|---|---|---|
| 1 | v2 插件契约 = `{id, setup}`，setup 返回 **disposer**；返回 hooks 对象被静默丢弃 | 双形态导出：`default = {id, server, setup}`，v1/v2 宿主各取所需 |
| 2 | setup input 无 `directory/serverUrl/client`；有 `location.directory` | `location.directory ?? process.cwd()` 映射；client 走适配器（§2） |
| 3 | **context hook 不 await handler**——首个 await 之前的同步变更才生效 | prompt hook（宿主会 await）预热缓存 → context handler 纯同步应用；缓存跨 turn 存 `.deep-memory/.v2-warm-cache.json`（磁盘而非内存——跨调用内存态不可靠） |
| 4 | system[] 变更在 handler 内确认生效，但**不必然序列化进 LLM 请求**；user 消息 content 变更可靠落地 | 注入走 **user 消息尾部** `<deep-memory-context>` 块（payload 字节稳定，代价 = 每 turn 边界一次 cache miss） |
| 5 | compaction hook payload = `{sessionID, model, system, messages, options, agent, tools}`；v1 handler 期望 `(input, output)` 双参 | 桥接时构造 `output = {context:[], prompt}`，回填进 event.system |
| 6 | v2 API 消息为扁平 `{role, content}`，v1 期望 `{info, parts}` | client 适配器内规范化；`session.messages` 优先 ctx 面、HTTP 兜底（Basic auth 用 `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_PORT`） |
| 7 | `chat.params` 的 v1 handler 期望 `input.model.providerID`，v2 prompt event 没有 | 不桥（数据仅诊断用）；漏桥会在 turn 中抛 unhandled rejection 直接杀掉请求——这是 D2 验收抓到的最后一个坑 |

## 2. 缓存友好约束的落点（实测数据）

- **注入 payload 字节稳定**：`payloadSize:1035` 在 97 次注入中恒定（dm 自身 mtime 缓存）；MEMORY.md 不变 = 注入内容逐字节相同。
- **降噪幂等**：messages.transform 第一次有变更、第二次零字节（已固化为回归测试）——每条被改消息只付一次 cache miss，之后前缀重新稳定。
- **warm-cache 设计**：async 刷新在 turn N 计算、turn N+1 同步应用；缓存条目只增不覆盖（空 delta 不覆盖已有值——D2 修复的最后一个 bug 就是 prompt-hook 初始化把上一 turn 缓存抹掉）。
- **明确不做**：dcp（机制 = 每轮改写消息视图，README 自认击穿 prompt cache）；Sleev（闭源计费不可自审）。

## 3. 共存矩阵

| 组合 | 判定 | 依据 |
|---|---|---|
| deep-memory + **dcp** | ❌ **冲突** | 同挂消息改写面（v1 `messages.transform` / v2 context hook），双重改写顺序未定义；且 dcp 缓存不友好，缓存约束下本就出局 |
| deep-memory + **headroom** | ✅ **正交可叠加** | headroom 是传输层代理（改字节流），deep-memory 是插件层（改消息语义）；前者 live-zone 保前缀，后者注入块字节稳定——两层缓存策略同向。叠加收益未实测，需要时再启动 |
| deep-memory + **Sleev** | ⚠️ 不推荐 | 闭源网关 + 配额计费；Sleev 文档建议关掉 opencode 自带 compaction，与 deep-memory 的 compaction checkpoint 语义关系未定义 |
| deep-memory + **omo-slim** | ✅ 同栈已验证 | e5-lab 与 e2-lab 均为两者分别验证；omo 编排代理 + deep-memory 记忆层语义正交（一个管子会话编排，一个管跨会话知识）。同装未实测，装载顺序理论上无关 |

## 4. ocrc provisioning 集成建议（D3 交付项）

**现状**：ocrc 批次 5 的 syncConfig 白名单已含 `oh-my-opencode-slim.json`（omo 配置同步）；deep-memory 的项目级数据在 `<project>/.deep-memory/`，天然随 `ocrc_remote_sync_workspace` 的 tar 管道走（无新增白名单需求——它是工作区内文件）。

**建议（按优先级）**：
1. **零改动即用**：被控端 opencode v2 的 `plugins` 数组加一行 `"opencode-deep-memory"`（npm 发布后）或文件路径（本地 dist），无需 ocrc 代码改动。文档化到 OPS.md 即可。
2. **可选增强（不立项，待需求）**：`ocrc_remote_provision` 预设里加可选的 deep-memory 安装步骤（与 omo installer 同族）；`remotes.json` per-host 配置加 `deepMemory: {enabled}` 开关。触发条件：用户真的在远程引擎上长期使用记忆功能。
3. **数据面注意**：`.deep-memory/checkpoint.raw.json` 含全量会话消息（可能含敏感内容）——它随工作区同步走 tar 管道时，与代码文件同通道；若用户工作区含敏感项目，注意 sync 白名单不要扩散到全局级 `~/.local/share/opencode/deep-memory/`（现白名单未含，保持）。

## 5. 遗留项（非阻塞）

- **sysT-in-handler 时序怪象**（E5 遗留）：在 context handler 内调用 v1 systemTransform 后，同步 mutation 不落请求——D2 用「预热缓存 + 纯同步应用」绕开，未查明根因（复现现场 /tmp/e5-lab 保留至下批次结束）。
- **idle 整理子会话**（`session.create + promptAsync`）：client 适配器已实现映射（create/prompt 实测接受参数），但 idle 触发→子会话→回写 MEMORY.md 全链未在 v2 实测；v1 逻辑未动，风险低。
- **npm 发布**：0.15.0 已打 tag 推送 GitHub，npm publish 按惯例等用户点头。
- ~~**真机 E2E harness**~~ **已补齐（同日）**：`opencode-deep-memory/scripts/e2e-real-bugs.mjs`（`npm run e2e:real-bugs`，commit ffaef13）把 0.14.1 三真机 bug 场景化——① 真实工具调用形状（无 scope/type）的 memory_store 不崩；② 真实 `- content` 格式的写时去重命中 + 短行不误报；③ pending-consolidation 消费后同步落盘（走真实 spawn→consume→persist 流）。12 断言，exit 1 on failure。注意：子会话摘要内部的去重是 LLM 的职责（apply 经 validateConsolidation 后原文写入），脚本断言 apply 成功 + 条目保留 + 合并，重复折叠的单测回归在 tests/extract/consolidate.test.ts:296。
