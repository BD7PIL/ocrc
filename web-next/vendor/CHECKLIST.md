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
- 🔶 任务行状态点（running 转圈已通；未读蓝点/错误红点见下）。未读蓝点与错误红点已通：
  unread 由 host state 覆盖（POST /api/sessions/:id/unread，后端硬编码 false 的那一层
  现在有真源），error 用既有 latch。running 转圈待 sessions-index 订阅接线（批次 2）。
- ✅ 置顶分区（listPinnedTasks/listPinnedTaskIds + setTaskPinned 走 host state.pinnedTaskIds ——
  与 TG 共用一份，不是浏览器本地偏好；注意它和 relay 的 pinnedSessionId 是两回事）
- ⬜ 归档视图（archive 全家）
- ⬜ 任务组（颜色/拖拽分组——grouped 结构空实现）
- ✅ 时间线分区空态（conversation 工作区语义，忠实）

## 3. 会话时间线（N2 核心）
- ✅ 任务视图打开 + 标题栏
- ✅ **真实历史消息渲染**（v4 wire 通道：初始 snapshot 帧 → rows 渲染，ping/pong 实证）
- ✅ **v4 恢复阶梯接通**（resync 如实回 resume/snapshot + 每订阅单调 logicalFrameOrdinal；升级恢复/强制快照路径由真实 store+assembler 回归测试覆盖——修复了间歇性 fault.subscription.recoveryFailed）
- ✅ **开回合流式增量上屏**（/ws card 事件 → rows 前缀 diff → row.appended/row.upserted online 增量；前缀失配回退全量 online snapshot。隔离栈实证：用户消息 1.5s 上屏、bash 工具卡随引擎执行逐步出现，全程无刷新）
- 🔶 markdown/代码块渲染（streamdown，shiki worker）：行数据已就位，worker 生产构建
  可用性待逐组核对（见批次 4）
- ✅ **工具卡带真实输出**（N6 批次 2B）。此前工具行只有 toolName + 截断的 args，
  `output`/`display` 全空 → 卡片只显示"调用了什么"，不显示"做成了什么"。根因在
  数据层：事件流不带 `parts[].state.output`（引擎只在 REST 上给），行映射又只喂
  `inputText`。现在按 messageId 回取 `/api/session/:id/message/:msgId`（5s TTL 缓存）、
  把 bash 投影成 ZCode 的 `display.kind='bash_output'`（真 stdout，50k 截断），
  其余工具给 `output.text`——**不臆造 file_diff**（edit/write 的 patch 不在工具结果里，
  编一个 structuredPatch 就是假数据）。同时修 `status`：`running` 不再塌成 `success`
  （此前执行中的工具当场显示已完成、没有转圈）。隔离栈实证：发「用 bash 执行 ls -la …」
  → 卡片渲染出真实 stdout（截图 /tmp/n6-toolcard.png）。
- ⬜ 推理块折叠展示
- ⬜ 用户消息气泡 + 编辑/fork 动作
- ⬜ 消息悬停动作（复制/反馈）
- ✅ 加载更早（rows 分页游标 conversationRowsRangeV4）：按 rowId < beforeRowId 从完整历史
  切尾部 limit 行——行号由 buildRows 顺序生成、历史不变即稳定，无需服务端游标。
- ⬜ TurnNavigator（右侧轮次刻度）

### 已知缺陷（待立项整改，输入见 docs/perf-remediation-brief.md）
- 🔶 **性能：/z/ 整体卡顿**（2026-10-08 用户实测「几乎无法使用」，已决定立项整改）。已观察证据：
  loopback 28.8MB/6s、热路径全量重建+全量对比（每事件 O(N)）、工具卡回取、getView 双请求风暴。
  整改期间会话面热路径**冻结新功能**（详见简报的边界条款）。
- 🔶 **回复重复渲染**（用户截图可见，同源缺陷）：行号 = 位置序号，流式中插入行会使后续 rowId
  位移 → diff 当「删+增」→ 重复渲染。整改方向：行身份改内容寻址；与性能同批修，以回归测试钉住。

### 已修缺陷（N6 过程中实测）
- ✅ **远端主机启用后不注册**（`src/transport/web/index.ts`）：host 传了 `onRemoteEnabled`、
  server 也消费它，中间这层 buildServer 调用却漏传——表现为「面板里启用远端 → 隧道起来了，
  但后端要重启才出现」。已补上转发（代码级修复；实机验证需要一台 remote）。
- ✅ **model-presets 的 current 恒为 {}**（`server.ts`）：`registerSettingsProject` 的第三个参数
  `globalConfigRaw` 是 getter，调用点只传了两个 → `readMapping(undefined, …)`。现在传 getter
  每次读盘。实证：往隔离栈全局配置写 `agent.sisyphus.model` → 端点立刻回
  `{"current":{"sisyphus":"deepseek/deepseek-v4.1-flash"}}`（修复前恒为 {}）。
- ✅ **删除不存在的会话返回成功**（`routes/sessions.ts`）：引擎对未知 id 也回成功，客户端拿到
  `{ok:true}` 却什么都没删。现在先 `hasSession` 判存在：未知 id → 404
  `{"ok":false,"error":"session not found"}`，真实会话 → 200。两者均在隔离栈实测。
- ✅ **/z/ 无凭证时渲染空黑壳 → 复用旧壳同一套配对门**（2026-10-08，用户实测「打不开」+
  追问「两种配对 UI 居然不一样」）：该 origin 没有 token 时所有 API 401，壳拿不到 workspace
  就渲染空黑 div。第一版修法是自造一个「粘长 token」的门——**这是错的**：产品已有 M11 配对
  协议（`#pair=` 一次性令牌 / QR，`lib/auth.ts` 状态机 + `/api/pair/exchange`），一套产品
  两套凭证体验。现在 / 与 /z/* 共用**同一个** PairGate 与同一套引导：`#token=` 采纳、
  `#pair=` 换取、401 降级都在 lib/auth.ts 模块初始化里（与路由无关），ZCodeApp 遇 401 只调
  共享的 `onUnauthorized()`。实证（无头 Chrome 走用户的局域网地址 192.168.26.101：4099）：
  无凭证时 /、/z/、/z 三处文案与视觉完全一致；`#pair=` 链接在 /z/ 换取成功并直接渲染出真实
  会话；`#token=` 落地同样 stored + 渲染。
- ✅ **远端主机启用后不注册**（`src/transport/web/index.ts`）：host 传了 `onRemoteEnabled`、
  server 也消费它，中间这层 buildServer 调用却漏传——表现为「面板里启用远端 → 隧道起来了，
  但后端要重启才出现」。已补上转发（代码级修复；实机验证需要一台 remote）。
- ✅ **model-presets 的 current 恒为 {}**（`server.ts`）：`registerSettingsProject` 的第三个参数
  `globalConfigRaw` 是 getter，调用点只传了两个 → `readMapping(undefined, …)`。现在传 getter
  每次读盘。实证：往隔离栈全局配置写 `agent.sisyphus.model` → 端点立刻回
  `{"current":{"sisyphus":"deepseek/deepseek-v4.1-flash"}}`（修复前恒为 {}）。
- ✅ **删除不存在的会话返回成功**（`routes/sessions.ts`）：引擎对未知 id 也回成功，客户端拿到
  `{ok:true}` 却什么都没删。现在先 `hasSession` 判存在：未知 id → 404
  `{"ok":false,"error":"session not found"}`，真实会话 → 200。两者均在隔离栈实测。
- ✅ **/z/ 无凭证时渲染空黑壳**（2026-10-08 用户实测「打不开」的第二例）：该 origin 的
  localStorage 里没有 token 时，每个 API 都是 401，壳拿不到 workspace 就渲染出一个
  空黑 div——零线索。现在 ZCodeApp 引导时显式检测 401/403 并渲染**凭证门**（说明 + 粘贴框
  + 「保存并进入」+ 指向旧控制台的配对入口），同时采纳 `#token=` 片段（与旧壳同样的加固：
  本地已有不同 token 时不覆盖），采纳后清 hash。token 按 origin 存储，换地址（127.0.0.1
  ↔ 局域网 IP）要各自落地一次——已在门文案里写明。
- ✅ **重建 web 后 /z/ 白屏**（2026-10-08 用户实测「打不开」）：host 把 index.html 在启动时
  读一次缓存，重建后仍发旧 index——它引用的 chunk 哈希已被新构建替换，浏览器拿到
  text/html 当模块脚本（MIME 强校验拒绝）→ 整页白屏。修法：index.html 按 mtime 失效
  （`src/transport/web/index.ts`，`/` 与 `/next/*` 两处），重建即时生效、不再需要重启 host。
- ✅ 同一根因的另一半：`restart-ocrc.sh` 会连带杀掉隔离栈，重启后需单独拉起 4199。
- ✅ 隔离栈启动命令必须带 `OCRC_BACKENDS=opencode`：缺了它活跃后端是 ACP/kimi（未安装）
  → 引擎永远起不来、/z/ 空白（此前文档里的命令漏了这项）。

### N6 批次 2C 已接（2026-10-08）
- ✅ **sessions-index 订阅三件套**：此前 `subscribeSessionsIndexV4` 走幽灵 → `await` 拿到函数
  再取 `.ack` 直接 TypeError，侧栏永远只有静态列表。现在真 snapshot（`sessions-index/<workspaceId>`
  五件套帧）+ 由 ws `session.status` 驱动的 `session.upserted` 增量（ocrc 的 /api/sessions 不带
  busy，status 帧带 —— 本地维护）。隔离栈实证：侧栏 6 行、控制台零异常。
- ✅ 跨窗口广播：web 端用原生 BroadcastChannel（send/onMessage）；claim 租约用 localStorage
  + 过期时间（窗口崩溃不会永久占锁）。
- ✅ 技能面：list ← /api/settings/skills-manager（源/启用/冲突真事实）、setEnabled ← toggle
  （enable = symlink 进 ~/.config/opencode/skills）。内容编辑/删除/跨机同步如实拒绝 ——
  ocrc 的技能生效模型是「源目录 + symlink」，没有 .zcode/skills 通用目录。
- ✅ MCP 读取面：loadMcpFromUserDirectory / listWorkspaceMcpServerStatuses ← /api/mcp +
  项目级 /api/settings/project/mcp。全局目录级写入如实拒绝（structured 写只有 provider 一族）。
- ⬜ 附件管线（图片/文件上传）：web 端要走 File → attachmentBeginV4/ChunkV4/CommitV4 →
  sendText.attachments 的整条链（ocrc 后端已支持 images[] base64），未接。

## 4. Composer（Lexical）
- ✅ 富文本输入框挂载 + 占位文案
- ✅ 权限模式 chip（变更前确认）
- ✅ 管理模型入口
- ✅ 发送按钮
- ✅ **sendPrompt 端到端**（composer → sendConversationCommandV4 → /api/message → 引擎回复落盘；流式增量上屏为后续增量映射项）
- ✅ 模型门禁放行（modelSelection view 带 optionSpecs/effectiveSelection；readSession/快照 config 填真实 current 模型）
- ✅ **模型配置打通**（2026-10-08 验收反馈修复）：①composer 模型下拉此前为空（只剩「管理模型」）——根因是 provider config 缺 api.type，被 supportsRegistryApiFormat 门整体过滤；现在 /z/ 的 provider 目录统一补 api:{type:"openai"} 占位（引擎模型全是 OpenAI 兼容面），12 个 provider 组 + 全部模型项正常列出、选中即 radix radio 生效。②设置→模型设置页此前空白（providerSettingsService 返回空 providers）——现以 ocrc 引擎目录真实回填（ProviderSettingsView 全形），供应商卡片/模型清单可见；增删改类 mutation 明确拒绝（目录属引擎配置 ~/.config/opencode，/z/ 不提供写入），不做假成功
- ✅ **模型配置可写打通**（2026-10-08 N6 批次 1，用户报「添加供应商失败」后修）：
  providerSettingsService 的 10 个 mutation 全部接真后端——创建/写 key/写模型 →
  `POST /api/settings/opencode-config/provider`（JSONC 校验 + .ocrc-bak 备份 + 原子写，
  与旧 rc.2 面板同一条路径）、删除/重排 → `POST /api/settings/opencode-config/reorder`
  与 patch 的 `delete:true`、连通性 → `POST /api/settings/test-provider`（key 不出 host）。
  读侧改为**以配置文件为准**（/api/models 只补显示名与 variants），刚建、引擎尚未重载的
  供应商立刻可见；`effectiveConfig.group='standard-personal'` 是设置页分区键，缺了会被整段过滤。
  实证（隔离栈 CDP 全网迹）：创建自定义供应商 → `POST .../provider {providerId:'provider',
  name:'新供应商'}` 200 → 导航出现「新供应商」→ 填 Base URL + API Key blur 落盘 → 磁盘配置
  确含两者、GET 摘要只回 `sk-e…5678`。视图里的 keyHint 有写入侧拦截（含 '…' 的值不回写）。
- ✅ **v4 写命令接线**（N6 批次 1）：switchModelConfig → /api/overrides（opencode 无会话级
  切换，等价语义 = 下一轮覆盖）、switchCollaborationMode → /api/session/:id/policy、
  renameSession/deleteSession → 既有路由；cancelBackgroundWork 等仍如实回
  `ocrc_unwired_<type>`（不假装成功）。
- ✅ 停止生成（stopGeneration → /api/abort；N6 批次 1 补上响应码检查——此前不看结果）
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
- 🔶 Git 面板（gitService）：只读面已通（N6 批次 2A）——host 侧 `GET /api/git`
  给 repoRoot/ahead-behind/numstat/本地分支/identity（ocrc 原有 /api/vcs 是从引擎转手的
  窄面，不够用），`GET /api/git/diff` 出差分。写操作（stage/commit/push/切分支）
  留批次 3，此前如实拒绝。
- ✅ 文件浏览器/查看器（fileService）：14 个方法全部接线（N6 批次 2A）——readdir/stat/
  checkFilesExist ← /api/browse + 新增 POST /api/file-stat；readTextFile/readFileRange ←
  /api/file-slice、/api/file-base64（引擎读文件拿不到二进制，host 自己读盘）；
  searchWorkspaceFiles ← /api/files/search；listWorkspaceFiles* ← /api/files/index
  （ZCode 的列式 packed 索引 1:1 兼容，type\trelativePath 转义规则照抄）。
  路径一律经 containment 校验（safeResolve，符号链接感知）。`.zcodeignore` 不适用：
  读接口给说明模板、写接口如实拒绝（ocrc 的文件索引由 host 内置规则决定，不写一个
  没人读的文件假装生效）。
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
- ✅ 远程主机管理（2026-10-08 裁决②：本期做映射，方向为 ocrc 语义原生进 /z/——ZCode 的桌面 SSH-connectRemote 语义浏览器客户端做不了，ocrc 的 host 侧隧道 + 远端引擎注册才是正确模型）。设置页新增「远程主机」分区（vendor 新增 RemotesSection + settingsNavigation/config/i18n 四点接线）：列表/状态（隧道本地端口）/启停（PATCH live 生效）/SSH 探测/删除/新增，全走 ocrc /api/remotes。启用远端后会话自动并入任务列表，/z/ 侧栏即见、流式同源
- ✅ 定时任务重做为 off-peak 取号语义（2026-10-08 裁决③：用户拍板「本来就不是 cron」）。新 ocrc 后端 `core/offpeak.ts`：一次性工单 queued→running→completed/failed（FIFO 单并发、低峰窗口 OCRC_OFFPEAK_WINDOW 默认 00:00-08:00、createSession+relay 派发、模型经 setNextModel 派发前应到引擎、permissionMode→审批策略 edit/yolo、完成检测用会话忙碌位）+ /api/offpeak CRUD。/z/ service 重接后状态机同形：实证「offpeak e2e probe」创建→派发新会话→引擎回复→已完成，闲时任务页全部分类/进行中/已完成/失败正常渲染。cron scheduler（TG 面板在用）未动，退役另行裁决

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

## 12. 退役与 rc.3 执行清单（验收通过后按序执行）
1. **切换默认落点**：web-next/src/App.tsx 路由翻转——`/` 直挂 ZCodeApp（懒加载），`/z/*` 保留为书签兼容别名；`/share/:code` 落地页保持在鉴权门外；旧控制台路由（/session/:id、/automations、/settings、/dev/tokens）移除挂载（ShellLayout/CommandCenter/NewSessionDialog/ChannelsDialog/PairGate 及 pages/ 成为死代码，可留待 rc.4 清理或一并删除）；旧面板的 WS boot/全局键盘在 `/` 不再挂载。
2. **重建部署**：`npm run build:all` + `bash ~/bin/restart-ocrc.sh`，验证 `/`、`/z/`、`/share/:code` 三落点。
3. **文档收口**：AGENTS.md 架构指向更新（/ 为 ZCode 壳）；CHECKLIST 第 12 节本清单勾掉。
4. **打 rc.3**：package.json 版本 → rc.3，git tag，tag→CI OIDC 发布（既有通道）。
