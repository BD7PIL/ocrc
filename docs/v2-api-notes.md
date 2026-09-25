# V2 插件 API 调研笔记（P1 工作文档）

| 字段 | 值 |
|---|---|
| 日期 | 2026-09-25 |
| 来源 | opencode.ai/v2/docs/build/plugins/migrate-v1（官方迁移指南）、`@opencode-ai/plugin@0.0.0-beta-19271` dist 类型、其内嵌 `@opencode-ai/client@0.0.0-beta-19271` generated 类型 |
| 结论 | **P1 全部前置调研完成，预算卡点未触发**（resolvePermission 调研 ≈ 30 分钟，远低于 0.5 天线） |

## 1. dual-export 的官方地位（关键确认）

官方迁移指南原文要点：**"包可暂时同时暴露 V2 `setup()` 与 V1 `server()`（V1 对象入口需 OpenCode 1.18.29+），但两者 API 不会自动互译。"**

→ 计划 §7.1 的 `{id, server, setup}` 单对象形态是**官方支持路径**，本机 V1=1.18.32 ≥ 1.18.29 满足条件。两套 API 需各自实现（这正是 ControlPlane 的价值）。

## 2. V2 插件入口与 ctx 形状

```ts
import { Plugin } from "@opencode/plugin"   // 仅 beta dist-tag（0.0.0-beta-19271），V1 线 latest=1.18.32
export default Plugin.define({
  id: "ocrc",
  async setup(ctx) { /* ... */ return cleanupFn }
})
```

`Context` 关键成员（`dist/promise/plugin.d.ts`）：

| 成员 | 类型 | ocrc 用途 |
|---|---|---|
| `ctx.event` | `Pick<EventApi,"subscribe">` | `subscribe(requestOptions?) → AsyncIterable<V2Event>` |
| `ctx.session` | `Pick<SessionApi, "create"\|"get"\|"switchAgent"\|"switchModel"\|"prompt"\|"generate"\|"command"\|"synthetic"\|"interrupt"\|"rename"\|"move"\|"wait"\|"context">` | sendPrompt / listSessions(部分) / abort |
| `ctx.permission` | `Pick<PermissionApi,"list"\|"get"\|"reply"> & { hook }` | resolvePermission |
| `ctx.location` | `Location.Info` | directory（P2a directory 路由的关键） |
| `ctx.app` | `{ name, version, channel }` | 无 serverUrl |
| `ctx.generate` | 仅 `text()` | 无 listSessions |
| `ctx.rpc` | 插件自定义 RPC 注册 | 非任意服务端调用 |

## 3. 五动词 ControlPlane 的 V2 映射（全部落实）

| ControlPlane | V2 实现 | 证据 |
|---|---|---|
| `resolvePermission(sid, rid, d)` | `ctx.permission.reply({ sessionID: sid, requestID: rid, reply: d })` | `PermissionReplyInput`（types.d.ts:7675）；**`PermissionReply = "once" \| "always" \| "reject"` 与 V1/OCRC 完全同语义，零映射** |
| `sendPrompt(sessionId, text)` | `ctx.session.prompt({ sessionID, id?: {text, files?, agents?...}, ... })` | `SessionPromptInput`（types.d.ts:5119） |
| `listSessions()` | **ctx 无 session.list**（Pick 未含）→ 方案：事件驱动登记表（`SessionCreated/Renamed/Deleted` + 按需 `session.get`）；P2a 再评估 | SessionApi 的 Pick 集清单 |
| `subscribeEvents(cb)` | `for await (const e of ctx.event.subscribe({ signal }))` → 归一化 → cb；`AbortController` 清理 | 迁移指南示例 + `EventSubscribeOutput = V2Event` |
| `serverUrl` | ctx 不暴露 → V2 侧置空/可选（selectTuiSession 是 V1-only 能力，capabilities 声明） | App 类型仅 name/version/channel |

## 4. V2 事件宇宙（V2Event 联合，types.d.ts:3157）

权限：
```ts
PermissionAsked = {
  id, created, metadata?, type: "permission.asked", location?: LocationRef,
  data: { id /*=requestID*/, sessionID, action: string, resources: string[], save?: string[], metadata? }
}
```
→ **证实计划 §7.3 字段更名**：V1 `{permission, patterns}` → V2 `{action, resources}`。`PermissionReplied` 事件存在（供「别处已答」清理）。

状态四态（证实 §7.3 执行态映射表）：
`SessionExecutionStarted | SessionExecutionSucceeded | SessionExecutionFailed | SessionExecutionInterrupted`（另有 `SessionIdle`、`SessionStatusUpdated`）。

其余丰富事件：`SessionCreated/Deleted/Renamed/Forked/Moved/UsageUpdated`、流式族（`SessionStepStarted/Streamed/Ended`、`SessionTextDelta`、`SessionToolCalled/Progress/Success/Failed`）、`McpStatusChanged`、`VcsBranchUpdated` 等 → P2c/P2a 可直接消费。

事件携带 `location?: LocationRef` → **P2a directory 路由（S9 结论）在事件层有原生支撑**。

## 5. 配置注册差异

- V1：`"plugin": [...]`；V2：`"plugins": [...]`（本地插件 tuple → `{package, options}` 对象）
- V2 同时发现 `.opencode/plugin/` 与 `.opencode/plugins/`；全局 `~/.config/opencode/plugins/` 仍有效
- 每插件需稳定 `id`（storage 按 id 隔离）；`ctx.location.directory/project.id` 可用

## 6. P1 实现要点（据此直接开工）

1. `src/plugin/v2/types.ts`：本地结构类型（Plugin.define 形状、ctx 域切片、V2Event 子集：PermissionAsked/Replied/Execution四态/SessionCreated/Idle）——**不装 beta 包**。
2. `control-plane.ts`：五动词接口（计划 §7.2 原文）。
3. `v2-backend.ts`：实现 `src/core/agent/backend.ts` 接口的 V2 版（prompt/abort/resolvePermission/getMcp(ctx.mcp?)/listSessions(事件登记)），能力诚实声明（TUI 导航等 V1-only → false）。
4. `entry.ts`：default 导出改对象 `{id:'ocrc', server(V1 路径，现逻辑), setup(V2 路径)}`；两路径共享 startCore 的 relay/CardBus/transports。
5. 事件归一化：V2 事件 → V1 形状（`{action,resources}`→`{permission,patterns}`、Execution四态→`session.status`），**不改核心消费者**（opencode-events.ts/normalizer）。
6. 回归铁律：动 adapter 必 V1+V2 双侧跑。

## 7. 风险与开放项

- V2 权限模型的 `permission.evaluate` hook 是**判定点**（策略钩子）——按 §9 红线我们**不使用**它做判定，只消费 asked 事件 + reply 回批；OmO 共存无冲突。
- V2 binary 冒烟尚未做（A3 门禁：`objdump -T` max GLIBC ≤2.17 复验）→ P1 验收第一步。
- V2 启动模型是「后台 service + `opencode pair`」，`opencode web` 子命令是否存在待实测；验收路径可能变为 service 启动 + pair 出 web。
