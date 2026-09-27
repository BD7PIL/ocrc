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
