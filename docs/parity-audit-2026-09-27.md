# 双通道功能对齐审计（TG ↔ Web）

日期：2026-09-27 ｜ 方法：以 `handlers.ts` 注册命令（26 条 + 4 键盘按钮）与
`web/src/routes`+components 逐项对照，非凭记忆。

## A. 双通道已对齐 ✓

| 功能 | TG | Web | 数据源 |
|---|---|---|---|
| 模型/agent 目录与覆盖 | 🧠/🤖 菜单+键盘 | AgentChip/ModelChip | 同一 getModels（connected 集 + config 三层过滤）✓ |
| 定时任务 | /tasks /task /taskdel 向导 | SchedulesPanel CRUD | 同一 /api/schedules + scheduler core ✓ |
| 图片输入 | photo→getFile→images | composer 上传 | 同一 images 管线（submit.ts）✓ |
| 忙碌排队 | ⏳ ack + relay 队列 | 乐观卡 + 同队列 | relay per-session turn queue ✓ |
| 权限审批 | 中文合并卡三键 | CardApproval | /api/approval once/always/reject ✓ |
| 计划/任务清单 | /todo | TaskPanel + 悬浮球 | /api/session/:id/todo ✓ |
| 流式渲染/历史/markdown/工具块 | 渲染管线 | feed | 同一 cardBus 事件源 ✓ |
| diff / abort / /commands↔palette / workspaces↔switcher / rename | ✓ | ✓ | 同 API ✓ |
| Question 卡 | 休眠移植 | 无 | opencode 1.18.32 无 question 面——双端一致 N/A |

## B. 仅 TG 有 → web 缺

| # | 功能 | web 现状 | 建议 |
|---|---|---|---|
| B1 | **后台会话完成通知**（TG: "ℹ️ 后台会话已完成" + 打开按钮） | ❌ 无任何提示 | P1：document.title 闪烁 + favicon 角标 +（可选）Web Notification；数据已在 ws sessions 广播里 |
| B2 | 中文界面（zh 默认词典） | ❌ 全英文 | 押后（用户裁决：随 /settings 一起） |
| B3 | /status /version 服务器信息 | ❌ 无 UI（version 路由存在无人消费） | P3：palette "about" 项或页脚 |
| B4 | /files 最近改动文件速览 | 部分（WorkingDirPanel diff + @提及搜索） | 视为覆盖，不动 |

## C. 仅 web 有 → TG 缺

| # | 功能 | TG 现状 | 建议 |
|---|---|---|---|
| C1 | **子代理可视化+跳转**（悬浮球/角标/面包屑） | ❌ | P3：/subs 列表 + inline 按钮发 web 深链 |
| C2 | **建议 chips**（Tier1 starters + Tier2 模型生成） | ❌ | P2：finalize 后 inline keyboard 建议；**语义需裁决**——TG 无草稿概念，点按=直接发送（web 是填入不发送） |
| C3 | **Regenerate**（↻ 重发最后一条） | ❌ | P2：assistant 卡 inline ↻，语义同 web（重发最后 user 消息） |
| C4 | 会话删除 / cleanup-subagents | ❌ | P3：/sessions 行内 🗑（二次确认） |
| C5 | /mode（build/plan 会话级切换） | ❌（有 /agent /model 全局覆盖，无 mode） | P3 |
| C6 | 多后端切换（active backend） | ❌ | 小众，挂起 |
| C7 | 未读标记（SessionSummary.unread 字段已存在） | N/A | web 自身也未渲染——B1 一起做 |

## D. 结构性差异（非缺陷）

- TG = 单目标会话（pinned/last + detach）；web = 路由驱动多会话并行查看。
- TG 富文本 = Telegram MarkdownV2 三段降级；web = 全 markdown 渲染。

## 建议批次

- **P1**：B1 后台完成通知（web）——高频场景，纯前端。
- **P2**：C2 TG 建议 chips（需裁决点击语义）+ C3 TG regenerate。
- **P3**：C1 /subs、C4 会话删除、C5 /mode、B3 关于信息。
- **押后**：B2 web 中文（等 /settings i18n 开关项）。


---

## 附录：实施记录（2026-09-28 无人值守批次）

- **B1 ✅** `web/src/lib/notify.ts`：ws sessions 广播差分 → 非当前会话活动闪烁标题
  `🔔 N 新动态 — ocrc`；回到标签页或进入会话即清。
- **B2 ✅** web 界面全面中文化（直排 zh，与 TG 同策略）：标题栏/composer/空态/
  Inspector 各面板/审批卡/chips/palette/modal/pair gate/悬浮球/FAB/连接徽标。
- **B3 ✅** 命令面板底部 about 条：`ocrc v<version> · uptime …`（/api/version）。
- **C1 ✅** TG `/subs`：子代理列表 + 「📤 打开」web 深链按钮。
- **C2 ✅** TG 建议 chips：finalize 后 3s/9s 轮询 state 建议 → inline 键盘，
  点按=直接发送（TG 无草稿箱，已裁决的语义偏离）。
- **C3 ✅** TG regenerate：最终消息 ↻ 重发上一条（文本取自会话历史，web 发起
  的对话同样可重发）。
- **C4 ✅** /sessions 行内 🗑 两步确认 + `/cleanup` 清理子代理会话。
- **C5 ✅** `/mode`：会话级 mode 切换（getControls/setMode）。
- **额外（M9 部分预埋）**：`core/channels.ts` 通道设置存储（~/.ocrc/channels.json，
  原子写 0600）；`/api/channels` GET/PATCH/reset；`/api/pair/qr`（服务端 SVG）；
  web「机器人与通道」弹窗（启用开关/凭证表单/回复粒度/工作区范围/重置/配对 QR）；
  TG 粒度消费（standard 隐藏工具行）、工作区范围过滤 /workspaces 与 /new、
  enabled=false 时启动不创建 TG transport；`/channels` TG 状态命令。
  飞书/微信通道本体仍等外部凭证；pending-token 吊销语义为二期。

## 附录 3：OC Manager 调研驱动的三项优化（2026-09-28，四 commit）

调研文档 `docs/oc-manager-research-2026-09-26.md`（Mrsandman327/OpenCode-Client，结论：
与本插件互补而非竞争）。基于其三个可借鉴发现落地：

- **A ✅ 同步补齐**（ca6d835）：CardBus 环形 buffer 100→256 + `oldestSeq()`；
  ws `replayEnd` 带 `complete` 标志（快照早于 buffer 起点=false，借鉴其 sse-lagged
  "慢客户端显式通知"）；客户端 replayEnd/缺口（`isSeqGap`）→ REST 重同步。
- **B ✅ 长会话窗口化**（4d9e4f5）：渲染只出最近 80 卡 + 顶部"加载更早"；
  `GET /api/session/:id?offset=`（message 空间分页，`cardsFromMessages` 开窗）
  + `hasMore`；prepend 滚动锚定。569 卡冻结浏览器问题的根治。
- **C ✅ question 交互问询双端**（610e32f + 3153987）：backend 三方法
  （raw fetch，directory 由 session 解析，404→stale）+ capabilities.questions；
  TG 端 `question-flow`（互斥槽位、逐题单消息、raw-label `string[][]`、
  外部已答清理；上游 QuestionManager 因答案格式不匹配 API 未直接启用）；
  Web 端 `CardQuestion`（chips/多选/自定义文本）+ `/api/question/reply|reject`。
  **关键实证**：1.18.32 的 V1 插件 event hook **不含** question.* 事件——
  它们只走 `/global/event` SSE（信封 `{directory,project,payload}`），
  V1 wireEvents 因此补一条仅转发 question.* 的专用 SSE（其余会话事件
  仍单源走 hook，无双投递）；`questionFlow.present` 按 requestId 幂等兜底。
- **E2E 留痕**：prompt→SSE→TG 向导+web 卡片→`/api/question/reply` 200→
  opencode 收答收尾→resolved 卡回推→槽位 `question_answered` 清理。
- **运维教训**：spike 重启连续失败定位为 spike `opencode.db` schema 偏斜
  （baseline 迁移报 `no such column: project_id`），备份至
  `/tmp/ocrc-spike/db-backup-20260928/` 后重建即愈——与代码无关；
  长会话窗口化的真机压测因 demo 会话随 DB 清空而以单测覆盖为准。
