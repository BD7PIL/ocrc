# PATCHES.md — vendor 修改登记（re-vendor 时照单重放）

> 上游：zai-org/ZCode **v3.15.1**（tag `aac4755`，2026-10-11 由 Batch 2 再基底；前一基线 v3.14.3）。
> 修改纪律：加法优先（新组件/包装层放 vendor 之外）；确需改 vendor 文件时保持最小修改并在此登记。
> 重放流程：更新快照（覆盖 vendor/zcode/，装订约定见 [VENDOR_BASELINE.md](VENDOR_BASELINE.md)）→
> 跑 `node scripts/vendor-ts-nocheck.mjs` → 逐条重放下列修改 → `npm run build` 验证。

## 1. 全量 @ts-nocheck 横幅
- **文件**：所有 vendored `*.ts` / `*.tsx`（首行插入 `// @ts-nocheck`）
- **原因**：上游代码按其自身 tsconfig（无 verbatimModuleSyntax、宽松度不同）通过；我们的 tsc 配置更严，全量类型检查会产生海量噪音。@ts-nocheck 只静音类型错误，类型信息仍流入我们的代码（accessor 等消费 `IServiceAccessor` 等接口）。
- **重放脚本要点**：遍历 vendor 树，未以横幅开头的文件插入一行。**已脚本化**：`node scripts/vendor-ts-nocheck.mjs`（幂等；`--check` 只报告；自动排除 `cua/**/*.d.ts`），见 [VENDOR_BASELINE.md](VENDOR_BASELINE.md) 升级操作序。

## 2. Root.tsx 摘除 OnboardingDialog 挂载
- **文件**：`vendor/zcode/ui/src/Root.tsx`（v3.15.1 约在 L1320 附近的 OccupationOnboarding 收尾处）
- **修改**：`<ScopedErrorBoundary scope="onboarding-dialog">…<OnboardingDialog …/></ScopedErrorBoundary>` 整块包在 `{false && ( … )}` 中（不卸载 import）。
- **原因**：ocrc 用 accessor 的 `onboardingRecordService`（shouldOnboard=false）标记引导完成；且该弹层关闭/卸载转换在 prod 触发 hook 顺序崩溃（areHookInputsEqual undefined deps，栈落在 useSettingsSync → useZCodeSessionService → useTabStore 链）。

## 3.（运行时行为，非文件 patch）上游缺陷修复沿用
- **vite.config.ts**：`worker.rollupOptions.treeshake: false`——上游 web/vite.config 同款修复（@pierre/diffs worker 入口缺 sideEffects 声明，生产 worker 子构建被摇成 0B → 池握手超时）。

## 4. 附件上传校验和：非安全上下文的纯 JS SHA-256 回退（N8-4）
- **文件**：`vendor/zcode/ui/src/v4/sha256Pure.ts`（新增）+ `vendor/zcode/ui/src/v4/attachmentUploadTransaction.ts`（`checksum()` 一处分支 + 一行 import）
- **修改**：`checksum()` 由「无 `crypto.subtle` 即抛 `fault.attachment.checksumUnavailable`」改为「有 subtle 走原生，否则回退 `sha256Hex()`（纯 JS，FIPS 180-4）」，返回格式不变（`sha256:<小写 hex>`）。
- **原因**：`crypto.subtle` 只在安全上下文（https/localhost）存在。ocrc 生产形态常是局域网 http 源（`http://192.168.x.x:4099/z/`），那里拖放/粘贴的附件（无 localPath，走 V4 上传事务）第一步就抛错、整条链断掉。零拷贝 localPath 路径本来就不算校验和，不受影响。
- **验证**：`web-next/src/zcode-services/__tests__/attachmentChecksum.test.ts` 对照 node `crypto` 逐长度比对（空/1B/55/56/63/64B/多 block/中文），并 stub 掉 subtle 走回退接线断言 `beginParams.checksum`。

## 5. 状态面板：已结束子代理单独开门（N8-5）
- **文件**：`vendor/zcode/ui/src/v4/ConversationStatusPanel.tsx`（面板级 early-return 一处条件）
- **修改**：`if (!model.hasContent && !canRenderEndedWorkflows) return null;` → 追加 `&& !canRenderEndedAgents`。
- **原因**：上游注释自认"Agents 的已结束行有同一个洞：`endedSubagentCount` 没进 `hasContent`"。后果：**只剩历史**的会话（opencode 不热重载，host 重启后打开旧会话就是这种）整个状态面板消失 → 子代理目录入口在旧会话里永远不可达。ocrc 的持久会话几乎都是这种形态。
- **验证**：隔离栈造一个已结束子会话 → /z/ 打开父会话 → 状态面板出现「已结束」入口 → 点击打开子代理目录面板并列出该子会话。

## 6. 白板入口解注释（N11-1）
- **文件**：`vendor/zcode/ui/src/app-shell/AnimatedSidePanePanel.tsx`（`+` 菜单中上游注释掉的画板项）+ lucide import 列表加 `PaletteIcon` + 解构 `onOpenWhiteboard` 去掉 `_` 前缀
- **修改**：恢复被上游注释的 `<DropdownMenuItem onSelect={onOpenWhiteboard}>` 画板菜单项。
- **原因**：PRODUCT.md 增值四件明列 whiteboard（纯前端+发到聊天）。vendor store 零 fetch、纯内存；「添加到对话区」走 window CustomEvent → composer 附件 → 既有 sendText 通道，ocrc 零桥接。
- **验证**：隔离栈实测：展开侧边面板 → 终端 tab → `+` → 画板 → 画线 → 添加到对话区 → composer 出现 `画板 1.png` 附件。

## 7. mermaid 渲染器按需加载（N12 G9）
- **文件**：`vendor/zcode/ui/src/components/ai-elements/code-block.tsx`（import → `lazy()` + `<Suspense>`）、`vendor/zcode/ui/src/previewPaneCodeContent.tsx`（同）
- **修改**：两处 `import { MermaidBlock } from "…/mermaid-block.js"` 改为 `lazy(() => import(…))`，调用点包 `<Suspense fallback={null}>`。
- **原因**：静态 import 让 mermaid 渲染器成为壳层 chunk 的静态可达节点（图表是少数派内容）。
- **实测（N12 G9 分包审查，`npm run build` 产物字节）**：
  - 首屏 = 入口 `index-*.js` 441.8 kB + 唯一静态依赖 `mermaid-MCJ5UELQ-*.js` **8,688.4 kB**（gzip 2,434 kB）+ CSS 385.9 kB（gzip 62.8 kB）≈ **2.6 MB gzip**。
  - 本补丁单独生效 ≈ −4 kB（把渲染器本身挪出静态图）。
  - **mermaid 的静态残留 = 622 kB**（唯一另一条静态链是 `message.tsx:16` 的 `import { mermaid } from "@streamdown/mermaid"` → `streamdownPlugins`，删掉实测 8,688 → 8,066 kB）。**该链未动**：它挂在核心消息渲染器的 plugins 入参上，延后会让首遍 markdown 解析拿不到 mermaid 插件，需单独批次 + 渲染实测。
  - 其余重件（pdf-viewer / pptx、xlsx 预览引擎 / prism 语言包 / wasm）上游**已经**各自独立懒 chunk——分包结构本身是对的；8 MB 壳层是 vendor UI + streamdown/remark/shiki/katex/zod 的热图，缩表需要 bundle-visualizer 级的归因批次。
- **验证**：`npm run build` 通过；`mermaid-block-*.js`（4.4 kB）成为独立懒 chunk；非 mermaid 代码块路径无 Suspense 命中（`shouldRenderMermaid` 门内）。

## 8. 设置页：远程主机分区（N5 remotes，2026-10-09）
- **文件（5 + 1 新增）**：
  - `vendor/zcode/ui/src/settings/RemotesSection.tsx` —— **ocrc 新增文件**（223 行，管理远程主机：增删/探测/升级推送）。⚠️ 覆盖快照会丢，重放时从 git 恢复（与条目 4 的 sha256Pure.ts 同列保留清单）。
  - `vendor/zcode/ui/src/SettingsPage.tsx` —— import `RemotesSection` + 渲染分支 `activeSection === "remotes"`。
  - `vendor/zcode/ui/src/lib/settingsNavigation.ts` —— `SettingsSectionId` union 追加 `"remotes"`。
  - `vendor/zcode/ui/src/settings/settingsPageConfig.ts` —— lucide import 加 `Globe`；`BASE_SETTINGS_SECTIONS` 追加 remotes 项（`groupId: "agentCapabilities"`）。
  - `vendor/zcode/ui/src/i18n/locales/en-US.ts` / `zh-CN.ts` —— 各加一行 `"settings.remotes.title"`（Remote Hosts / 远程主机）。
- **原因**：N5 把远程主机收进 /z/ 设置页管理（用户裁决②：remote hosts 在 /z/ 原生管理）。
- **验证**：/z/ → 设置 → 远程主机：列表/新增/探测/升级推送可用；i18n 两语言标题正常。

## 9. 页脚：web 模式远程控制入口能力位（N5 remotes，2026-10-09）
- **文件**：`vendor/zcode/ui/src/WorkspaceSidebarFooter.tsx`（约 L371，一处条件）
- **修改**：`isDesktop && workspacePath ?` → `(isDesktop || (platform as { webRemoteControlAvailable?: boolean }).webRemoteControlAvailable === true) && workspacePath ?`（附 2 行 ocrc 注释）。
- **原因**：远程控制/bots 弹层入口上游只在 desktop 客户端亮；ocrc web 壳需要它。能力位 `webRemoteControlAvailable` 由 ocrc 的 platform service 实现（web-next 侧）显式声明——vendor 的 platform.ts 零改动；不强开 `isDesktop`，避免连带桌面缩放等 UX。
- **验证**：/z/ 左栏页脚出现远程控制入口；点开是 ocrc 双栏对话框（alias 覆盖，见 vite.config.ts 注释，不在本清单）。

## 10. i18n 品牌覆盖注册表（U2 去品牌，2026-10-11）
- **文件（4）**：
  - `vendor/zcode/ui/src/i18n/IntlProvider.tsx` —— 模块级 `brandMessages` 注册表 +
    `setZCodeBrandMessages()` 导出；`createIntl` 在 locale 词表取出后合并 brand 层（键级覆盖，vendor 词条零触碰）。
  - `vendor/zcode/ui/src/i18n/index.ts` + `src/index.ts` —— barrel 再导出 `setZCodeBrandMessages`（各一行）。
- **原因**：ocrc 面板去除 ZCode 品牌字样。放 IntlProvider 而非逐实例传 prop：vendor 内部还有三个独立
  `ZCodeIntlProvider` 实例（ErrorBoundary 崩溃屏、UpdateStatusWindowRoot、分享只读页——后者是公开页，
  必须盖），注册表对全部实例（含未来新增）零成本生效。
- **ocrc 侧**：`web-next/src/zcode/brandMessages.ts`（zh 101 键 / en 102 键 = vendor 词表全部 ZCode 键机械替换收口；
  唯二不覆盖的是带 zcode.z.ai 下载外链的外向分享文案（该面在 ocrc 不存在，覆盖反而留下指向外站的句子））；
  `ZCodeApp.tsx` 模块渲染前 `setZCodeBrandMessages(BRAND_MESSAGES)`。
- **验证**：`src/zcode/__tests__/brandMessages.test.ts`（覆盖值零 ZCode 残留 / 键在 vendor 词表存在 /
  `{placeholder}` 占位符守恒）；隔离栈 CDP 品牌残留核对。

## 11. 页脚身份兜底（U2，2026-10-11）
- **文件**：`vendor/zcode/ui/src/WorkspaceSidebarFooter.tsx`（两处）
- **修改**：`getSidebarProfileName` 兜底 `"ZCode"` → `"ocrc"`；`getAvatarFallbackText` 兜底 `"Z"` → `"O"`。
- **原因**：ocrc 无 ZCode 账号体系，oauthService 幽灵返回本地身份，但 displayName/username 双缺时
  页脚仍会露出上游兜底名。

## 12. Logo/字标 enso 化（U2，2026-10-11）
- **文件（5）**：
  - `assets/provider-icons/logo-zai.svg` + `logo-zai-square.svg` —— 内容换成 ocrc enso mark
    （currentColor 环 + `#e4580f` 点，随主题配色；**文件名保留**，import 点零改动）。
  - `components/ui/ZCodeAboutLogo.tsx` —— Z 字标两组件换成 enso + ocrc 文本（组件名保留，
    WelcomeScreen/Onboarding/HighspeedShareNoticeCard 调用点零改动）。
  - `WindowsTopLeftLogo.tsx` / `DesktopTopOverlay.tsx` / `WorkspaceSidebarCollapsedRail.tsx` /
    `WelcomeScreen.tsx` —— `alt/aria-label="ZCode"` → `"ocrc"`（各一行）。
- **原因**：同 U2。index.html title 与 favicon.svg 本就是 ocrc（不动）。

## 13. 清理：不做面的入口摘除（U3，2026-10-11）
ocrc 侧（2 文件）：
- `src/zcode/accessor.ts` —— `marketingTouchService` / `feedbackService` / `skillSyncService` /
  `pluginSyncService` 显式 `undefined`（缺席分支先例 cuaPermissionService）。skillSync/pluginSync
  的缺席让设置页同步入口的 `Boolean(baseServices.xxx)` 门如实为假（ghost Proxy 恒真才需要补丁），
  **同步按钮零 vendor 补丁消失**。
- `src/zcode/platform.ts` —— `executeDesktopCommand` 置 `undefined`（类型断言绕开必填签名）：
  上游 no-op 真值函数让 `cuaPlatform.ts` 的 `typeof === "function"` CUA 门对 Windows UA 放行，
  门如实关闭（CUA 裁决不做）。

vendor 侧（6 文件，全部摘除类一行/一块 + ocrc 注释）：
- `WorkspaceSidebarFooter.tsx` —— 奖励菜单项 `{false && user ? ...}`（直连 ZAI 站，快捷键/CSS 藏不住）。
- `WorkspaceHelpMenuButton.tsx` —— 社区（platform no-op 死点击）+ 问题上报 + 产品建议
  （feedbackService 缺席必拒绝）三条摘除。
- `ChatErrorBanner.tsx` —— 反馈按钮摘除（同 feedbackService），复制按钮保留。
- `WorkspaceHeaderActionSection.tsx` + `quickpick/quickPickCommands.ts` + `App.tsx` —— 终端入口三闸：
  header 按钮、命令面板 toggle-terminal / add-terminal-tab 两条、toggleTerminal 快捷键 no-op
  （PRODUCT 裁决终端不做；terminalService 缺席，点开=空终端+reject）。
- `quickpick/quickPickCommands.ts` —— 命令面板 feedback 条目摘除（platform.openFeedback no-op 死点击）。
- `SettingsPage.tsx` + `settingsPageHelpers.tsx` —— 新用户引导两处入口摘除（ZCode 账号迁移向导；
  newUserOnboardingOpen 无渲染承接=死点击）。

**如实残留（留待，不遮掩）**：插件商店/安装按钮（商店 tab 面深织 10+ 处；mutation 全部
withGhosts 如实拒绝且文案注明真实机制=编辑 opencode.json，无静默失败）——摘除归独立小批。
设置页「终端字体」行同理（功能保存正常、特征无消费者）。
**验证**：CDP 隔离栈——rewards 不在 DOM、命令面板「终端」0 命中、设置页无新用户引导、
技能/插件分区无同步按钮；console 零错误；对照项（终端字体行）仍在场证明探针真实打开页面。
