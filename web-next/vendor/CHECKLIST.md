# CHECKLIST.md — /z/ 逐组件验收底表（Q7 仪器）

> 用法：每个里程碑对清单打勾。状态：✅ 已验证可用 · 🔶 部分可用/降级 · ⬜ 未接（服务未实现）· 🚫 产品裁决不做 · ➕ N4 ocrc 域待建。
> 基准：对屏对照 zai-org/ZCode **v3.15.1** 真实产品（tag `aac4755`，2026-10-11 Batch 2 升级；前一基准 v3.14.3）。更新本表 = 更新验收事实。
> 差距总账：[docs/frontend-integration-audit.md](../../docs/frontend-integration-audit.md)（服务/平台/协议/UI/i18n/新增六面，逐项归属）。
>
> **收口口径（2026-10-10，N12 批末对账；P4/P4b 当日收口后更新）**：本批完成后，「ZCode 有而我们
> 没有」的**体验面归零**。剩余非 ✅ 只有两类：①产品裁决不做的（终端页签/插件市场/CUA/画中画、
> 工作区文件写、Bots 扫码注册，见 🚫 条）；②不在「前端复刻」口径内的（桌面壳、ACP 多 harness
> ——各属独立项目）。**workflow 面板面（原第 ② 类）已随 P4/P4b 落地**：四道门禁
> （p4-projection 23/23、p4-queries 37/37、p4-saved 20/20、p4b-amend 18/18）逐项对账，见下方
> workflow 条与 docs/workflow-p4-record.md。另有四处非 ✅ 属「非缺口/独立批次」（工具输出页不在
> vendor 口径内、技能管理写侧部分、移动端最小壳层、性能缩表），各自条目里已注明。

## 1. 引导与壳
- ✅ 首启身份（oauth authenticated ocrc-local）
- ✅ 工作区引导（initialWorkspaceAbsPath = 最近会话目录）
- ✅ 侧栏骨架（WorkspaceSidebar：动作行/视图胶囊/分组/页脚）
- ✅ 主区欢迎页（问候语 + Lexical composer + 项目选择器）
- ✅ 顶栏（返回/前进 + 任务标题 + 工作区操作）
- ✅ Header 全要素（N7-6 实测核心要素：模型指示 ✓ 分享入口 ✓ 搜索在侧栏=ZCode 信息架构；
  N12 复核仍全绿，见下方「分享发布」节的 header 全要素条）。

## 2. 左栏任务面
- ✅ 新建任务行 + Ctrl+N 提示
- ✅ 搜索行 + Ctrl+K 提示
- ✅ 自动化入口（路由到自动化主视图——内容 N4）
- ✅ 插件市场入口（🚫 产品裁决不做，占位）
- ✅ 分组/项目视图胶囊
- ✅ 项目分组卡（折叠/展开/计数徽章）
- ✅ 任务行（标题/时间/悬停删除/置顶钉）
- ✅ 任务行点击 → 打开会话（v4 通道）
- ✅ 任务行状态点（N12 复核：三项全通）——未读蓝点由 host state 覆盖
  （POST /api/sessions/:id/unread，后端硬编码 false 的那一层现在有真源），错误红点用既有
  latch，running 转圈由 sessions-index 订阅接线（`subscribeSessionsIndexV4` 真 snapshot +
  ws `session.status` 帧 → `busyBySession` → `session.upserted` 推相位）。
- ✅ 置顶分区（listPinnedTasks/listPinnedTaskIds + setTaskPinned 走 host state.pinnedTaskIds ——
  与 TG 共用一份，不是浏览器本地偏好；注意它和 relay 的 pinnedSessionId 是两回事）
- ✅ 归档视图（N7-5 全家接通：archiveTask/unarchiveTask/listArchivedTasks/archiveStaleTasks/
  archiveWorkspaceTasks/deleteArchivedTask(s)，默认列表隐藏已归档；隔离栈往返实证）
- ✅ 任务组（N10）：host state.json 三槽位（groups/members/topLevelOrders）+ `GET/POST /api/task-groups`
  （create/rename/color/delete/order，shape 校验 fail-fast，删组级联）+ 桥接 5 个组方法全接真。
  组为**全局**组织维度（侧栏显示已按 workspace 过滤）。隔离栈实测：建组→挂成员→分组视图渲染
  出组与组内任务→改色→重命名→删除级联，刷新持久。
- ✅ 时间线分区空态（conversation 工作区语义，忠实）

## 3. 会话时间线（N2 核心）
- ✅ 任务视图打开 + 标题栏
- ✅ **真实历史消息渲染**（v4 wire 通道：初始 snapshot 帧 → rows 渲染，ping/pong 实证）
- ✅ **v4 恢复阶梯接通**（resync 如实回 resume/snapshot + 每订阅单调 logicalFrameOrdinal；升级恢复/强制快照路径由真实 store+assembler 回归测试覆盖——修复了间歇性 fault.subscription.recoveryFailed）
- ✅ **开回合流式增量上屏**（/ws card 事件 → rows 前缀 diff → row.appended/row.upserted online 增量；前缀失配回退全量 online snapshot。隔离栈实证：用户消息 1.5s 上屏、bash 工具卡随引擎执行逐步出现，全程无刷新）
- ✅ **markdown/代码块渲染 + shiki 高亮（生产构建实证，N7-6）**：隔离栈生产 bundle 发
  「用 python 写 hello world」→ 回复的 ```python 块渲染出语言标签 + 语法着色（关键字/
  字符串/注释色分明，截图 /tmp/n7-render.png）——非 dev、非本地，真实产品构建。
- ✅ **TurnNavigator**（右侧轮次刻度）：会话打开时随行数据出现（DOM 3 节点，N7-6 实测）。
- ✅ **推理块映射补全（发现真缺口并修复）**：后端本就采集推理（normalizer 收 reasoning part →
  流式卡片 blocks 带 live thinking；回合定稿时收进卡片 `thinkingText`，blocks 保持
  reasoning-free 以免 TG/纯文本渲染器看到思考）。但桥接层**只映射 blocks** → 回合定稿、
  卡片落盘后 /z/ 的推理块消失（流式期有、之后没了）。现在 `thinkingText` 也映射成 reasoning
  行（顺序与流式期一致：推理在正文前）；契约测试 3 条（定稿出行/不与流式块重复/无思考不造空行）。
  **实机复核仍待**有 reasoning 输出的会话（两个引擎全库扫描 0 条）——不造假数据。
- ✅ **工具卡带真实输出**（N6 批次 2B）。此前工具行只有 toolName + 截断的 args，
  `output`/`display` 全空 → 卡片只显示"调用了什么"，不显示"做成了什么"。根因在
  数据层：事件流不带 `parts[].state.output`（引擎只在 REST 上给），行映射又只喂
  `inputText`。现在按 messageId 回取 `/api/session/:id/message/:msgId`（5s TTL 缓存）、
  把 bash 投影成 ZCode 的 `display.kind='bash_output'`（真 stdout，50k 截断），
  其余工具给 `output.text`——**不臆造 file_diff**（edit/write 的 patch 不在工具结果里，
  编一个 structuredPatch 就是假数据）。同时修 `status`：`running` 不再塌成 `success`
  （此前执行中的工具当场显示已完成、没有转圈）。隔离栈实证：发「用 bash 执行 ls -la …」
  → 卡片渲染出真实 stdout（截图 /tmp/n6-toolcard.png）。
- ✅ 推理块折叠展示（N7-6 映射 + N8-1/N8 补全：重建路径 thinkingText（b4b3870）与直播
  delta 归类（d2235e2）都已修，生产会话实测 65 卡 26.6 万字符、直播 42s 回合推理连续上屏。
  「已处理」折叠组 UI 已见；展开态核对待用户一眼）
- ✅ 用户消息气泡 + 编辑/fork 动作（**N9 批已交付**）：buildRows 现写 `entityId`（= 卡片
  messageId，内容寻址行身份同批落地）→ 悬停按钮显形条件满足；`editUserQuery`（revert 截断
  + 原文重发，ACK disposition:'rewind'；文件回退 rewind 无 checkpoint 机制、如实拒绝）与
  `forkAssistant`（引擎 `POST /session/:id/fork` 直通，ACK 带新 sessionId）都已实现。隔离栈
  E2E：fork 子会话带全 216 卡、revert 截断 216→2、重发追加生效。
- ✅ 消息悬停动作（N9）：复制 ✅ 纯前端；编辑/fork ✅（见上条）；反馈 ✅ 按 entityId
  本地持久（localStorage `ocrc.feedback`，重建时回读进行、高亮态不丢）——**引擎侧无
  feedback 面**，语义如实限定为本地偏好（不喂引擎，文案不谎报）。
- ✅ 加载更早（rows 分页游标 conversationRowsRangeV4）：按 rowId < beforeRowId 从完整历史
  切尾部 limit 行——行号由 buildRows 顺序生成、历史不变即稳定，无需服务端游标。

### N7 逐项（2026-10-08 开工，接 N6）
- 🚫 **工作区文件写（N7-4）——核实后不做**：vendor UI 没有「保存文件到工作区」的消费方
  （全库仅 `platform.saveFile` 用于把图片/PDF 导出到用户本机，另一回事）。建端点 = 无主
  攻击面，违反不做清单纪律。证据：vendor 全库 grep writeTextFile/saveFile/writeFile 无
  工作区写入调用。
- ✅ **归档语义**（N7-5）：state 增 `archivedSessionIds` 槽位 + `POST /api/sessions/:id/archive`
  （{archived:bool}），SessionSummary 覆盖 `archived` 标记；前端 archiveTask/unarchiveTask/
  listArchivedTasks/archiveStaleTasks（ZCode 语义：只归档非 pinned/非未读/非 error 的超期
  任务）/archiveWorkspaceTasks/deleteArchivedTask(s) 全接；默认任务列表隐藏已归档。
  隔离栈实测：archive → 列表标记 true → unarchive → 全部还原 false。
- ✅ **git 写操作**（N7-3）：host 侧 `POST /api/git/{stage,discard,commit,push,branch}`——全部
  固定参数 execFile（无 shell、无字符串拼接），路径白名单校验（拒绝 `..`、绝对路径、注入字符），
  分支名按引用规则白名单校验。未跟踪文件的 discard = 删除（`git rm` 不认未跟踪，走 fs 删除，
  只删 git 确认过未跟踪的那几个）。push 无 upstream/无远端时**如实失败**。前端 gitService 的
  stage/unstage/discard/commit/push/switch/createBranchAndSwitch 全接（generateCommitMessage
  需要模型调用，如实拒绝）。后端单测 7 条（暂存区真变/提交短哈希/未跟踪删除/跟踪还原/分支切换
  +非法名拒绝/注入面拒绝/push 如实失败）+ 隔离栈 scratch 仓库路由 E2E 全链实证。
  **过程记录**：第一轮 E2E 误把 directory 指到 ocrc 仓库（创建了探针分支）——已当场恢复
  （checkout main + 删分支），并改为一次性 scratch 仓库重做；教训：git 路由 E2E 永远用一次性仓库。

- ✅ **附件管线**（N7-1）：composer「+」→ 附件菜单 → 文件选择器（platform.selectFile/selectFiles
  用真 `<input type=file>`）→ **getPathForFile 返回 ocrc-webfile:// 句柄** → composer 的本地
  零拷贝链路把句柄原样放进 sendText.attachments[].ref → 发送时解析回字节转成
  /api/message 的 images[]。上传家族（attachmentBeginV4/ChunkV4/CommitV4/AbortV4/ReadV4）
  同步做真（内存暂存 + ocrc-att:// 引用），target 未注册的竞态窗口也能走通。
  **这个设计特意绕开了 crypto.subtle**：零拷贝路径不算校验和。而 N8-4 已把唯一剩下的
  受限路径也解锁——纯 JS SHA-256 回退（vendor 补丁 #4，PATCHES.md）：非安全上下文下
  checksum() 不再抛 checksumUnavailable，返回格式不变。非图片附件如实拒绝（ocrc 发送
  通道仅支持图片）。实证（隔离栈 4199，CDP 拦截文件选择器塞真 PNG）：芯片就绪无重试、
  POST /api/message 带 images[]（base64 与塞入文件一致）、引擎收到图（免费模型不支持
  视觉属模型能力，非管线）。
- ✅ 拖放/粘贴大文件路径（N8-4 解锁）：无 localPath 的附件走 serialize+V4 上传，
  checksum 在非安全上下文回退纯 JS SHA-256。E2E：LAN http 源（192.168.22.202:4199，
  crypto.subtle 缺失）真实拖放 PNG → 无报错 → POST /api/message images[] → 引擎
  落 file:image/png part（2026-10-09）。12 条单测对照 node crypto（padding 边界全覆盖）。
- ✅ 停止生成（stopGeneration → /api/abort；N6 批次 1 补上响应码检查——此前不看结果）
- ✅ **性能：/z/ 卡顿（N9 批已整改，2026-10-09 实测复核）**。基线（206 卡）：首屏 1.3–1.5s、
  单 refetch 12–122ms/~50KB、每回合一次 50–148ms longtask。整改：行身份内容寻址（N9-1）、
  缓存/回取预算/去抖（N9-2）、sdelta 复活（N9-3）。整改后（216 卡）：首屏 **1.84s（<2s ✓）**、
  流式 11 次采样 + 定稿**零重复行（✓）**、refetch 次数减半、sdelta 每回合 9+ 帧。
  **残余**：longtask 仍 1×137ms/回合——全量 rebuild 固有 O(N)，窗口化（rowsWindow 游标协议
  已在）按计划不做，留观察。数字详见 docs/perf-remediation-brief.md。
- ✅ **回复重复渲染（N9-1 根除，2026-10-09 复核）**：rowId 由位置序号改为**内容寻址**
  （messageId + 块序的确定性哈希），中间插入行不再位移后续 rowId；diffRows 改前缀身份 +
  按键浅比较（去掉整行 stringify）。216 卡会话流式 11 次采样 + 定稿均零重复行；
  `rowIdentity.test.ts` 6 条回归钉住（幂等重建 / entityId 落行 / 追加不位移 /
  末行增长同 rowId / thinking 补插不位移 / 旧引擎无 messageId 兜底）。

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
- ✅ MCP 读取面 + 写侧（N8-3）：loadMcpFromUserDirectory / listWorkspaceMcpServerStatuses ←
  /api/mcp + 项目级 /api/settings/project/mcp + 全局 /api/settings/opencode-config/mcp；
  用户级结构化写入（见 §8 MCP 管理条）。
- ✅ 附件管线（图片/文件上传，N7-1 全链）：File → attachmentBeginV4/ChunkV4/CommitV4 →
  sendText.attachments → /api/message images[]（详见 §4 附件管线条；N8-4 解锁非安全源拖放）。

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
- ✅ @ 上下文选择（fileService 文件枚举：searchWorkspaceFiles → /api/files/search、
  listWorkspaceFiles* → /api/files/index 列式 packed 索引，N6 批次 2A 接通）
- ✅ / 斜杠命令面板（commandsService.list → /api/commands 引擎用户命令；命令文件管理面
  ocrc 无对应，如实拒绝）
- ✅ 模型选择器（modelSelection 真目录 + switchModelConfig 写回 /api/overrides；N6/N7 接通）
- ✅ 附件管线（图片/文件上传，N7-1 全链；N8-4 解锁非安全源拖放）

## 5. 状态面板
- ✅ 折叠条「计划 n/m」+ Todo 清单区（plan ← /api/session/:id/todo，N6 批次 2B 接通）
- ✅ 子代理区（running ← snapshot.subagents、已结束目录入口 ← listSessionSubagents + 补丁 #5，
  N8-2/N8-5 实证：「智能体 / 已结束 1」）
- 🔶 自动展开语义（composer empty + running）——**接受现状，非缺口**：依赖 vendor 的
  面板 hasContent 门。只剩历史（无运行中子代理/无 todo/无计划）的会话面板恒 null 是**上游
  自身行为**；补丁 #5 只为已结束子代理开门（若不补，旧会话连目录入口都没有）。活会话内
  完全按 vendor 原生语义走，不做 ocrc 侧的门改造（改了就偏离复刻口径）。

## 6. 命令中心与快捷键
- ✅ Ctrl+K 命令面板（CommandCenterDialog + commandsService：ocrc /api/commands 引擎命令）
- ✅ 快捷键层（useShortcutBindings 注册；/z/ 路由隔离已断开旧面板快捷键）
- ✅ 快捷键提示：侧栏「新建任务 Ctrl+N」「搜索 Ctrl+K」可见（vendor 用 span 而非 <kbd> 标签，
  意图即提示存在——N7-6 截图核对）
- ✅ header 全要素：模型指示（composer 触发器）✓、分享入口 ✓（N7-2 接线后出现）、
  搜索在侧栏（ZCode 信息架构即如此）

## 7. 右侧面板族
- ✅ 面板骨架 + ✕ 关闭
- ✅ Git 面板（gitService）：只读面 N6 批次 2A（host 侧 `GET /api/git` 给
  repoRoot/ahead-behind/numstat/本地分支/identity——ocrc 原有 /api/vcs 是从引擎转手的窄面，
  不够用；`GET /api/git/diff` 出差分），写操作 **N7-3 已全接**（stage/unstage/discard/
  commit/push/switchBranch/createBranchAndSwitch，固定参数 execFile、路径白名单），本条旧记
  「写操作留批次 3」是陈旧记录。N12 G9 补上最后一处：`generateCommitMessage` 此前唯一如实
  拒绝（"需要模型调用"），现走 host `POST /api/git/commit-message`——取工作区 diff（24KB
  有界截断）→ 一次性子会话生成（`tools:{}` 禁写）→ 剥围栏/引号；没改动/无通道/空回复各自
  如实报错。
- ✅ 文件浏览器/查看器（fileService）：14 个方法全部接线（N6 批次 2A）——readdir/stat/
  checkFilesExist ← /api/browse + 新增 POST /api/file-stat；readTextFile/readFileRange ←
  /api/file-slice、/api/file-base64（引擎读文件拿不到二进制，host 自己读盘）；
  searchWorkspaceFiles ← /api/files/search；listWorkspaceFiles* ← /api/files/index
  （ZCode 的列式 packed 索引 1:1 兼容，type\trelativePath 转义规则照抄）。
  路径一律经 containment 校验（safeResolve，符号链接感知）。`.zcodeignore` 不适用：
  读接口给说明模板、写接口如实拒绝（ocrc 的文件索引由 host 内置规则决定，不写一个
  没人读的文件假装生效）。
- ✅ 后台 bash 输出页（N8 D2 实证）：ocrc 没有"后台任务"概念——**运行中的 bash 工具
  调用就是它**。snapshot 的 `backgroundWorks` 投影 running 的 bash 行（workId 编码
  `ocrc-tool:<messageId>:<partId>`），`backgroundBashOutputV4` 按编码回取该 part 的
  `state.output`（8KB 上限截断，`outputPath` 用 `ocrc://tool-output/…` URI——ocrc 没有
  输出文件，不编造盘上路径）。状态面板「终端 · 1 后台」→ 点开 → 输出页实时显示
  （隔离栈实测：sleep 90 运行中点开，完成后输出 `d2-live-output-done`）。
- ⬜ 工具输出页（messageRaw）——**不在复刻口径内**（vendor 根本没有这项）：**N8-5 核实——vendor 没有通用"工具输出页"**。右侧面板族里
  与工具输出相关的只有 `bash-output`（后台 bash 任务输出，入口在状态面板的**运行中**
  后台任务行，数据模型是 workId，ocrc 无对应概念）。行内富化输出（N6 批次 2B）已覆盖
  常规展示（50k 截断）。若要"看完整输出"需产品侧先定形态（见 N8 计划的 D2）。
- ✅ 子代理转写页（N8-5 实证）：点目录里的子会话行 → 右侧标签页打开嵌套 SessionPane
  （子会话 id 是真实引擎 session，走已桥接的 v4 会话订阅；隔离栈截图确认标签出现）。
- ✅ 子代理目录页（N8-2 + N8-5 实证）：`listSessionSubagents` 桥接 + 后端 `/subagents`
  扩字段（agent/createdAt/error + `?limit`/`?todos`），状态面板「智能体 → 已结束 N」
  入口打开目录（隔离栈实测：「已结束 · 1 / n8-5 subagent probe / 已完成 / 20分」）。
  **附带 vendor 补丁 #5**：上游自认 endedSubagentCount 没进 hasContent → 只剩历史的
  会话整块面板返回 null、目录入口不可达；补一行条件（PATCHES.md #5）。
- ✅ 计划详情页（2026-10-09 补齐并实测）：**核实** opencode 的 plan agent 没有
  ExitPlanMode 工具（只用 bash/glob/grep/question + 正文 Markdown），而 vendor 的计划面族
  （时间线计划卡、状态面板「计划」目录、计划详情侧页）全以 `toolName==='ExitPlanMode'` 的
  行做锚点。桥接做法：① plan 回合（卡 meta.agent==='plan'）的产出正文投影成 ExitPlanMode
  行（toolCallId 前缀 `plan-` 标明投影、markdown 放 input.plan）；② 实现
  `conversationPlansV4` RPC（目录数据源，rowId 降序）；③ composer 选「计划」时
  payload.planEnabled=true → `/api/message` 带 `agent:'plan'`（引擎原生 plan agent），
  新增 per-message agent 通道（优先于 TG 的一次性 nextAgent 槽）。隔离栈实测：plan 回合
  552 字计划 → 时间线出计划卡（「查看完整计划」）→ 状态面板「计划」目录 4 项（标题取
  markdown 首行）→ 点开 `plan-detail:…:plan-msg_…` 侧页渲染全文。
  已知取舍：plan 回合的正文同时以消息行 + 计划卡出现（同一文本两处可见）；澄清性提问
  回合也会成计划条目（不做文本嗅探过滤）。
- ✅ **权限/提问 dock 全接（U1，2026-10-11）**：cardBus approval/question 卡 →
  vendor `PendingInteraction` 投影（`zcode-services/pendingInteractions.ts`，14 条单测对
  vendor zod schema 钉死形状）→ 快照 `pendingInteractions` + live `state.updated` 键级
  整替。回程 `resolveInteraction` 分支：permission optionId（与 host decision 同词）
  → `/api/approval`；userInput action accept→`/api/question/reply`（ElicitationDialog
  content → `answers:string[][]` 换算，跳题留空行保位）、decline/cancel→`/api/question/reject`。
  host 侧补齐三处：①host 模式 question 事件此前被 INTERACTION_TYPES 闸掉（只放行
  permission 族），现 question.asked/replied/rejected 同管道发卡 + TG 转发（plugin 模式
  原本就有）；②三处 approval 发布点补显式 id `approval:${requestId}`，resolution 时
  （permission.replied / `/api/approval` 路由回执）原 id 重发布 resolved 卡 =
  dock 权威清除信号；③cardBus 新增交互卡驻留区（latest per id，resolved 先逐出）并
  由 `GET /api/session/:id` 并回——桥的取数路径是 REST 历史，交互卡原本只活在 /ws。
  **零 vendor 改动**。隔离栈双 dock UI 实测：permission（external_directory ask）渲染
  →点「允许一次」→dock 清除→「已处理」→引擎落盘；question（引擎 question 工具）
  渲染→选 staging 提交→dock 清除→卡 resolved=replied answers=[['staging']]。
- ⬜ 终端页（🚫 ocrc 裁决不做）

## 8. 设置页族
- ✅ 设置主视图渲染（基础设置/常规/外观/模型设置/浏览器控制/键盘快捷键/Agent 能力/记忆 全分区）
- ✅ settingService：appSettings 完整默认 + ocrc /api/settings 只读透传（形状有意不合并）
- ⬜ 设置字段语义级对齐 ocrc（可写回项）——**归独立批次**：读侧已完整（appSettings 默认 +
  /api/settings 只读透传，形状有意不合并）；写侧要逐字段把 vendor 的语义映射到 ocrc 配置面，
  是一条独立工作线（N4+），不在前端复刻口径内。
- ✅ MCP 管理（N8-3 接上写侧）：用户级 upsert/delete/set-enabled → host 结构化 patch
  （全局 opencode.json，备份+原子写+引擎启动同款校验），project 级走既有项目路由；
  platform（本地 workspace 实际命中点）与 mcpSyncService（identity 路径）共用 mcpWrite.ts。
  列表并上「已写、引擎未重载」的全局条目（source=user，disabled 如实标注）——opencode
  不热重载配置，不并则写入看起来"没保存"。假成功根除：此前 platform 桩返回失败又被
  vendor store 的 .catch(logger.warn) 吞掉。E2E：写入落盘+备份、非法条目如实拒绝、
  删除、引擎重启后 /api/mcp 可见（隔离栈）。
- 🔶 技能管理（skillsService）：list + setEnabled（symlink 启停）真实现；copyToCommon/
  removeFromCommon/deleteSkill 如实拒绝——ocrc 的技能生效模型是"源目录 + symlink"，
  没有 `.zcode/skills` 通用目录，删除动用户源文件不属于面板（文案见 skillsService.ts）。
  UI 上唯一会露出的拒绝是 deleteSkill（SkillsSection 错误横幅）。这个拒绝是**对的**，
  维持现状。
- ✅ 插件面读侧（N11-2：pluginsManagementService 映射引擎 opencode.json 的 `plugin` 数组 →
  设置页「已安装」真数据，enabled 如实；marketplace/安装/卸载等 mutation 如实拒绝——
  PRODUCT.md 2026-10-07 裁决"插件市场不做"，文案注明真相源=编辑 opencode.json + 重启引擎；
  getPluginReferenceCatalog 诚实空 catalog——ocrc 的 sendText 通道不携带插件引用语义）
- ✅ **子智能体面读侧 + model 覆盖（U4，2026-10-11）**：subagentsService 接真——list 走
  引擎合并配置（`GET /api/agents-full`，global+project、无 model 门槛）+ 项目 agent 节
  （`GET /api/settings/project/agents`）标 projectPath 落点；model 覆盖
  （setBuiltInModelOverride/setPluginAgentModelOverride）→ `POST …/agents` merge patch
  写项目 `agent.<name>.model`（备份+原子写，prompt/description 保留；清空=删项目条目回落
  全局）。ZCode 专有字段（color/permissionMode/maxTurns/skills/mcpServers）不带——硬映射
  =造假。setEnabled/create/update/delete withGhosts 如实拒绝（分期二）。
  单测 6 条钉投影与回写（`__tests__/subagentsService.test.ts`）。已知边界：设置页
  「子智能体」默认作用域=用户级（vendor 判据=设置上下文里有 workspace tab），ocrc 的
  agent 全部 workspace scope——默认 tab 显示诚实的空态 + 「仅桌面端」提示；工作区作用域
  下列表与 model 下拉生效（服务层+端点已实测）。
- ✅ **fileWatcherService 接真（U4）**：/ws 新 `file-watch` 帧（host `src/core/file-watcher.ts`：
  node fs.watch，300ms 防抖合并、目录上限 64、拒绝 `/` 与相对路径；ws detach 释放该客户端
  全部注册）。web-next fileWatcherService 自带懒 ws + 断线重连重登记；git 自动刷新/文件树/
  pptx 消费面的 unhandledrejection 根除。原生 ws 客户端实测：watched 确认帧、双写去抖成
  1 帧/带 changedPath、unwatch 后写入无事件。
- ✅ **clientConfigService / clientScenesService 小件（U4）**：静态 null 快照 / 空 scenes
  （clientScenes 不能 undefined——useClientScenesResource 对 undefined WeakMap.set 会
  TypeError）。帮助菜单 URL 与商店排序两处 ghost reject 消失。
- ✅ **U4 拒绝类登记（如实不接）**：usageStatsService / highspeedCardService /
  credentialService（ZCode 账号/订阅体系，硬映射=造假）；hooksService（opencode 1.18 无
  用户级 hooks 配置面）；memoryService / gitCheckpointService / outputStyleService /
  promptAttachmentTransferService（isDesktop 闸死或全仓 0 消费者，留幽灵零成本）；
  terminalService（PRODUCT 裁决不做，入口已随 U3 摘除）；pluginsService mutation 与
  settingsSync 引导（插件市场不做 / OnboardingDialog 已摘）。

## 9. 通道与自动化（N4）
- ✅ 自动化主视图（offPeakTaskService → ocrc /api/schedules：list/create/pause/continue/delete 映射；空态忠实）
- ✅ Bots 数据面（botsService getStatus/getConfig/listBots → ocrc /api/channels 全通道投影：telegram/wechat/lark/dingtalk → provider telegram/weixin/feishu）
- ✅ Bots 写回全量对齐·服务层（saveBot → PATCH /api/channels/:id：enabled + credentialValue→credentials.token（tg getMe 活校验）+ replyMode→replyGranularity + allowedWorkspaces→workspaces scope；deleteBot→enabled:false；testBot→hasToken+live；getBotStates→[] 防 BotsDialog 的 Promise.all 整体失败）
- ✅ Bots UI 面板（BotsDialog）已进 /z/（2026-10-08 裁决：保持 UI 效果下最小 vendor 补丁——WorkspaceSidebarFooter 触发器门控改读 platform 能力位 webRemoteControlAvailable（+1 行 + 注释），桌面缩放等 isDesktop UX 不连带）。弹层实证：通道列表（ocrc Telegram/wechat/lark）、BotFather token 保存（→ saveBot → getMe 活校验）、回复颗粒度、工作区范围、删除机器人全部可达；getConfig 已改为与 listBots 同源投影（此前空列表）
- ✅ 预热草稿跨页回收（/z/ 引导后台清理历史遗留空草稿：默认标题「New session - 」+ 5 分钟不新鲜 + 0 消息三重守卫；改名/有内容/其他标签页新草稿不动。隔离栈实证：3 个陈旧空草稿清掉、带消息会话保留、当页新草稿豁免）
- 🚫 Bots 注册三件套（feishu/weixin QR 扫码注册、createBindCode、webhook secret）——依赖 ZCode 自有 bot 服务端，ocrc 通道为凭证制（token/appId+appSecret 在 rc.2 面板或 env 配置）；如需 /z/ 内配置入口属产品裁决（「粘贴凭证」降级形态可行）。removeBotSecret 亦暂缺——ocrc PATCH 不能清空 credentials（空对象被路由丢弃），reset 会连通道配置一起重置，过猛
- ✅ 远程主机管理（2026-10-08 裁决②：本期做映射，方向为 ocrc 语义原生进 /z/——ZCode 的桌面 SSH-connectRemote 语义浏览器客户端做不了，ocrc 的 host 侧隧道 + 远端引擎注册才是正确模型）。设置页新增「远程主机」分区（vendor 新增 RemotesSection + settingsNavigation/config/i18n 四点接线）：列表/状态（隧道本地端口）/启停（PATCH live 生效）/SSH 探测/删除/新增，全走 ocrc /api/remotes。启用远端后会话自动并入任务列表，/z/ 侧栏即见、流式同源
- ✅ 定时任务重做为 off-peak 取号语义（2026-10-08 裁决③：用户拍板「本来就不是 cron」）。新 ocrc 后端 `core/offpeak.ts`：一次性工单 queued→running→completed/failed（FIFO 单并发、低峰窗口 OCRC_OFFPEAK_WINDOW 默认 00:00-08:00、createSession+relay 派发、模型经 setNextModel 派发前应到引擎、permissionMode→审批策略 edit/yolo、完成检测用会话忙碌位）+ /api/offpeak CRUD。/z/ service 重接后状态机同形：实证「offpeak e2e probe」创建→派发新会话→引擎回复→已完成，闲时任务页全部分类/进行中/已完成/失败正常渲染。cron scheduler（TG 面板在用）未动，退役另行裁决

### 目标循环（N12）——**ZCode goal 面全链**

- ✅ 右侧 goal 面（objective/status/迭代 N、逐轮摘要、暂停/继续按钮）：数据面 = host
  `GET /api/session/:id/goal` → 桥接 `projectGoal` 投影成 vendor 六态 + `availability.pauseGoal/
  resumeGoal` 按上游 `projection-state.ts` 的门派生（可续才开 pause、paused 才开 resume，
  无 goal 带 noGoalToPause/Resume 原因码驱动禁用 tooltip）。
- ✅ 闭环本体在 host（`src/core/goal.ts`）：回合末采样记账 → 验收（独立子会话，`tools` 禁写）
  → 通过=complete / 未达成带 nextAction=续跑 / 撞闸或验收器坏掉=停机+通知。续跑文本对齐上游
  `formatGoalContinuationPrompt`（objective 用 `<untrusted_objective>` 包裹 + 预算行 + audit
  指引），验收提示词照抄上游 `formatGoalCompletionVerificationPrompt`。
- ✅ **四处有意偏离上游**（都记在最靠前的注释里）：①**fail-closed**——上游坏 JSON 判"通过"，
  我们停机；②**两条上游没有的硬闸**——迭代上限 12、无进展检测（连续 2 轮同 nextAction）；
  ③续跑**可见**（origin `goalContinuation`）；④权威状态在 host state.json（上游在会话存储）。
- ✅ 时间线：每轮验收一条 `timelineMarker`（**lane 必须是 `turnTailBoundary`**，否则被折进
  「已工作」折叠组），running 与终态共用 rowId（终态 upsert 覆盖）；续跑轮 `turnHeader/
  userInput` origin = `goalContinuation`（vendor 的轮次导航/分享只认 `realUser`，所以既无
  幽灵用户气泡、又能看见"又跑了一轮"），气泡只显示短展示行、整段提示词折进 epilogue 披露。
- ✅ 命令面：/z/ 的 `sendGoalCommand`/`pauseGoal`/`resumeGoal` 接真到 `POST /api/goal`（此前
  落 `ocrc_unwired_*`）；TG `/goal set|pause|resume|clear|status` + 内联按钮 + BotFather 菜单 +
  /help。刷新不靠 ACK：ws `goal` 帧 → `state.updated`（goal + 完整 availability 八键）→ 前端即刻收敛。
- ✅ 冷恢复：host 重启后 active 目标一律落 `paused`（上游同款，绝不自动拉起），`resume` 可续。
- ✅ 闲时补尾（N12 G8）：`queuePosition`（读出时按 FIFO 派生，不落盘）、`boundSessionId`
  （会话内创建首跑 resume 绑定会话，会话没了回落新建）、失败/取消可 `continue` 重取号、任务可
  携带 goal（派发后挂目标，kickoff 由工单自己的 prompt 承担）。`tests/unit/offpeak.test.ts`
  补上 N5 欠下的 24 条单测。
- ✅ workflow：**引擎、工具面与面板面都已可用**（P0–P4，见
  [../../docs/workflow-p3-record.md](../../docs/workflow-p3-record.md) 与
  [../../docs/workflow-p4-record.md](../../docs/workflow-p4-record.md)）。逐项对账 vendor 的验收表：
  - 时间线 run 卡（工具卡 join）— 门禁 p4-projection `k`
  - 状态面板 Workflows 分区与目录入口 — p4-projection `l`（徽标/面板模型/分区标题）+
    **p4-queries `ad`/`ae`**（`auto → panel` 后正文排版可见、分区开出 `workflow-run-directory-trigger`；
    第一轮那句「mini 变体下正文不排版」是门禁自己点错了按钮——`data-state` 在 `auto` 下一直是
    `expanded`，展开分支从未执行，见 workflow-p4-record 第三轮）
  - run 侧页（状态/结果/阶段/并发/待答问题 + 脚本因果图）— p4-projection `n`/`o`/`p`、p4-queries `v`
  - workspace 侧页与 7 条 v4 查询 — p4-queries `d`–`r`
  - artifact 侧页（真读到字节）— p4-queries `x`/`y`
  - run 目录侧页（已结束 run 列表 → 开详情页）— p4-queries `af`（`endedCount=1`，行就是本次 run）
  - saved workflows 面板（列表/启动/运行历史）— p4-saved `g`–`n`
  - 侧栏轨道（`workflowActivity`）— p4-projection `j`
  - 冷快照不丢 run（刷新后仍在）— p4-projection `m`
  - 4 条命令（Stop / Resume / Configure / 启动已保存）— p4-projection `o`/`q`/`r`、p4-saved `k`
  - amend 的导入缓存（结果级复用）— p4b-amend `g`–`j`
  - amend 的转录种子（分歧 actor 的会话带前驱前缀）— p4b-amend `k`–`n`
  两处**如实拒绝/降级**：`moveSavedWorkflow` 拒绝（机器级 store，没有可搬的文件）；amend 不带
  in-flight 条目、resume 只回看一代前驱（转录种子**已实现**，按后端 `forkSession` 能力降级）。
- **spike 实测记录**：[docs/n12-spike-record.md](../../docs/n12-spike-record.md)——
  A/C/D/E/F/G 隔离栈实测通过（含 UI 截图与 DOM 断言）；B 的 /z/ 半场用真 UI 点按钮通过，
  **TG 半场待用户本人跑**（我没有 Telegram 客户端，无法以用户身份发消息）。spike 修出
  三处真缺陷：证据窗口头部截断、resume 不续跑、续跑可落进 plan 模式（均已修 + 回归）。

### 分享发布（N7-2 + N7-6 实测）——**端到端已闭环**
- ✅ 服务侧全接（publish → POST /api/share；record 四元组；导入/续聊如实拒绝）+ 契约测试 6 条。
- ✅ **dock 全流程 CDP 实测通过**：入口 conversation-share-trigger → dock → 全选轮次（2/2）→
  下一步 → 披露勾选 → 生成分享链接 → `POST /api/share` → 界面「分享已创建」。
  落盘验证：分享码 `Y62L7O6wxhLk`（标题「图片颜色查询」、4 卡）；公开落地页
  `GET /api/share/Y62L7O6wxhLk` 免鉴权取回同样内容。
- ✅ 打通这条链修出**四个真缺陷**（都是「界面看着有、功能用不了」的同类）：
  1. 行缺 `productTurnId` → 「可分享轮次」映射为空 → 轮次复选框受控于空列表（点不动的真根因）；
  2. 快照缺 `meta` → schema 默认 `{title:''}` → 分享标题恒空（空串不走 `??` 回退）→
     「生成分享链接」永久禁用；
  3. `onDynamicPublishProgress` 实现成「直接收 listener」而非「(opId) → Event」工厂 →
     发布时 `... is not a function`；
  4. preflight 返回 `turnResults: []` → 无可选轮次 id。
  四条各有回归测试（productTurnId 在 reasoningRows.test、meta/工厂形状/轮次在 shareService.test）。

## 10. 分享与周边
- ✅ 分享落地页路由（ShareLanding 已有独立实现）
- ✅ conversationShareService（N7-2 端到端闭环：全选 → 披露 → 生成分享链接 → POST /api/share
  → 公开落地页免鉴权取回同内容；四个集成缺陷已修并有回归测试，详见「分享发布」节）
- ✅ 白板（N11-1，PATCHES #6：解注释 `+` 菜单画板入口；vendor store 纯内存零 fetch，
  刷新即失——PRODUCT.md「纯前端」口径内；「添加到对话区」= window CustomEvent →
  composer PNG 附件 → 既有 sendText 通道，隔离栈实测全链路通（画线→添加→`画板 1.png` 入 composer））
- 🚫 画中画浏览器（EmbeddedBrowserPane）——**关闭项，不立项**：PRODUCT.md 列为 M7 级工程
  （host 侧车无头浏览器 + WS 流化 + MCP 工具挂引擎），体量独立立项；ocrc 已有
  `registerBrowser` 路由雏形与 `src/cli/mcp-browser.ts`，届时接。本期入口保持关闭。

## 11. 全局底座
- ✅ zai 双主题（暗/亮切换）
- ✅ 字阶 + 圆角 + 滚动条 + 焦点策略（styles.css 原生）
- ✅ 错误边界（App + Scoped）
- 🔶 移动端适配（N8-7 最小壳层适配）：安全区消费（.zcode-shell-root 接 env(safe-area-inset-*)，
  index.html 的 viewport-fit=cover 此前没人用）+ 触屏指针下可编辑控件 16px（修 iOS 聚焦
  整页缩放；composer 用 text-ui-base=14px）。iPhone 模拟实测两项生效、390px 可用。
  **更大布局改造（初始收起侧栏等）需改 vendor WorkspaceShellLayout，遵 D4 裁决不做**。
  **2026-10-11 移动端逐控件审计**：[docs/frontend-mobile-audit.md](../docs/frontend-mobile-audit.md)
  （CDP 探针实测 12 状态 × 2 档 + 六组深审；结论——官方移动壳族在本仓是死代码，接线规格
  实现就绪且零 vendor 改动；本轮修仅 ocrc 侧垫片/CSS/图标，vendor 布局手术维持 D4 不做）。
  **2026-10-11 W1/W2 移动壳接线已落地**：官方移动壳族全量激活（switcher prop 仅移动视口
  传入，matchMedia 与 vendor 同查询串；跨工作区切换 = Root 重挂，与 ?session= 深链同路）。
  后端 SessionSummary 补 createdAt/busy 真数据。**vendor 改动仍为零**（D4 口径如实保留，
  PATCHES 不新增条目；接线时揭露的 `onDynamicConversationFrame` 裸函数违约是 ocrc 幽灵
  服务自身 bug，ocrc 侧一行修）。取舍（手机无设置/自动化/插件市场/命令面板入口=官方
  配套语义）与回退预案（listWorkspaces 降级单工作区）见审计文档 §5。探针新增壳判定 +
  跨工作区重挂 E2E（390/360 实测过）+ 桌面回归档。
- ✅ i18n 切换（N8-5 核实——此前勾"未做"是误记）：vendor 自带 zh-CN/en-US 全套
  （5874/5875 条）+ 两处切换入口（侧栏头像菜单、设置→General），localStorage
  （zcode-locale-preference）持久。ocrc 侧自研 service 的硬编码中文错误串在英文模式下
  会中英混排（如实记录，不阻塞）。
- ⬜ 性能预算（分包/懒加载审查）——**N12 G9 已出数字与归因，缩表归独立批次**：
  首屏 = 入口 441.8 kB + 唯一静态 chunk **8,688.4 kB**（gzip 2,434 kB）+ CSS 385.9 kB
  （gzip 62.8 kB）≈ **2.6 MB gzip**。上游**已经**把重件各自懒分包（pdf-viewer / pptx、xlsx
  预览引擎 / prism 语言包 / wasm / mermaid 的各类 diagram），分包结构本身是对的；8 MB 壳层
  是 vendor UI + streamdown/remark/shiki/katex/zod 的**热图**。已测：mermaid 静态残留
  = 622 kB（唯一静态链是 `message.tsx` 的 streamdown plugins 入参）。已修：MermaidBlock
  渲染器改按需加载（补丁 #7，−4 kB，但把结构摆正）。剩下的缩表需要
  bundle-visualizer 级归因 + 动核心消息渲染器的 plugins 延后（会让首遍 markdown 解析拿不到
  mermaid 插件，须配渲染实测）——**独立批次**。

## 12. 退役与 rc.3 执行清单（✅ 已执行）
1. ~~**切换默认落点**~~ ✅ 2026-10-09 已执行：web-next/src/App.tsx 路由翻转——`/` 直挂 ZCodeApp（懒加载），`/z/*`、`/next/z` 保留为书签兼容别名（`*` 通配同一组件）；`/share/:code` 落地页保持在鉴权门外；旧控制台路由（/session/:id、/automations、/settings、/dev/tokens）已移除挂载并**删除源码**（55 个文件：ShellLayout/CommandCenter/NewSessionDialog/ChannelsDialog/pages 五页/全部旧壳 lib，按引用闭包删除；PairGate 是共享鉴权门、ShareLanding 是公开落地页，均保留）；旧面板的 WS boot/全局键盘不再挂载；柿橙配色封存为 styles/persimmon-theme.css（不参与构建）。
2. **重建部署**：`npm run build:all` + `bash ~/bin/restart-ocrc.sh`，验证 `/`、`/z/`、`/share/:code` 三落点。
3. **文档收口**：AGENTS.md 架构指向更新（/ 为 ZCode 壳）；CHECKLIST 第 12 节本清单勾掉。
4. **打 rc.3**：package.json 版本 → rc.3，git tag，tag→CI OIDC 发布（既有通道）。
   ✅ tag `v1.0.0-rc.3` 已在本地（**未 push**——publish 是外向动作，等用户发话）。
5. **N12 收口（2026-10-10）**：CHECKLIST 全量对账（§0 口径 + 陈旧条目改正 + 剩余项逐条注明
   归属）、PRODUCT.md 改判条文、ARCHITECTURE/OPS 补 goal 循环与运维要点、CHANGELOG 记 N12、
   package.json → `1.0.0-rc.4`（tag 同样等用户发话——tag 即触发 CI 发布）。
