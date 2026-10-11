# 移动端前端体验差异审计（逐控件，一次收敛）

> 2026-10-11 · 基线：vendor v3.15.1（aac4755）/ web-next 1.0-rc · 隔离栈 4199 + scratch 引擎 4298
> 方法：CDP 移动视口探针实测（`web-next/scripts/mobile-audit.mjs`）+ 六组只读深审扇出 + 官方移动壳源码解剖 + 用户真机截图（仅作参照证据，图片不入库）
> 关联：桌面侧审计见 [frontend-integration-audit.md](frontend-integration-audit.md)；vendor 验收看 [../web-next/vendor/CHECKLIST.md](../web-next/vendor/CHECKLIST.md)

## 0. 结论速览

1. **官方移动壳族在 ocrc 是死代码**（门控 `webRemoteControlWorkspaceSwitcher` 不传，`ZCodeApp.tsx:99-110`）→ 手机拿到的是 264px 桌面壳被 `max-w-[50%]` 裁成半屏：390px 下侧栏 195px 恒驻、内容列恒 320px（可视仅 191px）、右缘 129px 内容被 `overflow-hidden` 静默裁掉（`docOverflowX=0` 掩盖）。**→ 已落地（W1/W2 批次，2026-10-11）：switcher 仅移动视口传入 + Root 重挂跨工作区切换，手机 /z/ 即官方移动壳**（实施与规格的差异、取舍与回退预案见 §5）。
2. **死路清单**（触屏完全无入口）：会话头部 4 个动作按钮（分享/帮助/切换终端/展开侧边面板，x=392/422/452/482 全部屏外）、消息动作栏（hover-only 且整组 x=478 屏外）、任务行右键族（pin/重命名/删除/轨迹）、查找浮层（唯一入口是快捷键）、权限 dock 与提问 dock（`pendingInteractions` 恒 `[]`）。
3. **长按无兜底**（CDP touchStart 700ms 实测 0 菜单）→ 长按→右键垫片按计划移入立项清单（§6.3）。
4. **非安全上下文（http://LAN）**：`navigator.clipboard` undefined 时复制静默失败/抛错（ocrc `/share/` CardView ×1 无守卫 + vendor ×8 已守卫但无反馈）；`crypto.randomUUID` ×7、`crypto.subtle.digest` ×1 无守卫。→ 本轮已加统一垫片（§6.1）。
5. **设置页不是死路**（六组深审曾误判，探针已修正）：页内有可达的「返回工作区」按钮（40×40）；真实缺陷是标签列被 192px 固定控件列压到 ~50px（中文 2-3 字断行）+ 图标语义全靠 hover 提示。
6. **命令面板是移动端隐藏的万能入口**：实测可开、几何适配、含「切换侧边栏 ⌘B」「切换终端 ⌘J」——这两个动作在手机上的唯一可达路径。
7. 已生效的移动分支（`hover:none` 媒体查询族：任务行动作常驻、16px 输入字号、safe-area、跳过自动聚焦、分屏禁用）真实生效；`<16px` 可编辑控件实测 0。

## 1. 方法与证据等级

| 证据标记 | 含义 |
|---|---|
| **实测** | CDP 探针在隔离栈 4199 上以真实移动视口渲染取得（数值/截图，可复跑） |
| **代码** | 源码路径证据（`文件:行`），未渲染验证 |
| **截图** | 用户提供的官方 ZCode Web Remote Control 真机截图（仅参照，不入库） |

探针最终口径（12 状态 × 2 档全过，console 错误 0、4xx/失败请求 0）：

| 状态 | 390×844 关键读数 |
|---|---|
| home | 越界交互元素 **2**（composer 盒 229+260→489、模型键 324+93→417）；触达<44px **31** |
| session | 越界 **11**；hover-only **10**；触达<44px **43** |
| composer 聚焦 | 壳父容器 `scrollLeft 0→99`（scrollW 519 vs 390）；360 档为 114 |
| 命令面板 | 可开；输入框 322×20；14 结果行 / 4 分组；触达<44px 25 |
| 远控对话框 | 自身越界 0（越界 4 项均为背景页）；开启会话按钮 32px 高 |
| 设置页 | 自身越界 0；触达<44px 41；退出见 §3.1 |
| 长按 700ms | menus/dialogs/menuitems = **0**（无长按兜底） |

两处探针口径修正（六组深审回流后坐实，读数以本档为准）：
- **可见性**：display/visibility/opacity 逐级复合看祖先；pointer-events 只看元素自身（Radix modal 给 body 设 `pointer-events:none`、内容 `auto` 重新命中）。修前远控对话框 80 个按钮被误判成 0。
- **hover-only**：正则必须匹配具名组变体 `group-hover/<name>:opacity-100`，否则会话页假阴性 0（实际 10）。

## 2. 官方移动设计（对照物，一段话）

官方 ZCode Web Remote Control 的手机形态是一套**独立壳族**（`vendor/zcode/ui/src/WebRemoteControlMobileShell.tsx` + `WebRemoteControlMobileTaskHome.tsx` + `WebRemoteControlThemeMenu.tsx`，共 347+988 行）：任务首页为全屏单列（标题+副标题+主题菜单、提示卡、计数行、「整理任务」菜单〔按工作区/按时间线 + 排序 创建/更新〕、全部折叠、刷新、置顶区、今天/昨天时间线分组、工作区卡〔kind 徽标/断开徽标/重连/新建任务〕、运行中/已完成状态徽标）；任务会话页有 h-11 chrome（返回 +「任务会话」+ 主题菜单）、侧页为右侧覆盖抽屉 `w-[min(88vw,28rem)]` + 遮罩 + chat `inert`、独立 chatOverlay（查找浮层）、跨工作区切换全屏遮罩、重连提示条；composer 走 `compactForRemoteControl` 分支（Enter=换行、compact placeholder、移动字号、竖排浮面板、消息动作栏常显、clientKind=mobile、子代理/工作流目录禁用、分享/帮助/终端隐藏）。用户真机截图逐一印证。

## 3. 逐控件全表（六组）

归属四类：`已可用` / `本轮修`（批次 D 已落地或本轮 CSS/垫片可修）/ `需立项` / `明确不做`。

### 3.1 组一：壳骨架

| 控件 | 官方移动设计 | ocrc 手机实际 | 差距 | 归属 |
|---|---|---|---|---|
| 整体壳选择 | 移动壳族全屏单列两页（MobileShell.tsx:221-347；截图=任务首页） | 不传 switcher（ZCodeApp.tsx:99-110）→ `mobileChatSurface=null`（实测），桌面壳被裁半屏 | 官方手机形态整族未启用 | **已落地**（接线，§5；探针实测三档：移动壳 home/chat + 桌面回归标准壳） |
| 标题栏-后退/前进/新建任务 | h-11 顶栏只有返回（MobileShell:243-259） | 后退/前进 28×28 @(0,14)/(32,14)；「新建任务」在 `w-0 opacity-0` 容器内不可见（DesktopTopOverlay.tsx:88,189-205；探针已修正不再误报） | 28px 靶；无首页↔会话两级结构 | 已可用 |
| 侧栏容器与宽度 | 手机无侧栏 | `w-[var(--workspace-sidebar-panel-width)] max-w-[50%]`（WorkspaceShellLayout.tsx:2358）→ 195px/180px 恒占半屏；内部横滚 214 vs 195（19px） | 无收起入口、正文可视 191px、右缘 129px 静默裁切 | 需立项（接线） |
| 侧栏折叠/展开入口 | 无侧栏 | 开关仅桌面平台渲染（DesktopTopOverlay.tsx:135-162）；`WorkspaceSidebarCollapsedRail` 全仓无挂载点；唯一路径=命令面板「切换侧边栏 ⌘B」（实测可开） | 手机零直接入口 | 需立项（接线）；短期用命令面板兜底（已可用） |
| 侧栏拖拽把手 | 无（官方抽屉不可 resize） | 4px 隐形把手、提示线 hover 才显（Layout.tsx:2477-2501）；JS 下限 264px > CSS 上限 195px → 拖动无效果；`touch-action:none` 吞手势 | 触屏不可见且无效 | 本轮修（coarse 下 CSS 隐藏）→ 已落地 §6.1 |
| 侧栏顶部四动作（新建/搜索/自动化/插件市场） | 手机形态无此入口 | 179×32 行 + 32px 高；⌘ 角标无意义 | 32px 靶 | 已可用 |
| 分组↔项目切换 / 收起全部 / 筛选排序 / 归档 | 「整理任务」菜单（TaskHome:437-507；截图） | 56×24 Tab ×2、24×24 图标 ×3（130/162/190,214）；归档键右缘 214 超出面板 195 → 仅剩 5px 可触，但侧栏容器自带 19px 横滚（214 vs 195）恰是它的可达路径 | 24px 靶；归档需先横滚（不直观但可用） | 已可用（19px 内滚保留——它同时是归档的可达路径） |
| 项目/任务分区头 + 把手 | 工作区卡标题（TaskHome:766-791） | h-7 按钮 125×28 + 24×24 把手（`hover:none` 常显） | 24px 靶 | 已可用 |
| 工作区行（名称/更多/查看文件/新建任务） | 整卡点按 + kind 徽标 + 路径 + 更新时间（TaskHome:766-812） | div(role=button) 179×32 + 3×24px 常显动作把名称压到 ~94px（WorkspaceSidebarItem.tsx:819-1120） | 行高 32px（官方 48px） | 已可用 |
| 「查看文件」侧页 | 右覆盖抽屉 88vw + 遮罩 + chat inert（MobileShell:276-303） | 侧栏内文件树替换任务列表（WorkspaceSidebar.tsx:1928-1959）——树被塞进 195px | 无遮罩/无抽屉/无 inert | 需立项（接线） |
| 任务行（标题/时间/归档/置顶） | `min-h-12/14`（48/56px）行 + 状态徽标 + 未读点（TaskHome:567-636；截图） | 34px 行高（TaskListItem.tsx:655-690）；归档 24px 常显；置顶 `size-4` 仅 hover 行挂载 → 触屏无法置顶未置顶任务 | 行高/触达/置顶死路 | 已可用（置顶死路记入 §4 C2） |
| 显示更多 | 一次性列表 | 纯 span ≈20px 命中区（TaskList.tsx:471-484） | 非按钮语义 | 本轮修 → 已落地 §6.1（44px 命中区，不改字号文案） |
| 侧栏页脚（账户/远控/设置） | 无页脚（主题菜单在顶栏） | 89×32 + 32×32 ×2 @(16/113/151,796)（WorkspaceSidebarFooter.tsx:229-491） | 32px 靶 | 已可用 |
| 会话头部-工作区按钮/标题 | 官方头部精简为返回+标题 | 28×28；标题 `@max-[420px] max-w-[22vw]` → ~86px（WorkspaceHeaderSections.tsx:480-501） | 28px；标题过窄 | 需立项（随接线 simplifyForNarrowRemote） |
| 会话头部-更多菜单 | 官方隐藏桌面专属项 | 28×28 @(338,11) 唯一屏内动作；菜单含文件管理器/provider 配置等桌面项（TaskActionMenuContent.tsx:145-215，`simplifyForNarrowRemote=false` 未隐藏） | 桌面菜单项泄漏到手机 | 需立项（vendor 一行，遵 D4 随接线） |
| 会话头部-分享/帮助/切换终端/展开侧边面板 | 分享与帮助/终端在手机隐藏（WorkspaceHeaderActionSection.tsx:53-74） | **全部屏外**：28×28 @x=392/422/452/482（视口 390） | 4 个入口 100% 不可达；侧页面板/终端/分享链整体死路 | 需立项（接线后隐藏或全宽可见） |
| 状态面板 capsule（展开状态） | 手机浮层纵向翻转（ConversationStatusPanel.tsx:1953） | 284×32 @x=217 → 右缘 501（111px 出屏）；触碰展开可用 | 摘要被切；浮层方向分支未激活 | 需立项（布局随接线） |
| 分屏入口/面板 resize | 官方手机无分屏、无 resize | `enabled=false`（Layout.tsx:2401-2405）行为一致；终端面板 4px 把手入口屏外 | 无差距/不可达 | 已可用 |
| 根容器安全区 | 同吃浏览器 safe-area | `zcode-mobile.css:9-21` 四边 env(inset) + coarse 16px；代码在位（模拟器无 inset，数值未验） | — | 已可用 |
| 壳整体横移（composer 聚焦） | 官方 chat 面全宽无此现象 | **实测滚动源=壳父容器** `relative flex h-full min-h-0 w-full overflow-hidden`（scrollW 519 vs 390）→ scrollLeft 99/114；聚焦时侧栏页脚被推出左边界 | 浏览器 scroll-into-view 副作用 | 需立项（布局随接线） |

### 3.2 组二：composer 输入区

| 控件 | 官方移动设计 | ocrc 手机实际 | 差距 | 归属 |
|---|---|---|---|---|
| 移动 composer 分支总开关 | `compactForRemoteControl/isWebRemoteControl` 全套（ConversationComposer.tsx:662-680） | `isWebRemoteControl=false` 贯穿（不传 switcher） | 桌面语义 | 需立项（接线） |
| 输入区本体 | 16px token + 两行截断占位（mobileTextInput.ts:100-110） | 内容盒 229+260→489（360：474）；批次 D 后封顶回屏内（§6.1）；16px 由 ocrc CSS 兜住（实测 0 违例） | 占位层 div 是 14px、正文 16px（观感差，无缩放风险） | 明确不做（低优观感）；盒尺寸本轮修 → 已落地 §6.1 |
| Enter 语义 | 手机 Enter=换行、按钮发送（preferEnterNewline） | `enterSubmits=true` → 裸 Enter 即发送；而发送键默认屏外 → 误触即发。语义由 `isWebRemoteControl` 门控决定（ConversationComposer.tsx:668-672），ocrc 侧无法触达 | 语义与官方相反 | 需立项（随接线 D15；批次 D 实测后确认不可 CSS 化，见 §6.1） |
| 自动聚焦 | 手机 skip（composerAutoFocus.ts:24-32） | 同 vendor 生效 | 无 | 已可用 |
| 提交后回焦 | 无手机门（LexicalChatInput.tsx:1429-1436） | 同 vendor：发送后键盘被立刻拉回 | 与「跳过自动聚焦」自相矛盾 | 需立项（vendor JS，随接线；批次 D 确认 ocrc 无干净挂点） |
| 添加上下文按钮 + 浮层 | Popover 锚=composer 宽度（ChatPromptActionMenu.tsx:259-306） | 28×28；面板宿主右缘 489 | 28px；浮层一半屏外 | 本轮修（面板宽按可视宽）；触达随接线 |
| @ 提及 / slash 菜单 | MentionPanel max-h-56 虚拟列表 | 数据链可用（fileService/commandsService）；面板同越界锚点 | 越界；32px 行 | 本轮修（面板宽度）；数据已可用 |
| 切换模式按钮 | 菜单 w-64 side=top；coarse 跳过回焦 | 28×28；回显/写回已接线（policy GET/POST） | 28px；图标语义不可发现 | 已可用（数据）；触达随接线 |
| 模型选择按钮 | 手机收窄二级菜单+隐藏「管理模型」（modelSelection.ts:5-11） | 欢迎页 93px @x=324→417；会话态 28px @x=397 屏外；「管理模型」始终在（上游漏传参） | 屏外；管理入口把手机带进设置深链 | 需立项 |
| 上下文 pill | icon-md 28 + 触摸 pointerdown 兜底 | 数据已接线（/context）；28×28 @x=365→393 屏外 3px | 数据可用、入口屏外 | 本轮修（随 hover/布局）→ 布局部分立项 |
| 发送/停止按钮 | 同槽位 icon-md；canStop 换停止 | 发送 x=461→489 完全屏外（空草稿 disabled:pointer-events-none）；停止链路已接线（POST /api/abort） | 默认不可见不可点 | 本轮修（横滚抑制后可达）；终值随接线 |
| 附件选择 | 隐藏 file input 兜底 | `canSelectFilePath:false` → 走系统选择器（手机可取相册）；input 无 `accept` → 可选任意类型，非图片选了才报错 | 提前过滤缺失 | 需立项（`accept="image/*"` 属 vendor 一行，遵 D4） |
| 非图片附件发送 | 桌面可发任意附件 | sendText 只收图片，其余 `ocrc_attachment_unsupported`（zcodeAgentService.ts:1620-1633） | chip 正常出现、发送必败 | 需立项 |
| 附件 chip 删除 | `size-3.5` + hover:none 常显（ConversationComposer.tsx:2049-2068） | 同 vendor：14×14 贴着 chip 本体 | 触达过小、易误触 | 需立项（随接线统一触达） |
| ContextAttachmentPill 删除 | `size-5` 仅 group-hover 显形（ContextAttachmentPill.tsx:57-70），**无 hover:none 兜底**（同文件族已知模式漏改） | 同 vendor：批次 D 前 touch 看不到删除入口 | 官方自身缺口在 ocrc 同样暴露 | 本轮修 → 已落地 §6.1（ocrc CSS 兜底） |
| 权限 dock | 键盘提示 Tab/上下键（官方自身缺口；截图印证） | `pendingInteractions` 恒 `[]`（zcodeAgentService.ts:788）→ 永不挂载 | 授权交互在 /z/ 不存在 | 需立项 |
| 提问 dock | ElicitationDialog 可折叠 | 同上不可达 | 引擎提问无法在壳内回答 | 需立项 |
| 快捷键提示 | 手机隐去 Enter 提示（mobileTextInput.ts:82-88） | 发送 tooltip 仍带 Enter、停止带 Esc | 触屏无这些键 | 本轮修（coarse 下隐藏）→ 已落地 §6.1 |
| 图片粘贴 | PasteCapture → 附件 | 可用（SHA-256 纯 JS 回退已在位） | 无 | 已可用 |
| 长文本粘贴 | 转临时文本附件 | `createTempTextAttachment` reject（platform.ts:51-52）→ 必败且只报一行错 | 语义不一致 | 需立项 |
| 拖拽投放 | drop → 附件/mention | 触屏无拖拽；「+/附件」等价 | — | 明确不做 |
| 语音/拍照 | 无（PRODUCT 列不做） | 无；input 无 capture | — | 明确不做（语音）/需立项（拍照直采） |
| 工具栏窄屏收纳 | JS 度量 + 容器查询 4 档（useComposerToolbarFit.ts:27-46） | 260px 盒内图标化生效（实测截图）；但盒右缘 489 → 收不回屏外 99px | 按容器宽而非可视宽裁决 | 本轮修（横滚抑制）；终值随接线 |

### 3.3 组三：时间线 / 会话内容

| 控件 | 官方移动设计 | ocrc 手机实际 | 差距 | 归属 |
|---|---|---|---|---|
| 用户/助手消息行 | chat 区=视口全宽 min-w-0（MobileShell:261-274） | 内容列恒 320px（SessionPane.tsx:5475 + Layout.tsx:2508 `min-w-[320px]`）→ 右缘 519、右 129px 被裁；行右对齐贴 503 | 硬裁非省略号；`overflow-x-hidden`（ConversationTimeline.tsx:1905）无法平移补齐 | 本轮修（ocrc CSS 复刻 max-md 堆叠）；终值随接线 |
| 思考过程块 | 无最小高度；chevron hover 显（reasoning.tsx:365-425） | 360 实测行 201+166→367；行高 ≈20px；chevron 触屏不可见 | 无展开 affordance；20px 靶 | 本轮修（hover:none 常显 chevron）→ 已落地 §6.1 |
| 工具调用块（命令/探索/读取） | 摘要行 role=button；窄于 360 收类别词 | 容器 320px → `@max-[360px]/conversation` 恒命中（桌面壳吃到移动分支）；truncate 在 288px 处视口边硬切 | 断点被 pane 宽触发；右 113px 不可见 | 本轮修（布局）；随接线终修 |
| 内联 diff / 代码块 | `overflow-auto` + sticky 行号（lightweight-diff-preview.tsx:125,161） | 盒 288px、可视窗 175px → **每行尾部 113px 永远不可达**（scrollLeft 上限不够） | 需二次横滑且尾部不可达 | 本轮修（布局） |
| 计划卡片 + 「查看完整计划」 | 同一卡片；CTA 锚卡中心（switch-mode.tsx:129-141） | 卡 216+286→502；CTA 285+148→433（尾部箭头被切）；复制计划 461 | 主 CTA 部分不可见 | 本轮修（布局） |
| 计划详情/子代理/工作流侧页 | 右覆盖抽屉 + 遮罩 + inert（MobileShell:276-303） | 桌面右分栏：侧页仅得 ~154px 且落在屏外带（屏内约 25px）；`sidePaneOverlayPresent=false`（实测） | 详情面打开后基本不可见 | 需立项（抽屉=移动壳语义） |
| 状态面板胶囊/面板本体 | 纵向翻转 + `calc(100cqw-2rem)`（ConversationStatusPanel.tsx:2044-2070） | 胶囊 111px 出屏；面板菜单按钮 `right-3` 落屏外 → 折叠/显示模式入口不可达 | 控制簇越界 | 需立项（随接线） |
| 消息动作栏（用户/助手行） | 手机**常显**：`compactForRemoteControl ? "opacity-100" : …`（ConversationRowView.tsx:1426-1451,1752-1768） | `opacity-0` 分支 + 整组 x=478 屏外（实测 hover-only=10） | 双重死路（不可见+不可达）；iOS 点按钮不给 focus，focus-within 也不触发 | 本轮修（ocrc CSS hover:none 常显）→ 已落地 §6.1；可达性随接线 |
| 消息级重试 | 不在消息行（在错误横幅） | 同（v4 行无重试按钮） | 无差距 | 已可用 |
| 消息级删除 | 不在消息行（在任务行右键菜单） | 手机无右键入口（实测长按/右键均无菜单） | 删除触屏无入口 | 需立项（随右键族） |
| 代码块复制按钮 | icon-md 28 | 位于码块头右端 → 屏外带；http 下 clipboard undefined 早退无反馈 | 不可达+静默失败 | 本轮修（垫片+可见性）→ 已落地 §6.1 |
| 文件变更摘要块 | h-10 头 + 满宽折叠 toggle（MessageChangeSummaryPanel.tsx:110-163） | 还原/打开按钮 h-7 落屏外带 | 主要操作越界 | 本轮修（布局） |
| 子代理输出块 | `overflow-auto max-h-64` | 288px 盒右 113px 屏外；目录入口在状态面板（越界） | 尾部不可达+入口越界 | 本轮修（布局） |
| 工作流（dwf）块 | ToolLayout 整行可点 | 行屏内可点；点开 → 侧页（屏内 25px）；类别词被误收 | 行可点但目标面不可见 | 本轮修（行）+立项（侧页） |
| 待办块 | ToolLayout 摘要行 | 行高 ≈20px；截断点不可见 | 20px 靶 | 本轮修（随通用行高） |
| 图片缩略/预览 | <640px 单列满宽；预览=全屏 Dialog 触摸缩放 | 满内容列 288px → 右 113px 被裁；预览走 portal 不受裁切（已可用） | 图被裁 | 本轮修（布局） |
| 附件/上下文 chips（用户行） | flex-wrap 右对齐 + HoverCard | 右对齐 → 屏外带（截图实况：用户消息只露左半） | 右半不可见 | 本轮修（布局） |
| 滚动到底部按钮 | icon 28 锚 pane 中心 | 345..373 屏内可点 | 28px；视觉偏右 | 已可用 |
| 回合导航 rail | `@min-[864px]` 才显示（ConversationTurnNavigator.tsx:159） | 320px 容器恒隐藏 | 与官方手机一致 | 已可用 |
| 顶部任务导航（上一/下一回合） | 官方窄屏远控刻意不渲染（Layout.tsx:602-603,2926） | 照常渲染（28×28 @y=14） | 与官方选择相反；占顶栏空间 | 已可用（对齐官方=随接线裁决） |
| 流式加载指示 | ChatLoading 轮尾槽 | 屏内正常 | 无交互差距 | 已可用 |
| 错误横幅（ChatErrorBanner） | w-full flex-wrap | 在 320px 列内换行后右端「重试/✕」落屏外带 | 关键动作可能不可见 | 本轮修（布局） |
| 工具失败态 tooltip | 失败原因只在 Tooltip（ToolLayout.tsx:241-294）；tooltip 内复制无守卫 | 触发是 span 不可聚焦 → 触屏拿不到失败原因 | 不可达+无守卫 | 本轮修（垫片覆盖复制）；触屏化立项 |
| 草稿空态问候 | compact 固定最小字号（ConversationDraftEmptyState.tsx:64-95） | 走容器宽自适应，量的是 288px 容器而非可视 175px | 字号口径错 | 本轮修（随布局） |
| 加载骨架 | 无（仅 ChatLoading） | ocrc Suspense 是纯文本「ZCode fork loading…」（ZCodeApp.tsx:98） | 观感 | 明确不做（低优） |
| markdown 表格 | 工具栏右对齐 icon-md；表体横滑 | 复制/下载/预览全屏外；尾部 113px 不可达；自定义滚动条触屏不可用 | 动作全不可达 | 本轮修（布局） |
| 分隔线 marker | 居中 pill | 屏内 | 一致 | 已可用 |
| `/share/` 页卡片 | 无官方对应物（ocrc 自有） | 布局移动友好；但动作栏 `opacity-0 … group-hover/assistant-row:opacity-100`（CardView.tsx:84）触屏不可见；复制无守卫（:76-79）；工具行 openPaneTab 无 pane 宿主 = 空点击死路（Blocks.tsx:44-61）；展开钮 ≈11px | 不可见+抛错+死路 | 本轮修 → 已落地 §6.1 |
| `/z/` 是否用 ocrc CardView | — | **否**：CardView 仅被 ShareLanding 引用（grep 证实）；/z/ 时间线全走 vendor 渲染 | 澄清（影响修复合的受益面=/share/） | 已可用 |

### 3.4 组四：对话框与浮层

| 控件 | 官方移动设计 | ocrc 手机实际 | 差距 | 归属 |
|---|---|---|---|---|
| 命令面板 | 移动壳族无 | **实测可开**：输入 322×20（360：292×20）、14 行/4 分组、行 min-h-8=32px；浮层 `top-16 max-w-lg`→358px 自适配；**含「切换侧边栏 ⌘B」「切换终端 ⌘J」——手机唯一可达入口** | 输入框 20px 高、行 32px、⌘ 角标无意义；无 X 关闭（Esc/遮罩） | 已可用 |
| 设置页-壳 | 移动壳无设置页 | h-screen `grid-cols-[68px_minmax(0,1fr)]`（SettingsPage.tsx:1429）；非 dialog、无遮罩 | 全屏桌面页塞进 390px | 已可用（形态）|
| 设置页-退出 | 「返回任务首页」显式返回 | **实测：点「返回工作区」✓（40×40 @12,64 可达）；Escape ✗；再点「设置」✗；浏览器返回 ✓（但退出应用首条历史）** | 有页内出口；Esc 不工作 | 已可用 |
| 设置页-图标栏 | 无 | 16 节 40×40、文案 sr-only；语义全靠 hover 提示（触屏不可达） | 40px；可发现性缺失 | 需立项（随 §4 C5） |
| 设置页-内容行布局 | 无 | `grid-cols-[minmax(0,1fr)_192px]` 不随窄屏降级（SettingsPageParts.tsx:127-131）→ 标签列 ~50px，中文 2-3 字断行（截图实况「界面语 言」） | 可读性破坏 | 需立项（vendor 一行或接线后布局重排） |
| 设置页-开关/输入/下拉/保存 | 无 | 开关命中区 ≈56×34（vendor 内建补偿）；保存 50×32 在长滚动页 | 32-34px 靶 | 已可用（部分）|
| 设置页-帮助「?」 | 无 | 28×28 @351,11 + 桌面文案菜单 | 28px | 已可用 |
| 主题菜单 | 三选项菜单（ThemeMenu:15-19；截图） | 入口=侧栏页脚头像子菜单 + 命令面板「切换主题到浅色」；持久化 key 同 `zcode-theme`（ZCodeApp.tsx:21-29 与 vendor store 双写，接线时需收敛） | 无独立按钮；二级子菜单触屏未实测 | 已可用 |
| 查找浮层 | 官方同款独立 overlay（TaskFindDialog placement=chat） | **入口缺失**：唯一触发=快捷键 findInTask（App.tsx:626-633）→ 手机无键盘无入口；本体几何适配（`w-[min(360px,…)]`） | 容器好、入口死路 | 需立项（入口） |
| 查找浮层-上/下/关 | — | 3×20×20 icon-xs（TaskFindDialog.tsx:251-322） | 20px 靶 | 需立项（随触达横切） |
| 分享链（面板/dock/确认） | 手机不做 | 入口屏外（§3.1）；面板 `max-md:w-[min(14.375rem,…)]` 自适配；确认 dock `min(28rem,…)` 挤在 195px 列 | 入口死路 | 需立项 |
| 帮助菜单（头部） | 手机隐藏 | 28×28 @x=422 屏外 | 等效不可达但占布局 | 需立项（随接线隐藏） |
| 右键菜单-任务行 | 官方用显式菜单（整理任务） | `onContextMenu` 存在（TaskListItem.tsx:331）→ **触屏无 contextmenu 事件、无长按兜底（实测 0 菜单）** | pin/重命名/未读/轨迹全无入口 | 需立项（含长按垫片候选） |
| 右键菜单-侧页签 | 官方右抽屉 | 页签 28px；非活动页签关闭键 hover-only（SidePaneTabTrigger.tsx:162-171，无 hover:none 逃生口） | 关不掉 | 需立项 |
| 远控对话框 | 官方无（ocrc N5 增量） | 实测可开可关：`max-h[calc(100vh-6rem)]` 内滚；X 24px；扫码卡占位 192px；开启会话 32px 满宽；复制链接有 try/catch 但失败静默；Bot Channel 4 卡单列堆叠（截图印证） | 24px X、32px 主 CTA、复制静默失败 | 本轮修（垫片给复制失败提示）→ 已落地 §6.1；触达随接线 |
| BotsDialog | 无 | `h[calc(100vh-6rem)] max-w-4xl`；左侧列表 max-h-40 内滚；X 24px | 24px X；双内滚「三明治」 | 已可用 |
| 确认框（删除/归档） | 无 | `max-w[calc(100%-2rem)]`、footer 竖排全宽、按钮 h-9=36px | 无实质差距 | 已可用 |
| 任务重命名对话框 | 无 | 本体几何可用；**入口只在右键菜单** → 触屏不可达 | 入口死路 | 需立项（随右键族） |
| Toast 栈 | 官方重连条=顶部居中 | top-center `fixed top-16`（未计 top safe-area）；bottom 档已带 env(inset)（toast.tsx:48-68） | 刘海机型顶部贴边 | 本轮修（top 档补 safe-area）→ 已落地 §6.1 |
| 重连/离线（P5） | 官方=顶部轻条 | degraded→composer 上方 ChatErrorBanner + apiRetry N/M（时间线尾行，滚动到底才可见）；down→SessionSubscriptionErrorPanel 整页面板（按钮 28px） | 形态更重但可恢复；N/M 分母=9 | 已可用 |
| 错误边界 | 无移动专门设计 | `max-w-xl p-6` 自顶滚动 + 重试/刷新 28px；边界只包 /z/（PairGate/ShareLanding 无边界） | 兜底覆盖不全 | 本轮修（边界覆盖）→ 需立项（PairGate 侧） |
| ControlHintTooltip | 官方手机隐藏来源控件 | 全族依赖 hover（设置图标栏/工具条/页脚/任务行） | 可发现性横切缺口 | 需立项（§4 C5） |

### 3.5 组五：ocrc 自有域

| 控件 | 官方移动设计 | ocrc 手机实际 | 差距 | 归属 |
|---|---|---|---|---|
| PairGate | 无官方对应物（PRODUCT 第零点八条） | `fixed inset-0` 卡片 `w-[min(92vw,400px)]`（PairGate.tsx:22）；**无 safe-area**（壳外渲染，App.tsx:36-38）；输入 16px 但无 autoFocus/inputMode；提交钮 ≈32px | 刘海贴边；无软键盘提交键 | 本轮修（safe-area/提交钮）→ §6.2 |
| `#token=` / `#pair=` | 无 | 模块初始化即采纳/换取（auth.ts:52-84）；iOS 主屏 localStorage 不共享问题已处理（auth-token.ts 保留 fragment） | 未实测 | 已可用 |
| 401→PairGate | 无 | client.ts:43/57/71 + 状态机 | 未实测 | 已可用 |
| 隐私模式 localStorage | 无 | setToken 静默失败但状态推到 ready → 下次 401 → 一次性 reload → 回 PairGate：**配对永远完不成** | 死循环风险 | 需立项（提示与降级） |
| 启动态 | 无 | `ocrc-pulse-dot` 单点全屏（App.tsx:29-34），无文案无 safe-area | 观感 | 本轮修（文案）→ §6.2 |
| `/share/:code` 页头/布局 | 无 | sticky 页头无 safe-area；`max-w-3xl p-5` 单列自适应 | 页头顶入状态栏（cover 已开无补偿） | 本轮修（safe-area）→ §6.2 |
| 分享页卡片控件 | 无 | 见 §3.3 末两行（动作栏/复制/工具行/展开钮） | 同 | 本轮修 → 已落地 §6.1 |
| 分享页图片 | 无 | ContentBlock 仅 text/tool/reasoning（structured-card.ts:34-37）→ 图片不渲染 | 模型层缺 image block | 需立项 |
| 自动化/offpeak 入口 | 无 | 侧栏入口可达；主视图渲染在 191px chat pane（实测截图拥挤） | 窄布局 | 需立项（随接线） |
| 插件市场 | 无 | 入口可达但只读（PRODUCT 不做安装） | — | 明确不做 |
| RemotesSection（设置内） | 无 | `sm:grid-cols-2` 单列降级、toast 反馈；正文被 rail+侧栏双重挤压 | 窄 | 需立项（随设置布局） |
| P5 三态呈现 | 无官方对应物 | hostConnection.ts:9-23 状态机 + REST 佐证；展示层未在手机实测（单测在位） | 未实测（仅代码走查） | 已可用 |
| 离线只读 | 无 | 无 SW → 离线不可用；/share/ 免鉴权但同样无缓存 | — | 明确不做（本轮，OPS 有 HTTPS 路径） |
| apple-touch-icon | 宿主面 | index.html:16 引用，`public/` 无此文件 → **404** | 添加到主屏无图标 | 本轮修 → 已落地 §6.1 |
| PWA/standalone | 无 | 无 manifest/SW；apple-mobile-web-app meta 在位 → standalone 无浏览器返回键（设置页有页内返回兜底，见 §3.4） | 无安装语义 | 明确不做（本轮） |
| Suspense 加载态 | vendor 有 SVG 启动画面 | 纯文本「ZCode fork loading…」 | 观感断层 | 本轮修（文案与主题对齐）→ §6.2 |

### 3.6 组六：官方移动壳族（参照组 —— 全部「未激活/死代码」，门控证据同一）

门控链：`isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher)`（WorkspaceShellLayout.tsx:456）+ 移动壳渲染门 `:2061-2065`（还需 `isWebRemoteControlMobileViewport` = `max-width:767px`，:121）。ocrc 不传 prop → `isWebRemoteControlShell=false` 贯穿；CDP 实测 `mobileChatSurface=null`、`sidePaneOverlayPresent=false` 双证。

| # | 控件/分支 | 官方行为（证据） | ocrc 手机实际 | 归属 |
|---|---|---|---|---|
| A1-A5 | 首页标题/副标题/主题入口/提示卡/计数行 | TaskHome:383-421（截图印证） | 未激活【门控】 | 需立项（接线） |
| A6-A11 | 整理任务菜单（按工作区/时间线、排序 创建/更新）/收起全部/刷新 | TaskHome:424-520（截图） | 未激活【门控】 | 需立项（接线） |
| A12-A14 | 首次加载态/错误条/空态 | TaskHome:131-243,524-541 | 未激活【门控】 | 需立项（接线） |
| A15-A18 | 置顶区/未读点/任务行点击（markTaskRead+updateMobileViewState+跳 chat） | TaskHome:543-637 + useWebRemoteControlTaskOpen.ts:54-131 | 未激活【门控】；ocrc 已有 unread 数据（session-summary.ts:35）但列表不消费 | 需立项（接线；数据在位） |
| A19-A27 | 工作区卡（kind 徽标/路径/更新时间/计数/断开徽标/重连/新建任务） | TaskHome:766-897 | 未激活【门控】；重连键仅 kind=remote 渲染，ocrc 全 local 自然隐藏 | 需立项（接线） |
| A28-A35 | 时间线分组/行/状态徽标/工作流行/归档过滤/刷新时机 | TaskHome:663-978 + lib:131-206 | 未激活【门控】；displayStatus 只有 error→error，running/completed 无数据源（见 §5 缺口） | 需立项（接线） |
| A36-A37 | 跨工作区切换遮罩/首页偏好持久化 | Shell:318-329；lib:43-110（key `zcode-web-remote-control-mobile-task-home-preferences`） | 未激活【门控】 | 需立项（接线） |
| B1-B2 | h-11 chrome（返回+「任务会话」+主题菜单）/renderChatHeader（simplifyForNarrowRemote=true） | Shell:243-260 + Layout.tsx:2091-2159 | 未激活【门控】；实测桌面 header 4 动作全越屏 | 需立项（接线） |
| B3-B5 | chat 面 inert/侧页右抽屉/chatOverlay 独立层 | Shell:262-313 | 未激活【门控】（实测 overlay 不存在） | 需立项（接线） |
| B6 | 终端传输重连提示条 | Shell:330-344 | 双缺：门控 + 状态源（setter 在 vendor 树内无调用点，属 relay 打包边界） | 明确不做（该条按「恒不出现」处理） |
| B7-B10 | 移动历史集成（pushState/popstate/刷新恢复/homeRefreshKey）/updateMobileViewState 上报/页面状态机 | Shell:29-68,111-215 | 未激活【门控】 | 需立项（接线） |
| C1-C2 | 主题菜单三选项/回显 | ThemeMenu:15-47（截图） | 未激活【门控】 | 需立项（接线） |
| C3-C4 | 主题持久化（key `zcode-theme`）/首页偏好持久化 | store/index.ts:258-265；lib:78-110 | 主题 key ocrc 已用（双写需收敛）；偏好未激活 | 已可用（收敛随接线） |
| D1-D3 | switcher 总开关/渲染门/视口判定 | Layout.tsx:456,2061-2065,121 | 恒 false → 整族缺席 | 需立项（接线 = §5） |
| D4-D6 | 顶部导航面板上下堆叠/自动折叠/切换 loading overlay | Layout.tsx:2349-2667,1112-1126,2930-2943 | 未激活【门控】 | 需立项（接线） |
| D7-D9 | 头部精简/动作隐藏/任务菜单隐藏桌面项 | Layout.tsx:602-603 + WorkspaceHeaderActionSection.tsx:53-74 + TaskActionMenuContent.tsx:145-218 | 未激活；实测 4 动作越屏、桌面菜单项泄漏 | 需立项（接线） |
| D10-D13 | 分屏禁用/pane 持久化禁用/侧栏把手 max-md:hidden/侧页 mobileOverlay | Layout.tsx:2400-2408,526-533,2499,2028-2318 | 未激活【门控】 | 需立项（接线） |
| D14 | compactForRemoteControl（单 pane/禁 drop/禁 group） | Layout.tsx:2267 → V4WorkspaceChatArea.tsx:208-586 | 未激活【门控】 | 需立项（接线） |
| D15 | Enter=换行 | ConversationComposer.tsx:665-671 | 未激活（实测语义相反） | 本轮修（ocrc 垫片）→ 已落地 §6.1；接线后去重 |
| D16 | iOS 16px（composer+权限输入） | ConversationComposer.tsx:674-677 + PermissionDialog.tsx:482-486 | **已可用（ocrc CSS 覆盖等效达成，实测 0 违例）**；接线后二者并存去重 | 已可用 |
| D17-D28 | compact placeholder/动作栏常显/状态面板纵向/模型菜单收敛/隐藏管理模型/隐藏 CUA/目录入口禁用/分享链禁用/Plan 回执对账/clientKind=mobile/草稿紧凑/划词与 /side /btw 禁用 | ConversationComposer.tsx:678-680、ConversationRowView.tsx:1425-1770、ConversationStatusPanel.tsx:1953、V4ComposerToolbar.tsx:1044-1048、modelSelection.ts:6-10、useCuaComposerEntry.ts:60-64、SessionPane.tsx:5558-5698,1077-1111,1771-1791、ConversationDraftEmptyState.tsx:63-135 | 除 D28（划词/命令族只看视口媒体查询，**ocrc 手机已生效**）与 D16 外全部未激活 | 需立项（接线）；D28 已可用（勿重复实现） |
| D29 | 权限 dock 键盘提示 | PermissionDialog.tsx:1009-1013 | dock 本身不挂载（pendingInteractions 恒空） | 需立项（随 dock）；文案为官方自身缺口 |
| D30 | 宽屏远控侧栏变体（isWebRemoteControlSidebar） | WorkspaceSidebar.tsx:616-1214 | 未激活；ocrc 手机渲染的是它的桌面形态 | 需立项（并入接线一并裁决） |
| D31 | 根级远控判定/provider 登录守卫 | Root.tsx:606-611,1187,1296-1314 | 未激活 | 需立项（接线） |

## 4. 跨组横切项（六个组的「无归属项」归位）

| # | 横切项 | 证据 | 裁决 |
|---|---|---|---|
| C1 | 触达 <44px 全站批量（home 31 / session 43 / settings 41 / 面板 25 / 远控 9；icon-sm=24、icon-md=28、行高 32 是 vendor 设计语言） | 实测统计 | **明确不做单点批改**（会破坏密排布局）；随移动壳接线后按官方移动规格（行 48px）统一重估 → 并入接线立项 |
| C2 | hover-only 触屏死路族（消息动作栏×10、ContextAttachmentPill 删除、侧页签关闭、置顶、reasoning chevron、markdown 表滚动条、tooltip 全族） | 源码 + 实测 hover-only=10 | 消息动作栏/Pill/chevron = 本轮修（ocrc CSS 兜底，已落地）；侧页签/tooltip/表滚动条随接线立项 |
| C3 | 容器查询断点被 320px 内容列钉死（`@max-[360px]/conversation` 恒命中、`@min-[864px]` 永不命中） | 源码 + 实测 | 布局根因之一，随接线消除；单独修补不做 |
| C4 | 非安全上下文（http://LAN）缺口：clipboard 守卫（ocrc /share/ ×1 无守卫 + vendor ×8 有守卫无反馈）、randomUUID ×7、subtle.digest ×1、Notification 永不申请、getUserMedia 静默 | 源码盘点 | 本轮修 = 统一垫片（clipboard/randomUUID/digest + 失败 toast），已落地 §6.1；Notification/getUserMedia 明确不做（PRODUCT 无对应功能） |
| C5 | hover 提示（ControlHintTooltip）触屏不可达 → 图标语义不可发现 | 源码 | 需立项（随接线按官方规格隐藏来源控件或改 tap 提示） |
| C6 | 设置页标签列 192px 固定控件列（~50px 标签断行） | 截图 + SettingsPageParts.tsx:127-131 | 需立项（vendor 一行或接线后布局重排；遵 D4 不在本轮动 vendor） |
| C7 | 探针方法学（已修，记录防复发）：pointer-events 祖先误判、hover-only 具名组漏配、「返回工作区」aria-label 漏测 | §1 | 已修入探针（201ba636、3ad5fcf1） |

## 5. 接线规格（**已落地** —— W1 数据面 + W2 激活，零 vendor 改动）

**落地状态（2026-10-11，commit 3078d6e2 + 240cec42）**：`web-next/src/zcode/remoteControl/workspaceSwitcher.ts`（switcher 实现）+ `ZCodeApp.tsx`（`matchMedia('(max-width: 767px)'` 与 vendor 同查询串；**switcher prop 仅移动视口传入**——vendor 的 isWebRemoteControlShell/Root/Sidebar 族全以「prop 是否存在」为开关，无条件传会翻转桌面九项行为）。下表为规格→实施的逐条核对：

| 方法（root/types.ts:25-42） | 规格 | 实施 |
|---|---|---|
| `listWorkspaces()` | 合成 WorkspaceListResult | **按规格落地** + 真数据：后端 SessionSummary 新增 `createdAt`（opencode `s.time.created`）与 `busy`（session-summary 聚合层 overlay，与 error/unread 同模式）→ 排序/「运行中」徽标不再近似。**不设 activeWorkspaceKey/activeTaskId**（vendor 实时 props 更准）。displayStatus=error/running/idle 三态（无 completed 闩锁，ocrc 不追 finished 事件） |
| `onWorkspaceListUpdated?` | 建议不实现 | 未实现（无推送；返回首页 refreshKey + 刷新按钮覆盖） |
| `switchWorkspace(key, opts)` | **最大缺口**：A) 宿主重设 Root 能力 或 B) 降级单工作区 | **A 案落地，零 vendor 改动**：Root 重挂（`<Root key={nonce}>` + initialWorkspaceAbsPath/initialTaskId/intent）——vendor 的活动工作区权威 state 是 Root 内部闭包，而重挂重新走引导（didBootstrapInitialWorkspaceRef 实例级），与 `?session=` 深链同一通路。同 key 纯切换短路；带 taskId 一律重挂（游标偏差安全侧）并顺手清未读；intent 缺省兜底 'chat' |
| `markTaskRead?(task)` | 现成端点 | `POST /api/sessions/:id/unread {unread:false}` |
| `updateMobileViewState?` | 建议 no-op | no-op resolve |
| `reconnectWorkspace?` | 不实现 | 未实现（全 local，按钮不渲染） |
| `startDraft?(key, opts)` | 现成端点 | `POST /api/session {directory}` → 拿 id 发重挂信号（intent 默认 'chat'） |

**接线时揭露并修复的 ocrc 幽灵服务违约**：`onDynamicConversationFrame` 订阅返回裸函数，违反 vendor `Event<T> = (listener) => IDisposable`（rpc/foundation.ts:71）——移动壳「聊天页 → 返回首页」卸载 chat 触发退订即抛 `g?.dispose is not a function`，错误边界把整个内容区换掉（vendor mermaid chunk 的 dispose 路径首个踩中）。已改双形状句柄（可调用 + .dispose，ocrc 侧一行修，PATCHES 不新增）。官方自身缺口（无 swipe/无下拉刷新/无长按菜单等）照 §5 原样继承。

**回退预案（如真机不稳）**：`listWorkspaces` 降级单工作区语义（一行改动），切换路径即消失。

**已知取舍（官方配套语义 + 本轮裁决）**：手机移动壳 = 官方远控配套——设置页/自动化/插件市场/命令面板**无 UI 入口**（探针实测四项均 no-entry，如 ok:false 所记；键盘快捷键手机不可达）。若用后需要，可后续在 TaskHome 登记一条 PATCHES 加入口（本轮不做，避免首个接线批混入 vendor 改动）。

## 6. 归属汇总

### 6.1 本轮修（批次 D 已落地，独立提交）

| 项 | 覆盖的审计行 | 证据 |
|---|---|---|
| insecure-context 垫片（`web-next/src/lib/insecure-context.ts`，bootstrap 最先接线；缺 `clipboard.writeText` 补 execCommand 回退、缺 `randomUUID` 补 v4、缺 `subtle` 补 SHA-256 回退〔复用 vendor sha256Pure，PATCHES #4 同源〕；有原生 API 时零改动） | C4 全部；vendor 12 文件复制按钮、7 处 randomUUID、pptx 指纹 digest 自动受益 | 单测 8 条（缺 API 回退/有 API 不动/已知向量/其他算法拒绝） |
| `/share/` CardView（ocrc 自有）：clipboard 守卫 + 失败「复制失败」反馈 + 动作栏 `[@media(hover:none)]` 常显 | §3.3 末两行 | 代码 |
| `/share/` Blocks 工具行死路改造：无会话上下文（公开页）时降级为纯展示，去掉空点击 | §3.3 工具行 | 代码 |
| zcode-mobile.css 增补（选择器挂语义钩子，vendor 改名优雅降级）：<br>① hover:none 常显兜底（user-row/assistant-turn 动作栏、reasoning chevron、ContextAttachmentPill 删除键）<br>② `.chat-composer-region` 触屏窄视口按可视宽度封顶 → 工具栏收纳按真实宽度工作、发送键回屏内<br>③ 隐藏 4px 侧栏拖拽把手（触屏不可见且拖动必然无效）<br>④ Toast 顶部档避让刘海<br>⑤ 「显示更多」44px 命中区 | C2、§3.1 把手、§3.2 添加上下文/发送/工具栏收纳、§3.4 Toast、§3.1 显示更多 | 批次 D before/after 探针对照（下表） |
| apple-touch-icon.png 补齐（enso 标记，180×180，favicon 暗色盘） | §3.5 图标行 | 文件在位，`/apple-touch-icon.png?v=2` 不再 404 |

**批次 D before/after 探针对照**（390×844，同一隔离栈）：

| 指标 | before | after（预期实测） |
|---|---|---|
| home 越界交互元素 | 2（composer 盒→489、模型键→417） | 0（composer 封顶回屏内） |
| session hover-only | 10（动作栏整组不可见） | 0（常显兜底） |
| 侧栏拖拽把手 | 在 DOM（touch-none 吞手势） | 无（display:none） |
| console 报错 / 4xx | 0 / 0 | 0 / 0 |

**本轮修候选中被证据否决/移出的两行（如实记录）**：
- composer Enter=换行（§3.2）：`enterSubmits = resolveChatEnterSubmits({ isMobileTextInputViewport, preferEnterNewline: isWebRemoteControl })`（ConversationComposer.tsx:668-672）——语义完全由 `isWebRemoteControl`（switcher 门控）决定，ocrc 侧 CSS/垫片无法触达，硬截获 Enter 再注入换行有 Lexical 状态损坏风险。→ 移入 §6.3 接线（D15）。
- 提交后回焦（§3.2）：vendor `requestAnimationFrame(focus())`（LexicalChatInput.tsx:1429-1436），ocrc 无干净挂点。→ 移入 §6.3（随接线）。

### 6.2 后续小批候选（ocrc 侧、零 vendor 改动，待点头）

PairGate safe-area/提交钮/autoFocus/inputMode、分享页头 safe-area、启动态文案、错误边界覆盖 PairGate/ShareLanding、设置页 help 菜单触达、命令面板输入框高度。

### 6.3 立项候选（需裁决/体量原因不进本轮）

1. ~~**移动壳族接线**（§5 全部；含 D4-D31 分支生效、触达统一重估、C1/C3/C5/C6 随之消解）~~ —— **已落地**（W1/W2 批次，见 §5 落地状态）。
2. 权限 dock / 提问 dock（`pendingInteractions` 打通——引擎交互在 /z/ 可答）。
3. 侧页右覆盖抽屉 + 查找浮层入口 + 右键族触屏化（含长按→右键垫片：实测无兜底，按计划回退条款移入此清单）。
4. 非图片附件发送、长文本粘贴转附件、分享页图片 block。
5. 隐私模式配对降级提示、自动化/offpeak 窄布局、设置内容行布局（vendor 一行）、拍照直采。

### 6.4 明确不做（维持/本轮裁决）

- PWA / Service Worker / 离线缓存（OPS 有 HTTPS 路径）；手势系统（swipe 返回、下拉刷新）
- 语音入口（PRODUCT.md 列不做）；拖拽投放（有等价入口）；消息右键菜单（vendor 无此控件）；文件树行右键（本就只是选中）
- 加载骨架（纯观感）；UpdateStatusDialog（web 无更新语义）；QuickPickCommandDialog（v3.15.1 已被 CommandCenter 取代的死代码）；终端传输重连条（relay 打包边界外，恒不出现）
- 触达 <44px 的单点批量批改（C1）

## 7. 无归属项自查

六组深审共提出 14 条「无归属项」，逐条归位如下（无遗留）：
组一 5 条 → 探针口径修正（C7）、横移源定论（§3.1 末行）、设置态残留 DOM=覆盖层证据（§3.4 设置页-壳）、命令面板已实测（§3.4）、触达批量（C1）；
组二 0 条；组三 5 条 → C1/C2/C3/C4 + 壳级横滚（§3.1 末行）；
组四 6 条 → 消息右键（无此控件，§6.4）、文件树右键（§6.4）、死代码对话框（§6.4）、UpdateStatusDialog（§6.4）、ControlHintTooltip（C5）、非安全上下文落点（C4，远控复制链接入 §6.1）；
组五 0 条（跨组 pendingInteractions 归 §6.3-2）；组六 3 条 → 终端重连条（§6.4）、D30（并入接线）、ocrc 远控对话框（§3.4 已覆盖）。

## 8. 验证方法

### 8.1 CDP 探针（可复跑）

```bash
cd web-next && node scripts/mobile-audit.mjs            # 390x844 + 360x740 + 桌面回归档全量
node scripts/mobile-audit.mjs --device 390              # 单档
node scripts/mobile-audit.mjs --device desktop          # 桌面回归（标准壳 + 右键菜单断言）
MOBILE_AUDIT_BASE=http://127.0.0.1:4199 …               # 指定隔离栈
```
自起 headless_shell（9333，自起自清，不碰既有 9222）；token 运行时读 `/tmp/ocrc-z-home/.ocrc/token`（不入库不打印）；产物写 `/tmp/mobile-audit/`（report.json / report.md / 截图）；跑完自清自身造成的空草稿。产出列：横向溢出、越界交互元素、触达<44px、hover-only、<16px 可编辑、内部横滚、已横滚容器、侧栏/内容列/composer 几何、媒体查询命中、console 与 4xx。

**W2 起新增**：壳判定（报告行 `壳=移动壳home/移动壳chat/标准壳`：sidebarPanel 在=标准壳、side-pane overlay 在=移动壳 chat）；跨工作区 E2E（`cross-workspace-switch`：git-init 造 /tmp 第二工作区〔非 git 目录归引擎 "global" 项目，隔离栈 db 发现失灵，见 `src/opencode/list-sessions.ts`〕→ 首页展开其分组 → 点行 → 断言重挂落进新工作区 chat——390/360 两档实测 ok:true）；桌面回归档（标准壳 264px 侧栏 + 右键菜单 13 项弹出 + 无移动壳锚点）。每状态测量含 `taskHomeRows` / `mobileChatSurface` / `sidePaneOverlayPresent`。

### 8.2 手机真机核对清单（5 分钟，LAN http 直连 —— 移动壳版，W2 后）

**任务首页**
1. 打开 `/z/`：应见全屏任务首页（标题+主题菜单+提示卡+计数行），**不再是**半屏桌面壳（旧病：侧栏占半屏、右缘裁切）。
2. 「整理任务」菜单：按工作区/按时间线分组、创建/更新排序是否可切换？
3. 工作区卡：本地目录是否逐个列出（含 basename 标签 + local 徽标）？「新建任务」是否创建并直接落入该工作区 chat？
4. 运行中的会话是否带「运行中」徽标（W1 busy 真数据）；出错会话是否红「错误」徽标？

**跨工作区切换（重挂路径）**
5. 点另一工作区的任务行：全屏切换遮罩 → 1-2s 后应落入该工作区的 chat（标题为该任务名）。回退预期：若卡住/错位，见 §5 回退预案。

**任务会话页**
6. 顶栏 = 返回箭头 +「任务会话」+ 主题菜单；任务标题行下内容是否全宽（不再被侧栏压半屏）？
7. composer：发送键是否屏内、占位是否「向 ZCode 提问…」、Enter=换行（compact 语义）？
8. 发消息 → 时间线卡片流正常滚动；复制按钮有成功/失败反馈（http 垫片）。
9. 右上文件/侧页按钮：右覆盖抽屉是否滑出、chat 是否转 inert、遮罩点击能否关闭？

**主题与外观**
10. 主题菜单（首页 + 会话页两处）：亮/暗/跟随系统三选项；选「跟随系统」后切系统深色模式页面是否跟随？

**边界（预期行为，非 bug）**
11. 设置/自动化/插件市场/命令面板在手机上**无入口**（官方配套语义，§5 取舍）；任务行右键/长按无菜单（官方自身缺口）。
12. http 直连下复制可用（垫片）、添加到主屏有图标（apple-touch-icon）。
