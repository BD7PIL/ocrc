# deep-memory v2 兼容判决（E5 spike，e5-lab 隔离栈）

- **日期**：2026-10-15
- **性质**：批次 E5 spike 归档。被测对象 = 本地 `opencode-deep-memory` 0.14.1 源码构建（`/home/demo/develop/opencode-plugin/opencode-deep-memory`），宿主 = opencode v2.0.27（`/tmp/e5-lab`，HOME 隔离 + stub LLM :4310 + 引擎 :4398 + 假 TG 凭据；生产 :4096/:4199 零接触）。
- **方法**：探针式 wrapper（`/tmp/e5-lab/dm-probe/index.js`，六轮迭代）逐面取证：加载契约 → hook 注册面 → 注入语义 → compaction 链路 → 缓存行为。stub LLM 记录每轮完整请求体 + SHA-256（`/tmp/e5-lab/reqlog/requests.jsonl`，51 条）。

## 1. 加载契约（🔴 断裂 → 🟡 可桥接）

| 项 | v1（0.14.1 现状） | v2.0.27 实测 | 判定 |
|---|---|---|---|
| 导出形状 | `{ id, server: async(input)=>Hooks }` | `{ id, setup \| effect }`；返回值必须是 **disposer 函数**；返回 hooks 对象被**静默丢弃** | 🔴 直接装不上（`Plugin must export a default definition with an id and an effect or setup function`） |
| setup input | `{ directory, serverUrl, client }` | 庞大 ctx 面：`app/location/options/agent/aisdk/command/event/experimental/generate/model/provider/integration/mcp/permission/plugin/reference/rpc/skill/storage/tool/vcs/websearch/worktree/session/shell`；**无 directory/serverUrl/client** | 🔴 三字段全断；`location.directory` 可映射（omo `resolveV2Directory` 同款）；client 无对应物（见 §3） |
| 注册键 | `plugins`（V2 键） | 接受目录路径（解析 `<dir>/index.js`，无视 package.json main） | 🟢 一致（E2 结论复证） |

## 2. hook 红绿灯（核心发现）

v2 的 hook 注册走 **ctx 子系统面**：`ctx.session.hook("context"|"prompt"|"compaction"|"model.request"|"retry", handler)`、`ctx.event.subscribe`、`ctx.tool.transform/hook`、`ctx.agent.transform`、`ctx.skill/mcp/command.transform`。v1 的 7 类 hooks 对象全部需要重接线：

| v1 hook | v2 去处 | 红绿灯 | 证据 |
|---|---|---|---|
| `experimental.chat.system.transform` | `ctx.session.hook("context")` 的 `event.system`（`{type,text}[]`） | 🟡 需桥接，**同步变更才落地**（见下） | marker 实验：push/reassign 均落地 |
| `experimental.chat.messages.transform` | 同上，`event.messages`（`{info,parts}` 需映射） | 🟡 同上 | omo 桥同款（`createSessionContextHandler`） |
| `experimental.session.compacting` | `ctx.session.hook("compaction")`，event = `{sessionID, model, system, messages, options, agent, tools}` | 🟡 需桥接 + **client shim**（§3） | E5-3 全链跑通（§4） |
| `chat.params` | 无直接对应（`session.hook("prompt")` / `model.request` 就近替代） | 🟡 降级可接受（仅记录 session→agent/model） | ctx 面枚举 |
| `event`（idle/compacted/deleted） | `ctx.event.subscribe` | 🟢 存在 | 注册成功 |
| `tool` / `tool.execute.after` | `ctx.tool.hook(name, fn)` | 🟢 存在 | 注册成功 |
| system prompt 注入内容 | `{type,text}` 块，`<deep-memory-stable>` 标签内容**不被剥离** | 🟢 落地 | delta-only 实验 |

**⚠️ 最重要的语义发现（async 丢失）**：v2 的 context hook **不 await handler 的 promise**——handler 内首个 `await` 之前的同步变更才生效。纯同步 marker 落地；加一个 `await Promise.resolve()` 后同样的变更丢失。dm 的 v1 handler 全是重 async（fs I/O + mtime 检查）→ 直桥必败。**移植模式定为**：「prompt hook（宿主会 await，omo 同款）预热缓存 → context handler 纯同步应用缓存」。桥的 warm→apply 迭代中还有一个 `sysT-in-handler` 时序怪象（在 handler 内调用 sysT 后 mutation 失常；time-box 未查明，复现现场保留在 /tmp/e5-lab，D2 首项解决）。

## 3. client 断裂（🔴 → 🟡 shim 可解）

- dm 用 `input.client.session.messages({path:{id}})` 抓全量消息（compaction 捕获）、`client.session.create/promptAsync`（idle 整理子会话）、`client.config.get()`（模型兜底）。
- v2 setup ctx **不提供 v1 形状的 client**。`client.config.get` 缺失 → 非阻塞警告（已有兜底）；`client.session.messages` 缺失 → compaction 捕获失败跳过。
- **shim 实证**：fetch 版 client（v2 API `GET /api/session/{id}/message` + Basic auth + 消息形状映射 `{info:{role,...}, parts}`）下，**capture → checkpoint 全链跑通**（§4）。D2 交付物应内置 v2-native client 适配层（优先 ctx.session 直接调用，fetch 兜底）。

## 4. compaction 链路（🟢 全绿——招牌功能在 v2 可用）

强制 `POST /api/session/{id}/compact` 后（桥接 + client shim + 消息形状映射三件套）：

```
[compacting] compacting hook: capturing messages
[compacting] captureMessages: wrote raw checkpoint {"messageCount":10, rawFilePath: …/checkpoint.raw.json}
[compacting] writeCheckpoint: wrote checkpoint {filePath: …/checkpoint.md}
[compacting] compacting hook: checkpoint written
```

- `checkpoint.raw.json`（全量消息）+ `checkpoint.md`（启发式抽取，`User Intent` 等 section）双双落盘。
- v1 handler 输出 `output.context`（2 条：HANDOFF 前缀 + checkpoint 路径指引）+ `output.prompt`（结构化压缩 prompt，<20 条消息时不启用）——桥接层把它映射进 v2 event 的 system/messages。
- 消息形状差异一处：v2 API 消息为扁平 `{id, role, content}`，v1 期望 `{info, parts}`——shim 内映射解决（`msg.info.role` 错误消失）。

## 5. 缓存行为实测（E5-4，回应缓存约束）

- **注入字节稳定性**：`payloadSize:1035` 在全部 **97 次注入中恒定**（dm 自身 cacheHit 机制 + mtime 缓存生效）——MEMORY.md 不变时注入块逐字节稳定，跨轮可缓存。请求侧哈希佐证：同 run 内 system 前缀哈希恒定（`7ffe8847c173` 贯穿 30+ 请求）。
- **降噪幂等性**（合成 25 条消息数组直测 dist 产物）：第 1 次 transform 有变更（剥 `<thinking>` / 截断旧 tool error），**第 2 次零字节变化**——「一次性改写后重新稳定」成立，每条被改消息只付一次 cache miss。
- **nudge/压力**：stub 会话 <50K 未触发（机制存在，未达阈值）。
- **结论**：dm 的缓存设计在 v2 下成立；缓存友好约束满足。

## 6. 判决（决策门 1）

**🟢 进 D2**（断裂可控，无结构性死穴）：

1. 加载契约断裂有明确映射（setup/disposer/location.directory），omo 的 v1→v2 桥是完整参照实现。
2. 招牌功能（compaction checkpoint + 上下文重建）在桥接 + client shim 下**全链实证可用**。
3. 缓存设计（注入字节稳定 + 降噪幂等）实测成立，符合用户的缓存友好约束。
4. 遗留问题两项，均为 D2 工作项而非阻塞：① `sysT-in-handler` 时序怪象（复现现场保留）；② idle 整理的 `session.create/promptAsync` 子会话通道未测（需要 v2-native client 适配层）。

**D2 范围据此微调**：v2-native 适配层（setup 契约 + client 面双适配）替代「逐 hook 搬运」；缓存回归套件新增「context hook 同步性」不变量测试（handler 内 await 前 mutation 必须完成，或走 prompt-预热模式）。

## 7. 复现现场（保留至 D2 完成）

- 隔离栈：`/tmp/e5-lab/`（`start-engine.sh`、`dm-probe/index.js` 六轮探针、`reqlog/requests.jsonl` 51 条请求体、`stub-llm.py` 带请求日志版）
- 关键日志：`/tmp/e5-lab/home/.config/opencode/deep-memory-debug.log`（`DEEP_MEMORY_DEBUG=1`）
- 产物：`/tmp/e5-lab/proj/.deep-memory/{MEMORY.md, checkpoint.md, checkpoint.raw.json}`
