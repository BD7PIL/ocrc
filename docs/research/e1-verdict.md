# E1 实验结论：omo-slim EL7 接入 + ocrc v2.0.27 健康 + 双写规则

- **日期**：2026-10-14
- **环境**：EL7/glibc 2.17 本机，隔离 PREFIX `/tmp/e1-lab`（HOME/OCRC_HOME 独立，端口 4597 引擎 + 4310 stub LLM，TG 用测试 bot B，零生产接触）
- **方法**：opencode 2.0.27 经 npm tarball 安装（`@opencode/cli-linux-x64`，sha512 integrity 校验通过——bin-cache 校验算法实测可行）→ `plugins` 数组注册 omo-slim@3.0.4 + ocrc@1.0.0-rc.4（本地 symlink 安装）→ python OpenAI 兼容 stub LLM 驱动真实编排。

## 结论速览

| 实验 | 判定 | 关键证据 |
|---|---|---|
| E1-1 omo-slim EL7 接入 | ✅ **可接入（有降级）** | `loading plugin id=oh-my-opencode-slim` + 13 个 agent 注入（orchestrator/explorer/librarian/oracle/designer/fixer…） |
| E1-2 编排 metadata 摸底 | ✅ **超预期：全语义化可行** | v2 原生 `parentID` 会话树 + `subagent` 工具 part 的 `state.metadata.sessionID` + `/api/event` 单流全带路由 |
| E1-3 ocrc 插件 v2.0.27 健康 | ✅ **全绿** | `v1.0.0-rc.4 starting (V2 setup)` → PRIMARY → web transport :4099 → TG polling → 卡片流（streaming/assistant 卡）端到端 |
| E1-4 双写冲突 | ⚠️ **分键而治规则确立**（有真实覆盖风险） | 见下 |

## E1-1：omo-slim 在 EL7 的原生链生死

- **ast-grep 原生二进制不能跑**（`GLIBC_2.29` required，本机 2.17）——但 **omo-slim 仍正常加载运行**：ast-grep 是懒加载工具依赖（`@ast-grep/cli` 在用到 AST 工具时才拉起），jsdom 同为懒加载且有官方「非致命失败契约」（`probeJSDOM` 返回 null 不炸插件）。
- **降级面**：omo 的 AST 类工具（@ast-grep 路径）在 EL7 上调用时会失败；编排主链（orchestrator 分派、subagent、文本工具）不受影响。
- **msgpackr 原生件可跑**（glibc .node 无缺失符号）。
- **引擎行为注意**：v2 引擎对 `plugins` 数组里的包名走 `.cache/opencode/npm/<pkg>@latest/` 自动安装路径，但**本地 symlink 安装的包也能解析**（`file:///...node_modules/oh-my-opencode-slim/dist/server/index.js` 与 cache 路径两种加载都观测到了）。air-gap 环境要求 node_modules 完整落盘。
- **结论**：omo-slim 可进 air-gap bundle，带「AST 工具不可用」的如实标注。

## E1-2：编排结构的 metadata 底细（omo 视图扩展的地基）

**不需要解析 omo 私有 metadata**——v2 引擎原生暴露了完整编排语义：

1. **会话树**：`GET /api/session` 列表每项带 `parentID`；子会话带 `agent`（如 `explorer`）、`outcome: succeeded`、`title`（= 分派的 description）。
2. **工具 part**：父会话 assistant 消息里 `subagent` 工具 part：`state.input.{description,prompt,agent}` + `state.metadata.{sessionID,status,truncated}`——树节点→子会话的直接映射。
3. **事件流**：`GET /api/event`（v2 单一全局流）事件带 `location.directory` + `data.sessionID`；子会话事件带 `parentID`；`session.tool.called/step.started/usage.updated` 全可观测。
4. **metadata 写入语义**：`PATCH /api/session/:id` 带 `metadata` 字段 → 204，读回原样——openchamber 的 `metadata.openchamber.*` 命名空间与 ocrc/omo 自定义标记都在这上面走。
5. **工具名更正**：v2 分派工具叫 **`subagent`**（参数 `agent`），不是 1.x 的 `task`（`subagent_type`）——引擎字符串明示 "The `subagent` tool takes `agent` instead of `subagent_type`"。

**结论**：批次 2 的 omo 视图扩展按「读会话树 + subagent parts + 事件流」全语义化设计，无需防御性解析 omo 内部格式。

## E1-3：ocrc 插件在 2.0.27 的健康（此前只在 2.0.15 验过）

日志链（`/tmp/e1-lab/home/.ocrc/ocrc.log`）：

```
v1.0.0-rc.4 starting (V2 setup)
became PRIMARY (pid …, role=plugin)
transport=telegram, web=true, port=4099, baseUrl=(in-process)
web transport listening on http://0.0.0.0:4099
card received: kind=streaming … kind=assistant … complete
bot polling as @OC_V93KVM_B_bot   ← 测试 bot B（生产为 A bot，指纹已比对确认不同）
```

- Web API 带 token 访问 200（`/api/version` 返回 version/mode=plugin/uptime）。
- V2 setup 路径、选举锁、transient gate（`opencode run` stand-down）在 2.0.27 全部按设计工作。
- **安全审计记录**：ocrc 经 `PLUGIN_ROOT/.env`（symlink 到仓库根 `.env`）加载了测试 bot B token——符合「零生产流量」铁律，但暴露一个机制：**插件会读自身安装目录的 .env**，隔离实验与未来 bundle 打包都要意识到这条通道（bundle 不得夹带 .env）。
- 附带发现：2.0.27 的 compaction 摘要模板校验严格（stub LLM 回复不匹配模板时 `Failed to drain Session`）——真 LLM 不受影响，属 stub 伪影。

## E1-4：双写冲突实验（ocrc install vs openchamber managed 物化）

实测矩阵（同一份 `opencode.json`）：

1. **v1 `plugin` 键 vs v2 `plugins` 键并存**：v2 引擎**两个键都解析** → ocrc 在同一 run 被加载 2 次（第 2 次为 worker 上下文重载）。`V2 setup` 只执行 1 次——PRIMARY 选举锁按设计兜住了双实例化，但启动开销/日志翻倍真实存在。
2. **openchamber 物化覆盖风险（实锤）**：若 managed 物化往 v1 `plugin` 键写**对象形态**（`{"@openchamber/managed-tools": [...]}`），会把 ocrc install 写的 v1 **数组**整体覆盖。
3. **metadata PATCH 共存**：`PATCH /api/session` 的 metadata 是合并语义（实测 `ocrc-test` 标记落盘不破坏其他键）。

**分键而治规则（写入 D1 实现契约）**：
- ocrc install 在 v2 环境只写 `plugins` 数组键，**绝不写 `plugin`**；
- uninstall 清理两个键里的 ocrc 项（对历史遗留双键用户做双向清理）；
- v1 `plugin` 键让渡给 openchamber managed 物化；
- CI 回归加断言：「plugins 数组含 ocrc + managed 物化后仍含 ocrc」。

## 对批次 1 开发阶段的修正输入

- D1 范围确认：install/uninstall 改 `plugins` 键（E1-4 规则）；无需动 dual-export/transient gate（E1-3 全绿）。
- D2 确认：npm tarball + sha512（hex→bytes→base64 去换行比对）算法本实验已走通。
- 新增小项：ocrc 卡片流的 `subagent`/`task` 工具名映射需在 V2 事件图里核对（`event-map.ts` 已有 V2→V1 归一层）。
- 证据文件：`/tmp/e1-lab/`（agents.json、msgs-final.json、events2.txt、dual-write-result.txt、pw.env 已脱敏需求——**含测试 token，交付前删除**）。
