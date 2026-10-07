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
- ✅ **开回合流式增量上屏**（/ws card 事件 → rows 前缀 diff → row.appended/row.upserted online 增量；前缀失配回退全量 online snapshot。隔离栈实证：用户消息 1.5s 上屏、bash 工具卡随引擎执行逐步出现，全程无刷新）
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
- ✅ Bots 数据面（botsService getStatus/getConfig/listBots → ocrc /api/channels 全通道投影：telegram/wechat/lark/dingtalk → provider telegram/weixin/feishu）
- ✅ Bots 写回全量对齐·服务层（saveBot → PATCH /api/channels/:id：enabled + credentialValue→credentials.token（tg getMe 活校验）+ replyMode→replyGranularity + allowedWorkspaces→workspaces scope；deleteBot→enabled:false；testBot→hasToken+live；getBotStates→[] 防 BotsDialog 的 Promise.all 整体失败）
- ✅ Bots UI 面板（BotsDialog）已进 /z/（2026-10-08 裁决：保持 UI 效果下最小 vendor 补丁——WorkspaceSidebarFooter 触发器门控改读 platform 能力位 webRemoteControlAvailable（+1 行 + 注释），桌面缩放等 isDesktop UX 不连带）。弹层实证：通道列表（ocrc Telegram/wechat/lark）、BotFather token 保存（→ saveBot → getMe 活校验）、回复颗粒度、工作区范围、删除机器人全部可达；getConfig 已改为与 listBots 同源投影（此前空列表）
- ✅ 预热草稿跨页回收（/z/ 引导后台清理历史遗留空草稿：默认标题「New session - 」+ 5 分钟不新鲜 + 0 消息三重守卫；改名/有内容/其他标签页新草稿不动。隔离栈实证：3 个陈旧空草稿清掉、带消息会话保留、当页新草稿豁免）
- 🚫 Bots 注册三件套（feishu/weixin QR 扫码注册、createBindCode、webhook secret）——依赖 ZCode 自有 bot 服务端，ocrc 通道为凭证制（token/appId+appSecret 在 rc.2 面板或 env 配置）；如需 /z/ 内配置入口属产品裁决（「粘贴凭证」降级形态可行）。removeBotSecret 亦暂缺——ocrc PATCH 不能清空 credentials（空对象被路由丢弃），reset 会连通道配置一起重置，过猛
- ⬜ 远程主机管理（ocrc remotes ↔ ZCode remote workspace——概念映射待 N5 裁决）
- 🔶 定时任务创建表单字段核查结论（2026-10-08）：vendor ZCodeOffPeakTaskCreateParams = {title, prompt, permissionMode, modelSelection, workspacePath, boundSessionId?}，ocrc scheduler 仅支持 {name, prompt, spec: every|daily, enabled}。**已映射**：title→name、prompt→prompt、enabled。**无对应**（静默丢弃，不误写）：permissionMode/modelSelection（ocrc 定时派发走 host 默认模型）、workspacePath/boundSessionId（ocrc 无 per-schedule 工作区/会话绑定）。**语义差异（裁决项）**：ZCode off-peak 是「取号排队」一次性票态（queued/ready/active/expired/settled），ocrc schedules 是周期性 cron 提示（every/daily）——UI 票态语义与 ocrc 周期执行根本不同。如需对齐须先裁决：ocrc scheduler 增加 directory/model/mode 字段 + 派发语义改造（backend 功能项），或 /z/ 侧明确呈现为「周期任务」独立概念

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
