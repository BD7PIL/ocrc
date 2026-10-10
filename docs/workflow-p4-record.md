# P4-1 门禁记录 — workflow 在 `/z/` 里看得见

门禁脚本：`scripts/spikes/p4-projection/gate.mjs`（栈在 `stack.mjs`，stub 模型在 `stub-llm.mjs`）。
最后一次运行：**22/22 通过**（2026-10-10）。

## 栈的形状

```
ocrc host :4199  ←  引擎 :4295（装了 ocrc 插件，ATTACHED）  ←  stub 模型 :4300
        ↑
   /z/ 面板（web-next 构建，host 自己 serve）+ CDP Chrome :9222
```

一次运行里的关键约束，都是实测出来的（不是猜的）：

- **host 先起、引擎后起**：引擎里的插件若先拿到 primary lock 就会自己变成 host（P0-3 的
  ATTACHED 判据）。所以顺序是 host → 引擎，引擎 attach。
- **会话必须由 host 的 API 建**：面板经 host 的 backend 读会话，而直接在引擎上建的会话落在
  引擎 cwd 那个 project 里 —— 侧栏不会显示它。用 `POST /api/session {directory: REPO}`
  建，与 run 的 cwd 同 project。
- **壳需要一个 workspace 才渲染**：`ZCodeApp` 取「最近一个带 directory 的会话」当初始
  workspace，一个都没有时 `Root` 整棵不渲染（空白页，无报错）。所以门禁先建一个 bootstrap
  会话提供目录。
- **模型要 pin**：`POST /api/overrides` 把 stub 模型设为下一轮，否则引擎挑用户默认模型
  （scratch HOME 里没有 key）。
- **Telegram 凭据在每个子进程里显式清空**：仓库 `.env` 里是生产 bot token，`loadPluginConfig`
  会 dotenv 载入它（P0 事故的教训，已固化成 `childEnv()`）。

## 22 项断言

| # | 断言 | 依据 |
|---|---|---|
| a0–a | host 建会话 → 工具面调用起了一个**在跑**的 run | `GET /api/workflow/projection?sessionId=` |
| b | host 记下了 run→工具卡的 join | `joins[runId] = {messageId, toolName}` |
| c | 投影带声明阶段表与活节点 | `phaseNames:["collect"]`、`nodes[].phase` |
| d | `/z/` 渲染出 ZCode 壳 | 侧栏 workspace item |
| e | host 建出父会话 | `/api/session` |
| f–h | 同 a–c（浏览器已就绪后复读一次） | 同上 |
| i | 该会话在侧栏有行 | `task-item-<sessionId>` |
| j | **侧栏轨道**出现 | `[data-workflow-run-rail]` |
| k | **时间线上的 run 卡**与工具卡 join 上 | `[data-testid^="workflow-run-digest-"][data-workflow-run-id=<runId>]`，testid 里就是解出来的 `tool-partId` |
| l | **状态面板的 Workflows 分区**数到这条 run | composer 徽标 `data-background-workflow-count=1` + 面板模型 `data-running-workflow-count=1` + 分区标题在场 |
| m | **刷新不丢 run**（冷快照带 `workflowRuns`） | reload 后卡仍在 |
| n | 点卡开 **run 侧页**，状态 running | `[data-workflow-run-id][data-workflow-run-status="running"]` |
| o–p | 侧页给出 **停止** 与 **配置** | `workflow-run-cancel` / `workflow-run-configure` |
| q | **停止**真的经 v4 命令生效 | 状态转 `stopped` |
| r | 停下后给出 **恢复** | `workflow-run-resume`（只读投影的 `resumable` 位） |
| s | **恢复**真的重启了 run | 状态回 `running` |
| t | 整个过程没有页面错误 | `pageerror` 收集为空 |

截图：`/tmp/ocrc-p4/shots/{1-timeline-card,2-run-pane-running,3-run-pane-stopped,4-run-pane-resumed}.png`
（每次运行重建；`GATE_KEEP=1` 可保留栈以便手工查看）。

## 门禁抓出来的三个真 bug（都已修）

1. **`run-launched` 事件从来没有被写过**。上游引擎只在「run 行还不存在」时把宿主 launch
   元数据转录成这条事件（`engine.js`: `existing === undefined && config.launch`），而 ocrc
   刻意先建行再启动（submit 必须立刻可读 runId，且中途崩溃也要留下可被冷恢复标记的行）。
   结果：声明阶段表（侧栏迷你轨道）与 per-run 子模型从来没进过 journal。现在由宿主在
   `run-started` 之后补写这条事件 —— 元数据本来就是宿主写的，写在建行的地方是同一件事。
2. **卡片 join 键永远解不出来**。桥在首次快照时用 `lastRowsBySession` 解析 `toolCallId`，
   而那份行缓存是**快照构建之后**才写入的 —— 首次读必然是空表，于是 `toolCallId` 恒缺席、
   时间线上一张卡都没有。现在把行显式传给解析函数。
3. **`resumable` 与 resume 门不一致**。superseded 的 run 被投影成不可恢复是对的，但
   `manager.resume()` 只看 `status === 'stopped'`，会放行它 —— 按钮亮着而命令该拒。现在
   两处共用同一个谓词。

## 如实说明的两处「没做到」

- **状态面板分区只断言到模型层**：面板默认是 mini（收起）变体，分区标题在 DOM 里但不可见
  （`data-state="closed"`，Playwright 连 force click 都点不动）。断言改为「徽标数到 1 + 面板
  模型数到 1 + 分区标题在场」，并**不声称**展开后的行渲染过。行若渲染，testid 是
  `v4-background-work-item-<workId>`。
- **run 侧页的静态因果图缺席**：侧页顶部写着「当前会话的可见历史里没有这张工作流程图」。
  图来自工具行的 `display`（`toolCallCreateWorkflowDisplaySchema`），上游 CLI 从分析器产出，
  我们的桥没有产出它。这是 P4-2 的活（侧页与查询），此处如实记录，不算 P4-1 的完成项。
