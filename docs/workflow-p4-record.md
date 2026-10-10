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

---

# P4b 门禁记录 — amend 的导入缓存

门禁脚本：`scripts/spikes/p4b-amend/gate.mjs`。最后一次运行：**14/14 通过**。

同一次改动后复跑前三道门禁：P4-1 **22/22**、P4-2 **31/31**、P4-3 **20/20**。

## 门禁的形状

三个 **typed** actor（`ask<V>`）按序跑完 → amend 成「多一个 actor、前三条指令逐字不变」的新
脚本 → 只给新 actor 提交结果。前三条若被缓存命中，引擎会直接 `node-settled { cached: true }`
而**不派发**——这正是断言读的那个信号（与面板上显示的同一份投影）。

typed 是必需的：缓存按 `(actor 名, actorSeq, inputHash)` 命中，而只有 typed ask 才有引擎
可校验的 schema 与逐条落库的结果。

## 18 项断言（摘要）

| # | 断言 | 依据 |
|---|---|---|
| a | 前驱跑完，三个提交值都在结果里 | `record.result` |
| b | 每条完结的 ask 的 `messageBoundary` **等于它会话的真实长度** | `[{"ask#1":3/3},{"ask#2":4/4},{"ask#3":2/2}]`（第三轮起：不再是「有数就行」） |
| c | 前驱三条都是 live 跑的（基线：无命中） | 投影 `cached` 全空 |
| d | amend 被接受并铸出后继 | 新 runId |
| e | 修订跑完，五个值都在 | `{a:1,b:2,c:3,d:4,a2:5}` |
| f | 修订带 lineage 指针 | `resumedFrom` = 前驱 |
| g | **前驱三条在修订里是缓存命中** | 投影 `cached: true` ×3 |
| h | 两条新 ask 都是 live 跑的（缓存不是一刀切跳过） | `cached` 空、`phase: settled`、`outcome: ok` |
| i | 前驱被 supersede 且不可恢复 | 投影 `resumable` 缺席 |
| j | **修订只派发了新的那两条** | 事件日志里 `node-dispatched` 只有 `ask#4`/`ask#5` |
| k | 前驱 journal 里的边界行同时带 count 与 message id | `ask-boundary` 行 vs 转录长度 |
| l | 分歧 actor 拿到的是**新**会话（种子是复制，不是重挂） | 前驱/修订的 alpha session id 不同 |
| m | **种出来的会话带着前驱的完整前缀** | 按**内容**逐条比对 `prefix=3 boundary=3` |
| n | 复制的那段是源会话的开头、按序 | 前缀逐条相等（不是集合相等） |

**为什么按内容比、不按 message id 比**：vendored 的 count offset 之所以成立，正是因为「把前 N 条
消息复制进新会话，消息 id 全变而 count 不变」。比 id 就是比一个复制**本来就允许改**的东西。

**引擎的 fork 切在哪（实测写死）**：`POST /session/:id/fork {messageID}` **不含**被指的那条
（6 条消息的会话在 `message[3]` 上 fork 回来是 3 条；不带 id 则拷整个尾巴）。所以 driver 不能把
fork 指向边界消息（那会正好丢掉这条 ask 产出的那条消息），而是**读一次源转录、把 fork 指向边界之后
的那条消息**；源会话正好停在边界时（后面没有消息）就用不带 id 的尾拷——两者都得到契约要的
「前 N 条」。这一步由 `seedActorSession` 完成，结论钉在它的注释里。

## 硬前置与如实降级

- **硬前置（已做）**：driver 从不写 `NodeRecord.messageBoundary`，而 vendored 的缓存构建
  **整体拒绝**没有边界的条目（`missing_boundaries`）。现在 driver 在 ask 交换结束时补写：
  typed ask 在 `respondToSubmit` 的 accept 分支写**临时值**，`notifyTurnEnd` 写**权威值**
  （vendored 契约把边界定义在「完整交换」结束之后）。两处都写在引擎结算之后，免得被引擎自己的
  行写入盖掉。边界数的单位是**我们自己的转录单位**（`backend.getHistory` 返回的
  `StructuredCard` 条数，也就是种子复制真正要搬的东西）——数一个我们没有的东西（引擎的消息行）
  才是编数字。宿主自己的一行记账（`ask-boundary`，与 `run-join` 同族）连同**边界消息 id** 一起
  落库，好让只能按消息边界复制的后端有确切位置可切。
- **④ 结算之后的 turn end（已修）**：引擎在 `run-settled` 后立刻 `driver.dispose()`，而权威边界
  所属的那个 turn end 常常在那之后才到（typed ask 在值被接受时就结算）。边界义务因此存在一张
  **不随 dispose 清空**的队列里，由 manager 的 `settledDrivers` 接住结算后的 turn end；队列是
  每会话 FIFO（到达的 turn end 属于最老的那条在飞交换）。
- **已实现 ①（转录种子）**：vendored 的缓存还能给「分歧 actor」的新会话播种前驱转录前缀。现在
  由 `forkSession` 实现，**按后端能力降级**：没有 `forkSession`（v2 / ACP）就铸空会话并记一行
  `no transcript seeding (backend lacks forkSession)`——**绝不因此拒绝 amend**。缺能力要如实降级，
  不能把用户挡在外面。
- **如实降级 ②（无 in-flight 条目）**：上游能把「停下时还在飞」的那半场对话交出去续跑（
  `ImportedInFlightAsk`），我们仍然省略——在飞的那条重跑一次。注意这与 ① 不是同一件事：**已完结**
  的前缀现在会复制（①），只有「半场」不复制。
- **如实降级 ③（只回看一代）**：resume 时从**直接前驱**重建缓存（上游会走整条
  `resumed_from` 链）。两代修订之后，祖辈的条目不在缓存里，种子也因此找不到对应边界（会记一行
  warn 并退回空会话）。
- **缓存缺席不阻塞 amend**：preflight 失败只记一行 warn 并照常修订（代价是 token，不是功能）。
  这样 P4b 之前的历史 run 也还能被修订。

---

# P4-2 侧页补记（第二轮，2026-10-10）

第一轮的 31 项断言覆盖了七条查询，但计划里点名的五张侧页只实测了两张（run 详情、artifact）。
补上 workspace 侧页后，**34/34 通过**（新增 `aa`/`ab`/`ac`）；actor 侧页在 P4-1 门禁的活 run 上补验
（那道门禁因此变成 **23/23**）。五张侧页现在实测打开四张，只剩 directory（原因见下）。

| 侧页 | 结论 | 证据 |
|---|---|---|
| run 详情 | ✅ 实测打开且有数据 | p4-queries `u`/`v`（脚本图渲染，不再写「没有这张工作流程图」） |
| artifact | ✅ 实测打开且**真读到字节** | p4-queries `x`/`y`（代码块里是 markdown 原文） |
| workspace | ✅ 实测打开且有数据 | p4-queries `aa`：`workflow-timeline-workspace-open` → 面板列出 `搜索 src/core/workflow/*.ts`（13 个文件 · 18ms）与 `读取 projection.ts`（22.4 KB）——即 workspace 查询的页面级证据（截图 `10-workspace-pane.png`） |
| actor 会话 | ✅ 实测打开（在 **P4-1 门禁**里，活着的 run 上） | p4-projection `u`：run 面板花名册药丸 → actor 的转录页挂载（`rosterPill=true pane=true`，截图 `5-actor-pane.png`） |
| directory | ✅ 实测打开且有数据（第三轮补验，见下） | p4-queries `ad`–`af`：面板展开 → Workflows 分区 → 目录入口 → 侧页列出 `p4-queries`（`endedCount=1`，截图 `12-directory-pane.png`） |

## 如实说明：两张侧页没实测打开

- **actor 会话侧页**（已补验，见上表）：第一次在 p4-queries 里点它没开，原因是**状态**而不是
  接线——它的入口是 run 面板里**在飞 ask 的花名册**药丸，而 p4-queries 的 run 已经结算、没有花名册
  （digest 时间线上那枚同形药丸打开的是 workspace 转录，不是 actor 会话）。改到 p4-projection 的
  **活着的 run** 上点，就开了。
- **directory 侧页**（第三轮已补验，见下）：第一轮把它记成「mini 变体下面板正文不排版」——**这个
  理由是错的**，见下一节。

这两条都不影响「七条查询已通」这个结论：查询是 HTTP 层实测的（`d`–`r`），侧页只是它们的渲染端。

---

# P4-2 第三轮 — directory 侧页 + 两个真缺陷（2026-10-10）

第一轮把 directory 侧页记成「打不开」，理由写成「状态面板正文在 mini 变体下不排版」。**那个理由
是我自己门禁的错误**，不是产品限制：

- 面板正文的可见性是 **CSS 容器查询**（`ConversationStatusPanel.tsx`：`variant === "auto" ?
  "hidden @min-[1280px]/conversation:flex" : "flex"`）。显式 `panel` 变体下正文**恒可见**，
  与列宽无关。
- 我的展开分支写的是 `if (data-state === 'collapsed')`，而 `data-state="collapsed"` 只在字面
  `mini` 变体出现；`auto` 下它一直是 `"expanded"`——于是展开分支**从未执行**，门禁去点了一个
  从未被排版过的按钮（Playwright 的 `force click` 也点不动一个 `display:none` 子树）。
- 用户的一句「为什么不做」让我回头读了 vendor 的样式，才看到这一点：**能点开的路径一直存在，
  是门禁不会点。**

## 门禁补了什么（37/37）

| # | 断言 | 依据 |
|---|---|---|
| ac | 目录查询给每行带上 `toolCallId` 锚点 | summaries 面首行的 `toolCallId` |
| ad | 状态面板能从 `auto` 展开成 `panel`（点 mini 行唯一的控件） | `data-display-mode`：`auto → panel` |
| ae | Workflows 分区开出目录入口 | `[data-testid="workflow-run-directory-trigger"]` |
| af | **目录侧页打开并列出这个 run** | `section[data-workflow-directory-section="ended"]` 里的 `[data-run-id]` 行，`endedCount=1` |

## 这一轮抓出来的两个真缺陷（都已修）

1. **summaries 面缺 `toolCallId` 锚点。** vendored 的目录模型（`buildWorkflowRunDirectory` →
   `hasDetailAnchor`）会把没有 `toolCallId` 的摘要**整行丢掉**，而目录页读的只有这一面；更糟的是
   状态面板的 Workflows 分区挂在同一个计数上（`endedWorkflowRunCount` 来自同一条查询），行全被丢
   就等于**入口和面板本身都不渲染**。ocrc 没法把 id 放进 run 记录（引擎在工具调用返回**之后**才铸
   `tool-<partId>`，插件只知道 message），所以由宿主按 `(messageId, toolName)` 这对在**父会话自己的
   工具卡片**里解析——和投影面交给面板的那对是同一对，只是这一面没有行可拿。解析不到就不给锚点
   （HTTP 提交的 run 没有 join，窗口外的卡片也匹配不上），绝不猜。
2. **`messageBoundary` 是个假数字。** 原先读 `getHistory(sessionId)`，而它的默认页是 50——**超过
   50 条之后这个边界恒为 50**。它带着契约含义（种子复制按这个数截断前缀），所以改成读一个足够大的
   窗口（1000），读满窗口时记 warn 而不是把「下限」当计数发出去。
   顺带修掉了它的**时机**：vendored 契约把边界定义在「完整交换（含 repair/nudge 与 submit 之后的
   收尾消息）结束之后」，而 typed ask 在**值被接受**那刻就结算——收尾消息还没落地。于是：
   - accept 时写一版**临时值**（好让刚跑完的 run 能被 amend——preflight 拒绝没有边界的条目）；
   - **turn end 时写权威值**，且这个 turn end 经常在 run 结算**之后**才到——引擎在 `run-settled`
     后立刻 `driver.dispose()`，原先会把在飞表清空、让这个值永远落不了地。现在边界义务存在一张
     **不随 dispose 清空**的队列里，由 manager 的 `settledDrivers` 接收结算后的 turn end；
   - 队列是**每个会话的 FIFO**：typed ask 在值被接受时就结算，所以下一条 ask 会在上一条的 turn
     end 之前被派发，而到达的 turn end 属于**最老的那条**（单槽位会把老的那条覆盖掉，让它永远停在
     临时值上）。
   - **残留的不精确（如实记下，不藏）**：FIFO 归属在**模型驱动**的流程里是精确的（模型的
     `submit_result` 是它这一轮的最后一个动作，一条 ask 的交换结束时它一定已经落完），但门禁那种
     「模型还没产出任何卡片就把值提交上去」的快节奏里，会话可能在两轮之后才 idle 一次——此时到达的
     turn end 记到最老那条 ask 上、而**最新那条停在临时值**（复制它的前缀会短一截）。p4b 门禁的
     前驱是「一个 actor 一条 ask」，所以那里每条 ask 的边界都等于会话真实长度（断言 `b`）；
     同会话多条 ask 的快速连答是**未验证的边角**。

---

# P4b 门禁记录 — amend 的导入缓存与转录种子（第二轮）

第一轮 14/14 只验了「已完成的 ask 不再重跑」（结果级复用），并把转录种子记成如实降级。第二轮把
降级项 ① 补上了，门禁扩到 **18/18**。
