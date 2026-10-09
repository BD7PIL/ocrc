# N12 spike 实测记录（隔离栈）

> 时间盒：2026-10-10 一轮内完成（表见 [next-phase.md](next-phase.md) §6）。
> 环境：隔离栈（web 4199 + 自拉引擎 4298，`HOME=/tmp/ocrc-z-home`）；**生产引擎
> （用户 :4096）与生产 ocrc 全程零接触**——spike 期间它们都没被打到（用户的引擎进程
> 始终只有它自己那一个，测试实例是我自己 host 拉起的子进程）。
> 构建：`1.0.0-rc.4`，实测提交区间 `ecb8a6a`（起点）→ `bdbdf45`（含 spike 修出的三处缺陷）。

## 结论表

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| A | 跨多轮目标（≥3 轮续跑、每轮具体推进、终局 verified） | ✅ | 14 步目标：13 轮续跑（v1..v13），每轮 nextAction 前进一个 step，终局 `complete`；文件 `step1.txt`…`step14.txt` 全部落盘 |
| B | 暂停恢复（/z/ 与 TG 各一次） | ⚠️ /z/ ✅ · TG 未做 | /z/ 用真 UI 点按钮：pause → UI 翻成 resume 且 host 状态 `paused`；resume → `active` 且**续跑完成**（该目标随即 `complete`）。TG 半场无法由我执行（见下「未完成项」） |
| C | 验收失败→修正→通过 | ✅ | 同一轮 A 的弧线：v1..v12 全 `notSatisfied`（每条 nextAction 指向下一个 step），v13 `pass` |
| D | host 重启 | ✅ | 杀掉我自己拉起的隔离 host（目标处于 `active`）→ 重启 → 日志 `cold recovery: 1 active goal(s) paused`，读取为 `paused` 且迭代数/验收历史/用量/目标文本全在；resume 后继续推进（12 → 14 步） |
| E | 三条硬闸各触发一次正确停机+通知 | ✅ | 预算：`tokenBudget=1` → `budget_limited`，通知「预算已用尽（7302/1 tokens）」；迭代上限：A 跑到 `iter=12` 停 → 通知「已达迭代上限 12 轮（继续 = 再给 12 轮）」；无进展：连续两轮同 nextAction → 通知「连续 2 轮无进展（同样的下一步反复出现）」 |
| F | 互斥（plan 模式拒绝 goal；goal 激活时 plan 拒绝） | ✅ | plan 下 `POST /api/goal set` → `{"error":"plan_mode"}`；goal 激活中切 plan 再推一轮 → 回合末拒绝续跑，停机原因「计划模式下不能续跑目标（切回 build 后 resume）」 |
| G | UI 面：goal 区与时间线 marker 全程可见；无幽灵用户气泡 | ✅ | 见下 G 段 |

## 修出的三处真缺陷（spike 的价值所在）

1. **证据窗口从头部截断**（最关键）。`EVIDENCE_MAX_CHARS=8000` 用 `slice(0, N)`，
   多轮之后**最新一轮整段被切掉**（实测第 4 轮时证据已 10.2k 字符）。验收器于是两轮
   看到同一份旧状态、给出同一个 nextAction，无进展闸（据此判定，本身没错）在第 4 轮
   停掉了一个健康的目标。修法：证据**保尾**，待办占头部预算。回归测试 + 实测
   （12 轮不再误停）双证。
   ※ 同批次我先提交的「引擎历史滞后一整轮」诊断是**不完整**的——bus-first 改动本身
   仍然成立（更鲜、无 HTTP），但它不是那个 bug。
2. **resume 不续跑**。上游 `resumeGoal` 会 `continueGoalAfterChange`；我们只翻状态，
   恢复后的目标 active 地空等用户下一条消息；而且撞过迭代上限的目标 resume 后下一轮
   立刻又停（上限累计）。修法：resume 派发续跑轮，且撞上限时把上限按整档延展
   （`iterationCap += 12`）。实测：resume 把目标从 12 步推到 14 步直到 verified。
3. **续跑可能落进 plan 模式**。上游在 plan 下直接不产出 continuation candidate；
   我们的 set/resume 都查了 plan，唯独循环自身没查——用户中途切 plan，下一轮 prompt
   就会打给 plan agent。修法：循环内拒绝续跑并停机通知。

## G — UI 面细节（/z/ 实测）

- **时间线 marker 可见**：每条续跑轮后渲染「第 N 次迭代 · 目标未完成，任务继续」，终局
  「第 13 次迭代 · 目标已完成，任务结束」（= `timelineMarker` + `lane:'turnTailBoundary'`）。
- **续跑轮不是幽灵气泡**：气泡只显示短展示行（如「在 /tmp/…/ 创建 step5.txt，内容为
  step5，创建完立刻结束本回合」），整段提示词折进「工作流引擎附加说明」披露；截图
  可见，正文里没有任何 `<untrusted_objective>` 原文。
- **goal 区在状态面板内**：DOM 实测 13 条 `[data-goal-iteration]` 行，带
  `data-goal-verification-outcome`（v1 `notSatisfied` … v13 `pass`）与
  `data-goal-iteration-completed`；`[data-goal-elapsed-seconds]` 随暂停/恢复变化
  （15 → 25）。
- **按钮门控按上游规则**：`[data-goal-action=pause]` 仅 active/verifying/notSatisfied 时
  可用、`resume` 仅 paused 时可用——真 UI 点了 pause 后按钮当场变 resume。
- 备注：`v4-goal-banner` 这个 test-id 在上游**只定义未使用**（本快照里没有横幅组件）；
  goal 面实际落在状态面板的 goal 分区 + 时间线 marker，与上游一致。
- 备注：goal 分区所在面板是否展开，走 vendor 原生展开策略（composer empty + running）
  ——与 N8 记在 CHECKLIST 的 🔶 同源，不是 goal 专有缺口。

## 未完成项（需要用户本人）

- **spike B 的 TG 半场**：从 TG 侧 `/goal pause|resume` 需要**以用户身份给 bot 发消息**，
  我这边没有 Telegram 客户端、也无法伪造用户更新（Bot API 只能以 bot 身份发消息）。
  请在方便时跑一次：
  1. 起带 TG 的隔离栈（**先确认生产 ocrc 没在跑**，同一 token 会让后起者拿不到运行锁）：
     `HOME=/tmp/ocrc-z-home OCRC_HOME=/tmp/ocrc-z-home/.ocrc OCRC_BACKENDS=opencode
      OCRC_SERVER_PORT=4298 OCRC_WEB_PORT=4199 OCRC_OFFPEAK_WINDOW=00:00-23:59
      node dist/cli/index.js host`（**不要**把 `TELEGRAM_BOT_TOKEN=` 置空——那是本次
      web-only 的跑法）。
  2. TG 里 `/goal 分多回合依次在 /tmp/ocrc-z-home/spike-tg/ 创建 step1.txt、step2.txt`。
  3. 等一两轮后点状态卡上的「⏸ 暂停」，看状态变「已暂停」、时长停走；再点「▶ 继续」，
     确认又出一轮续跑。
  4. `/goal status` 复核；`/goal clear` 收尾。
- 顺带：`/help` 与 BotFather 菜单里的 `/goal` 条目在带 TG 启动时会在日志打
  `setMyCommands OK [...]`——本次因 TG 关闭未打，单元测试已覆盖菜单数组。

## 复现命令（本记录用的）

```bash
# 起隔离栈（web-only 变体；生产引擎 :4096 不参与）
HOME=/tmp/ocrc-z-home OCRC_HOME=/tmp/ocrc-z-home/.ocrc OCRC_BACKENDS=opencode \
  OCRC_SERVER_PORT=4298 OCRC_WEB_PORT=4199 OCRC_OFFPEAK_WINDOW=00:00-23:59 \
  TELEGRAM_BOT_TOKEN= ALLOWED_USER_IDS= OCRC_WEB_ENABLED=true \
  node dist/cli/index.js host

# 目标驱动脚本（见 /tmp/ocrc-z-home/：spike-goal.mjs / spike-ws.mjs / cdp.mjs）
SPIKE_TOKEN=$(cat /tmp/ocrc-z-home/.ocrc/token) node /tmp/ocrc-z-home/spike-goal.mjs new-session
```

UI 侧走 CDP（本机 EL7/glibc-2.17，Playwright 的 chromium 起不来；沿用会话里已存在的
`headless_shell` :9222）。
