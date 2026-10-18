# 决策日志（decisions）

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

> 从这里开始，**一个决定一条**，不再每轮新开一份 verdict 文档。
> `docs/research/` 与 `docs/handoff/` 是历史档案（当时的调研与交付记录），保留可查；
> 新的取舍写进这里，一条一页，带日期与"为什么"。

| 日期 | 决定 | 页面 |
|---|---|---|
| 2026-06-12 | 跨工作区会话不流式（接受限制） | [2026-06-12-cross-workspace-streaming.md](2026-06-12-cross-workspace-streaming.md) |
| 2026-10-17 | OCRC 收敛：一个 openchamber 扩展 + 一套 CI 兼容包 | [2026-10-17-convergence.md](2026-10-17-convergence.md) |

## 写法

- 文件名 `YYYY-MM-DD-<slug>.md`；正文四段：**决定 / 为什么 / 代价 / 现状与证据**。
- 只写**现在成立**的结论；被推翻的决定在原页顶部加一行 `> 已被 <新页> 取代`，不删页。
- 引用的证据要可复跑（命令、文件路径、测试名），不写"已验证"了事。
