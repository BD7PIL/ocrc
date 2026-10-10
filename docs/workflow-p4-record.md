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

---

# P4-2 门禁记录 — 七个读面与侧页

门禁脚本：`scripts/spikes/p4-queries/gate.mjs`（栈复用 `../p4-projection/stack.mjs`）。
最后一次运行：**31/31 通过**。P4-1 的门禁在同一次改动后复跑仍是 **22/22**。

## 这一轮跑的是什么 run

脚本**没有模型**在环里：两次 `files.*` 读（glob + read）、一次 `artifact.markdown`，一秒钟
结算。这样七条查询的输入是确定的（world 节点带 op 与正文、产物带版本与字节、事件日志可翻页），
不花一个 token。run 仍从**模型工具面**发起（stub 的计划），因为 HTTP 直接提交的 run 没有工具行，
浏览器那半段就无卡可看。

## 31 项断言（摘要）

| # | 断言 | 依据 |
|---|---|---|
| a–c | 会话 + 工具面起的 run + 结算 completed | 投影 |
| d | ② `workflowRuns` 枚举出该 run，label 由 `name` 派生 | `/api/workflow/runs/summaries` |
| e | ① `workflowRunEvents` 按 sequence 翻页并如实报 `hasMore` | limit=3 → 第二页 9 条 |
| f | 事件日志带 Boundary C 词汇 | `run-started`/`node-queued`/`artifact-published` |
| g–i | ⑥ `workflowRunWorkspace`：op/args/status/summary + 由事件推出的时间戳 | `glob`/`read`，`resultCount:12` |
| j–k | ⑦ `workflowRunNodeResult`：正文 + 真实字节数；`maxBytes` 保形截断并置 `truncated` | 414B → 截断后仍 414B totalBytes |
| l–m | ③ `workflowRunArtifacts`：版本、kind、title、字节数 | `report` / markdown / v1 / 60B |
| n–o | ⑤ `workflowRunArtifactRead`：分块取字节，末块 `nextOffset: null` | 首块 32B，尾块 28B |
| p | ④ `workflowRunArtifactData`：markdown 产物不是看板，条目为空 | `{items:[],hasMore:false}` |
| q–r | 工具卡 display：因果图 + 阶段词汇 + 车道 | `steps=2 participants=1 phases=[scan,publish]` |
| s | 跨会话查询与「无此 run」同一个 404 | 授权契约 |
| t–u | 结算后的 run 仍有卡；侧页打开为 completed | 浏览器 |
| v | **侧页画出脚本图**（不再写「没有这张工作流程图」） | `workflow-run-graph-unavailable ×0` |
| w–x | Artifacts 分区列出产物；点击打开产物侧页 | `workflow-run-artifact-card` → `workflow-artifact-pane` |
| y | 产物侧页渲染**真实字节** | 代码块里是 markdown 原文 |
| z | 全程无页面错误 | `pageerror` 为空 |

截图：`/tmp/ocrc-p4/shots/{5-run-pane-graph-artifacts,6-artifact-pane}.png`。

## 这一轮修掉的与如实说明的

- **run 侧页的图**：P4-1 时它写着「当前会话的可见历史里没有这张工作流程图」。图来自工具行的
  `display`（上游 CLI 从分析器产出），现在宿主用同一份 vendored 分析器产出，桥按 toolCallId
  挂到发起行上。这不是「顺手补的」：`display` 解析失败是**静默**的（schema `.catch(undefined)`），
  所以缺了它只表现为「图不见了」。
- **`/api/workflow/runs/summaries` 被 `:id` 路由吃掉**：Hono 按注册序匹配，字面量路径必须排在
  参数化路径之前，否则 `summaries` 会当成一个 runId 并回 404。已移到前面并注明。
- **产物 id 不合法 = 404，不是 500**：artifact store 对不安全 id 抛错；读面把抛出与「没有这件
  产物」归成同一个答案，既不是 500，也不做存在性预言。
- **状态面板分区仍只断言到模型层**（P4-1 的说明不变）：mini 变体下面板正文不排版。

---

# P4-3 门禁记录 — saved workflows 面板

门禁脚本：`scripts/spikes/p4-saved/gate.mjs`。最后一次运行：**20/20 通过**。

## 20 项断言（摘要）

| # | 断言 | 依据 |
|---|---|---|
| a | 宿主保存了一个带 meta 与声明实参的 workflow，scope=project | `/api/workflow/saved` |
| b–c | 列表是 vendor 形状（`workflows` + `invalid` + `dir`），条目带 meta/scope/args | 同上 |
| d | 首次运行前运行历史为空 | `/saved/by-name/<n>/runs` |
| e–f | 壳渲染；自动化页给出「工作流」页签（P4-0 灰度为真） | `automations-page-tab-workflow` |
| g–h | 页签列出该 workflow，卡片显示名字与说明 | `workflow-card-gate-audit` |
| i–j | 「运行」打开启动弹层，弹层索要声明的实参 | `workflow-launch-dialog` / `workflow-launch-arg*` |
| k | 提交后真的起了一个 run（`startSavedWorkflow`） | 按 name 查到该 run |
| l–m | 运行历史按 run 自己的名字列出，带状态与产物 chips | 状态 completed + `report` chip |
| n | 面板自己的运行历史页（定义/运行历史 页签）出现该行 | `workflow-run-row-<runId>` |
| o | `moveSavedWorkflow` 如实拒绝并给出原因 | 501 + `reason: unsupported` |
| p | 全程无页面错误 | `pageerror` 为空 |

截图：`/tmp/ocrc-p4/shots/{7-saved-workflows,8-launch-dialog,9-saved-run-history}.png`。

## 这一轮的关键决定与一处真 bug

- **store 仍是一个机器级 JSON，但形状按 vendor 回**：`dir`/`path` 报的是那个文件（记录确实住
  在那儿，面板照实显示成 `/…/.ocrc/workflows/saved.json`），`invalid` 恒空（JSON 不会解析失败），
  `scope` 是记录上的字段而不是「文件在哪个目录」推得的。这三条都写在路由注释里，不假装是上游
  那种「项目档 / 全局档两套目录」的布局。
- **新保存默认 `project` 作用域**：面板的默认档就是 project，默认成 global 会让用户存完看不见。
- **`moveSavedWorkflow` 如实拒绝**（501 + 原因）：上游是「把文件从全局目录搬到项目目录」，
  ocrc 只有一个 store，没有可搬的文件。假装成功会让面板显示成项目档而 store 里还是全局。
- **真 bug：列表视图的「无名字」运行历史调用**。vendor 的 store 在列表视图里用**不带 name**
  的 `listSavedWorkflowRuns` 拉该作用域的全部历史；我最初把它拼成 `/by-name/undefined/runs`
  → 404 → 回的是失败信封而不是 `{runs: []}` → 面板拿 `undefined` 去遍历，**整段设置页被错误
  边界接走**（「e is not iterable」）。现在有一条无名路由（回该作用域的全部 run），桥侧也把
  返回值强制成数组——消费侧直接 `result.runs` 并遍历，回信封就是崩。
- **卡片/页签的 testid 带后缀**（`workflow-card-<name>`、`workflow-run-row-<runId>`），
  「运行历史」在详情页的**分段页签**后面（定义 | 运行历史）。门禁按真实 DOM 走。
