# CHECKLIST.md — /z/ 逐组件验收底表（Q7 仪器）

> 用法：每个里程碑对清单打勾。状态：✅ 已验证可用 · 🔶 部分可用/降级 · ⬜ 未接（服务未实现）· 🚫 产品裁决不做 · ➕ N4 ocrc 域待建。
> 基准：对屏对照 zai-org/ZCode v3.14.3 真实产品。更新本表 = 更新验收事实。

## 1. 引导与壳
- ✅ 首启身份（oauth authenticated ocrc-local）
- ✅ 工作区引导（initialWorkspaceAbsPath = 最近会话目录）
- ✅ 侧栏骨架（WorkspaceSidebar：动作行/视图胶囊/分组/页脚）
- ✅ 主区欢迎页（问候语 + Lexical composer + 项目选择器）
- ✅ 顶栏（返回/前进 + 任务标题 + 工作区操作）
- ⬜ Header 全要素（搜索入口/模型指示/分享菜单——部分依赖未接服务）

## 2. 左栏任务面
- ✅ 新建任务行 + Ctrl+N 提示
- ✅ 搜索行 + Ctrl+K 提示
- ✅ 自动化入口（路由到自动化主视图——内容 N4）
- ✅ 插件市场入口（🚫 产品裁决不做，占位）
- ✅ 分组/项目视图胶囊
- ✅ 项目分组卡（折叠/展开/计数徽章）
- ✅ 任务行（标题/时间/悬停删除/置顶钉）
- ✅ 任务行点击 → 打开会话（v4 通道）
- ⬜ 任务行状态点（running 转圈/未读蓝点/错误红点——依赖流事件接线）
- ⬜ 置顶分区（listPinnedTasks 空实现）
- ⬜ 归档视图（archive 全家）
- ⬜ 任务组（颜色/拖拽分组——grouped 结构空实现）
- ✅ 时间线分区空态（conversation 工作区语义，忠实）

## 3. 会话时间线（N2 核心）
- ✅ 任务视图打开 + 标题栏
- ✅ **真实历史消息渲染**（v4 wire 通道：初始 snapshot 帧 → rows 渲染，ping/pong 实证）
- ✅ **v4 恢复阶梯接通**（resync 如实回 resume/snapshot + 每订阅单调 logicalFrameOrdinal；升级恢复/强制快照路径由真实 store+assembler 回归测试覆盖——修复了间歇性 fault.subscription.recoveryFailed）
- ⬜ markdown/代码块渲染（streamdown，shiki worker）
- ⬜ 工具卡族（bash/edit/todo/read…ToolCallBlocks 渲染器族）
- ⬜ 推理块折叠展示
- ⬜ 用户消息气泡 + 编辑/fork 动作
- ⬜ 消息悬停动作（复制/反馈）
- ⬜ 加载更早（rows 分页游标 conversationRowsRangeV4）
- ⬜ TurnNavigator（右侧轮次刻度）

## 4. Composer（Lexical）
- ✅ 富文本输入框挂载 + 占位文案
- ✅ 权限模式 chip（变更前确认）
- ✅ 管理模型入口
- ✅ 发送按钮
- ✅ **sendPrompt 端到端**（composer → sendConversationCommandV4 → /api/message → 引擎回复落盘；流式增量上屏为后续增量映射项）
- ✅ 模型门禁放行（modelSelection view 带 optionSpecs/effectiveSelection；readSession/快照 config 填真实 current 模型）
- ⬜ 停止生成（stopGeneration → /api/abort）
- ⬜ @ 上下文选择（fileService 文件枚举）
- ⬜ / 斜杠命令面板（commandsService）
- ⬜ 模型选择器数据（modelSelection 真目录已接，选择写回 overrides）
- ⬜ 附件管线（图片/文件上传）

## 5. 状态面板
- ⬜ 折叠条「计划 n/m」
- ⬜ Todo 清单区（plan/todoGroups）
- ⬜ 子代理区（subagents）
- ⬜ 自动展开语义（composer empty + running）

## 6. 命令中心与快捷键
- ✅ Ctrl+K 命令面板（CommandCenterDialog + commandsService：ocrc /api/commands 引擎命令）
- ✅ 快捷键层（useShortcutBindings 注册；/z/ 路由隔离已断开旧面板快捷键）
- ⬜ 快捷键提示（kbd 标签——待逐面板核对）

## 7. 右侧面板族
- ✅ 面板骨架 + ✕ 关闭
- ⬜ Git 面板（gitService → ocrc /api/vcs）
- ⬜ 文件浏览器/查看器（fileService → ocrc /api/files）
- ⬜ 工具输出页（messageRaw）
- ⬜ 子代理转写页
- ⬜ 计划详情页
- ⬜ 终端页（🚫 ocrc 裁决不做）

## 8. 设置页族
- ✅ 设置主视图渲染（基础设置/常规/外观/模型设置/浏览器控制/键盘快捷键/Agent 能力/记忆 全分区）
- ✅ settingService：appSettings 完整默认 + ocrc /api/settings 只读透传（形状有意不合并）
- ⬜ 设置字段语义级对齐 ocrc（可写回项——N4+）
- ⬜ MCP 管理（mcpSyncService）
- ⬜ 技能管理（skillsService）
- ⬜ 插件面（pluginsService——ocrc 无对应，占位说明）

## 9. 通道与自动化（N4）
- ✅ 自动化主视图（offPeakTaskService → ocrc /api/schedules：list/create/pause/continue/delete 映射；空态忠实）
- ✅ Bots 数据面（botsService getStatus/getConfig/listBots → ocrc /api/channels telegram 通道投影）
- ✅ Bots 写回（saveBot/deleteBot → PATCH /api/channels/:id enabled；testBot → hasToken 检查；注册三件套未接）
- ⬜ 已知余项：/z/ 每次页面加载持久化一个预热草稿会话，跨页加载不回收（页内 closeDeferredDraftSession 已实现但仅在 pane 替换草稿时触发）——候选：deferred 伪会话首发才落盘，或 host 侧空草稿回收（N5）
- ⬜ 远程主机管理（ocrc remotes ↔ ZCode remote workspace——概念映射待 N4.x）
- ⬜ 定时任务创建表单（createTask 已接，表单字段对齐待核对）

## 10. 分享与周边
- ✅ 分享落地页路由（ShareLanding 已有独立实现）
- ⬜ conversationShareService（ocrc shares API 对接）
- ⬜ 白板（WhiteboardPane ➕ N4）
- ⬜ 画中画浏览器（EmbeddedBrowserPane ➕ N4 / ocrc sidecar browser）

## 11. 全局底座
- ✅ zai 双主题（暗/亮切换）
- ✅ 字阶 + 圆角 + 滚动条 + 焦点策略（styles.css 原生）
- ✅ 错误边界（App + Scoped）
- ⬜ 移动端适配（断点/安全区）
- ⬜ i18n 切换（zh-CN 已定）
- ⬜ 性能预算（8.4k 模块分包/懒加载审查）
