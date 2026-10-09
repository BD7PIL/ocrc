# 下一阶段任务书：ZCode 体验面收口（2026-10-10）

> **来源**：2026-10-09/10 的 grill 裁决（主线=复刻收口；手段=插件钩子；能力长在 host；OmO 替换是副产品）。
> **事实基础**：①上游 ZCode 运行时源码逐文件读过（`/tmp/zcode-src/apps/zcode-cli`，goal 实现全链）；
> ②opencode 插件 API 1.18.34 类型面 + 1.18.32 引擎二进制核实（钩子清单在 §附录）。

## 0. 定位与边界（三句宪法）

- **主线**：`/z/` 里 ZCode 的每个体验面都真正跑起来。UI 面已复刻完（CHECKLIST 102✅），
  体验面还缺三块：**goal、闲时收尾、workflow 最小形态**——它们不是裁决不做，是数据链从来没接。
- **手段**：用引擎插件钩子补引擎没有的能力。**不改引擎代码、不 fork、不追 latest**（PRODUCT 边界）。
- **分层**：机制在引擎内（钩子：注入/门禁/触发），语义/状态/调度/UI 在 host。
  **手要薄**（只用官方钩子面）、**手可撤**（卸插件引擎立刻复原，不留痕）。
- **副产品**：能力长出来后 OmO（oh-my-openagent）自然可撤。**不设为目标、不排计划**——
  它上游已迁往 senpi 自有引擎（v5.1.x 全系），opencode 只是它兼容列里的一项。

## 1. 欠账清单（顺序即优先级）

1. **goal（目标循环）**——本文件 §2 完整设计
2. **闲时补齐**（N5 已有六成 → 十成，见 §3）
3. **workflow 最小形态**（单会话多步 + 人工审批点；重 schema 只点亮子集，见 §4）
4. **零散 🔶**（任务行转圈等，随批清，见 CHECKLIST）

## 2. goal 设计（对齐上游 + 明确标注 delta）

### 2.1 术语与权威

- 上游运行域名是 `target`、产品名 `goal`（同一实体）。我们统一叫 **goal**。
- **权威状态唯一落点 = host state.json 的 goal 槽位**（按 sessionId；与 pin/archive/taskGroups 同款模式）。
  上游权威是 SQLite `session_target` 表（`adapters/src/storage/session-target.ts`），我们是 host 状态文件——
  同样满足"跨重启恢复、多端同源"。
- **持久四态**（对齐上游运行时常量 `contracts/tools/target.ts:9-29`）：
  `active | paused | budget_limited | complete`
- **六态投影**：`verifying/verified/notSatisfied/failed` 是派生态，由 bridge 从四态 + 验收事件推导，
  喂 vendor `goalStateSchema`，**不落库**（上游同款：投影态从不落库，
  见 `product-projection.ts:4824-4837`）。

### 2.2 循环：触发与退出

**触发**（我们的等价物）：上游没有 idle 定时器——续跑是"一次前台命令结束后的显式后置循环"
（`target-continuation-loop.ts:45-86`）。我们引擎是 opencode，等价信号 = **`session.idle`**
（ocrc 已在消费：relay 定稿流式卡、push 推送 `Session finished`）。
→ **host 在 idle 后判断**：goal `active` 且无排队用户消息 且 非 plan → 拉起「验收 → 续跑」。

**退出条件（逐条对齐上游，全保留）**：

| 条件 | 上游位置 | 说明 |
|---|---|---|
| 有排队用户输入 | `target-continuation-loop.ts:56-58` | 让位给用户 |
| goal 非 active（含 budget_limited） | `target.ts:189-201` | 天然挡预算超限 |
| 验收 passed | `target.ts:106-115` | → complete |
| 验收 !passed 且无 nextAction | `target.ts:118-127` | **不把内部错误变成无限迭代** |
| 验收后重读：期间被 Stop/换目标 | `target.ts:128-145` | 防脏写 |

**续跑注入形态**：

- host 发一条 prompt 到同会话，文本前缀固定标记 `[ocrc-goal-continuation]`。
- bridge 在 `buildRows` 把带标记的 user 卡映射成 **`origin:'goalContinuation'`**
  （vendor row schema 原生支持：`rows.ts:111-118` userInput / `:65-71` turnHeader）→
  UI 按语义渲染，不混同真实用户气泡。
- **delta vs 上游**：上游是 model-only（UI 完全不显示）。我们让 UI 可见（可收敛为折叠行）——
  驾驶舱的定位要求"用户看得见机器在为目标干活"。若实测太吵，再切 model-only（去掉标记即可回退）。
- **注入内容**：照抄上游 `target_continuation` 提示词骨架
  （`contracts/tools/target.ts:137-194`）：objective 用 `<untrusted_objective>` 包裹 +
  预算四行（已用时长/tokens 已用/预算/剩余）+ completion audit 指引 + 明确"不要自称完成，
  运行时会验收"。保持与上游同文（跨 harness 一致性，原样英文）。

### 2.3 验收器（verifier）

- **形态**：单次 LLM 调用，`tools: []`，返回严格 JSON `{passed, reason, nextAction}`
  （上游 `target-completion-verification.ts:338-346`；提示词原文 `contracts/tools/target.ts:196-224`，照抄）。
- **模型**：默认 = 该会话当前模型（对齐上游）；新增配置项 `verifierModel` 可覆盖
  （**delta**：便于用便宜模型做验收）。
- **fail 语义——明确不照抄上游**（**delta，安全闸**）：
  - 坏 JSON / 解析失败：上游 **fail-open（passed=true）**（`target.ts:289-299`）——我们不接受，
    改为 **passed:false + 无 nextAction → 停循环并通知**（宁停勿误判完成）。
  - verifier 请求异常：passed:false 无 nextAction → 停（对齐上游 `target.ts:313-322`）。
  - 用户 Stop 且验收在飞：→ pause（对齐上游 `target-completion-verification.ts:238-265`）。
- **投影映射**（对齐上游 `product-projection.ts:4824-4837`）：
  验收开始→`verifying`；passed→`verified`；!passed 有 nextAction→保持 active 投影；
  !passed 无 nextAction→`notSatisfied`；异常终态→`failed`。
  注意：**verifying 期间底层仍是 active**（上游同款，投影注释 `projection-state.ts:143`）。

### 2.4 状态机迁移表

| # | 迁移 | 触发 | 副作用 |
|---|---|---|---|
| 1 | ∅→active | `/goal <objective>`（或 resume 已有 paused） | 落库 + 事件 + 起续跑 |
| 2 | active→complete | verifier passed | 落库 + 投影 verified |
| 3 | active→paused | 用户 Stop / 取消（当前轮被 abort） | 先落库 paused **再** abort（上游 `goal-compact.ts:381-386`） |
| 4 | active→paused | verifier 在飞时被取消 | 落库 paused |
| 5 | active→budget_limited | 记账后 tokens_used ≥ token_budget | 落库；循环因非 active 自然停 |
| 6 | paused→active | `/goal resume`（显式） | 落库 + **重起续跑** |
| 7 | 残留 run→paused | host 冷启动发现未收口的 active run | 结算时长后置 paused（上游 `recoverInterruptedSessionTargetRun`） |
| 8 | *→删除 | `/goal clear` | 删槽位 |
| 9 | plan 互斥 | plan 模式下 set/resume/续跑一律拒绝 | 对齐上游 `target.ts:194`、`goal-compact.ts:252-256` |

**关键语义**（对齐上游）：冷恢复**不自动重激活**——必须显式 resume；
pause = 停循环 + 停当前轮；resume = 重新激活 + 重起循环。

### 2.5 预算与闸

| 闸 | 上游 | 我们 |
|---|---|---|
| token 预算 | 有（`token_budget` 列，超限→budget_limited） | **有**（对齐）：从引擎消息 tokens 记账（`history.ts` 的 `meta.tokens` 已可用） |
| 迭代上限 | **无**（iteration 只是推导序号） | **新增**：默认 12 轮（delta） |
| 无进展检测 | **无**（无 stall guard） | **新增**：连续 2 轮 verifier 相同 nextAction / 无推进 → pause + 通知（delta） |
| 时间预算 | 无（timeUsedSeconds 仅展示） | 暂不加，展示照旧 |

### 2.6 命令面与 UI

- **/z/**：bridge 喂 `goalStateSchema`（objective / summaryTitle / status / iteration /
  verifications[] / iterations[]）→ vendor 状态面板 goal 区 + 时间线 `goalSet`/`goalVerify`
  marker 自然亮起（schema 早已就绪，见 `snapshot.ts:420-443`）。
- **TG**：`/goal <objective>` · `/goal pause` · `/goal resume` · `/goal clear` · `/goal status`
  （对齐上游 CLI 子命令集 `cli/src/command-center/handlers/goal.ts:34-70`）。
- **控制项**：vendor 的 `pauseGoal`/`resumeGoal` 命令已在 availability 里开放（bridge 里 allowed=true），
  接真即可（对齐上游命令名 `command.ts:219-220`）。

## 3. 闲时补齐（第二优先）

N5 已有：一次性工单 / 低峰窗口 FIFO / 审批模式映射 / 模型选择（`src/core/offpeak.ts`）。
补齐项（对齐 vendor `off-peak-types.ts` 的字段面）：

- 取号语义：`queuePosition` 展示（vendor 有字段，我们没喂）
- `boundSessionId` 续跑（会话内创建的工单绑定会话）
- 跨 ticket resume（失败/取消后可重排）
- **与 goal 组合**：闲时任务可携带 goal，跑完自动验收（这是两个能力的乘数）

## 4. workflow：全量落地（2026-10-10 改判，取代本节旧的「最小形态」）

goal + 闲时两项 spike 已通过（见 [n12-spike-record.md](n12-spike-record.md)），本节从
「最小形态、不预先承诺」改判为**全量落地计划 P0–P5**（用户裁决：要 agent 效果最好、
最可靠、最可控、最完整的方案，时间不限）：

- **引擎**：直接 vendor 上游 ZCode 的 `dynamic-workflow` + `dynamic-workflow-runtime`
  （Apache-2.0；两包 src 对 `@zcode` 零 import，依赖仅 `typescript` + node 内建）——
  自研编排执行引擎仍然**不做**（旧裁决维持）。
- **工具面**：官方 `tool` 钩子把 `CreateWorkflow` 等挂进引擎，模型原生作者。
- **状态/调度/journal/审批/并发/预算**：全在 host。
- **前置（P0）**：插件与 host 共存的 ATTACHED 模式——今天装插件会和 host 双冲突，
  因为 host 从不取锁、插件非 primary 时连工具都不注册。
  P0 第一步的实测结论见 [workflow-p0-tool-registration.md](workflow-p0-tool-registration.md)。

**明确不做（维持）**：host 原生 workflow runner（自研编排执行引擎）。

## 5. PRODUCT.md 条文修订（精确措辞）

旧条文（`:56`、`:104`）：「不做 workflow（host 原生 runner 也不做）、目标/goal」。
**拆成两句**（避免将来拿旧条文打架）：

- **不做**：host 原生 workflow runner（自研编排执行引擎）——**维持**。
- **做**：以引擎插件钩子补齐 ZCode 体验面（goal / 闲时收尾 / workflow 最小形态）；
  **机制在引擎内（仅官方钩子）、状态与调度在 host**；不改引擎、不追 opencode latest。

## 6. spike 验收表（时间盒 1 周，隔离栈）

| # | 场景 | 通过标准 |
|---|---|---|
| A | 跨多轮目标（例：把某测试跑绿） | ≥3 轮续跑、每轮有具体推进、终局 `verified` |
| B | 暂停恢复 | pause（/z/ 与 TG 各一次）→ 状态与时长正确 → resume 续跑 |
| C | 验收失败→修正→通过 | ≥1 次 `notSatisfied` 后修正，最终 `verified` |
| D | host 重启 | 进行中目标重启后 = `paused`；resume 可续；状态不丢 |
| E | 三条硬闸 | 迭代上限 / 预算 / 无进展 各触发一次，均正确停机并通知 |
| F | 互斥 | plan 模式拒绝 goal；goal 激活时 plan 拒绝 |
| G | UI 面 | /z/ goal 区与时间线 marker 全程可见；**卡片流无幽灵用户气泡**（continuation 行 origin 正确） |

## 7. 风险与开放项

- 引擎无「model-only 输入」概念 → 用 `origin:'goalContinuation'` 映射折衷（§2.2）；
  不可接受时回退方案 = 去掉标记改走 host 侧可见消息（体验降级但语义不变）。
- 引擎的 autocontinue（压缩后 synthetic continue，**默认开**）：发生在 turn 内部，与 idle 后的
  goal 循环**串行共存，无需抑制**；但必须防重入（同一 idle 只触发一次续跑，用 run 记账）。
- 上游 verifier fail-open 我们**不照抄**（§2.3 delta）——代价是坏 JSON 时更常停，用通知兜底。
- 开放项：~~workflow 是否保留在欠账清单~~ → **已裁决：保留，按 §4 的全量计划 P0–P5 推进**；
  PRODUCT 措辞定稿见 P5 交付物（机制在引擎内（仅官方钩子）、状态与调度在 host）。

## 附录：opencode 钩子清单（1.18.34 类型面，1.18.32 二进制核实）

| 钩子 | 能力 | 我们用它做什么 |
|---|---|---|
| `event` | 只读事件（已在用） | idle 检测、turn 定稿 |
| `tool` | 注册新工具（已在用 4 个） | 工具面扩展 |
| `chat.message` | 改用户消息与 parts | 上下文注入（若需要） |
| `experimental.chat.messages.transform` | 重写完整消息历史 | model-only 注入的备选路径 |
| `experimental.chat.system.transform` | 重写 system prompt | goal 状态注入 |
| `tool.execute.before/after` | 改工具入参/结果 | 门禁、审计 |
| `permission.ask` | allow/deny/ask | 审批自动化 |
| `config` | 改引擎配置（OmO 用它注 agent/命令） | 附加能力定义 |
| `command.execute.before` | 命令执行前注入 | 命令面扩展 |
| **缺** | 命令注册（V1 无；V2 仅改删） | 命令只能走 TG/`config` 侧门 |
