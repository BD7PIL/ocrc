# 前端对接差距审计（v3.15.1 基线，2026-10-11 收敛）

> 口径：vendored ZCode UI **v3.15.1**（tag `aac4755`，Batch 2 于 2026-10-11 再基底）+ ocrc 翻译层
> （`web-next/src/zcode-services/`、`web-next/src/zcode/`）。基线登记见
> [web-next/vendor/VENDOR_BASELINE.md](../web-next/vendor/VENDOR_BASELINE.md)；vendor 修改登记见
> [web-next/vendor/PATCHES.md](../web-next/vendor/PATCHES.md)。
> 使命：**每一处差距都有归属**——已修（本轮）/ 已可用 / 需立项 / 明确不做，零无归属条目。
> 本审计随 Batch 2–4 一次性收敛；后续新增差距在此文件续记。

## 0. 结论速览

| 面 | 状态 |
|---|---|
| 服务面 | 20 服务实接（1 个全覆盖缺口 `respondProviderRuntimeHeaders`），1 显式缺席（CUA），26 槽 ghost（语义：on* noop / 其余 reject）；**3 个遗留前缀启发式 Proxy 待收口** |
| 平台面 | 7 实接 + ~50 显式 stub + ~60 可选缺席（vendor 全部 `?.` 守卫）；v3.15.1 新增 17 方法中 16 个无影响，1 个（`getWebRemoteControlStatus` 1Hz 轮询噪音）**本轮已修** |
| 协议面 | protocol-v4 主面零断裂（3 回归钉 + P5/批次 3 服务级测试全绿）；**dwf 引擎 JournalStorePort 读面收紧已在宿主侧再基底** |
| UI 数据面 | composer 工具栏 10 控件**全部点亮**（僵尸 3 + 缺失 1 由批次 3 清零）；状态面板七族输入全部有源 |
| i18n/资源面 | ocrc 消费面 16 键 16/16 在场；vendor locale 仅 +1 ocrc key（`settings.remotes.title`）；ocrc 无自有 i18n 体系（如实记录） |
| 新版新增面 | workflow-timeline ✅、stream-animate CSS ✅、远控对话框 ✅（ocrc 接管）；mobile shell 🔶 被产品方案替代、highspeed/cloud-content 🚫、plugin-ui ⬜ 惰性 |

---

## 1. 服务面：accessor 47 槽全景

装配点：`web-next/src/zcode/accessor.ts:95`（`createGhostAccessor`）——`real` map 20 项 + 显式 `cuaPermissionService: undefined` + 其余 26 槽落 `ghostService()` Proxy（`web-next/src/zcode-services/ghost.ts`：on* → noop 句柄，其余 → reject）。

> ⚠️ **口径修正**：`accessor.ts:2` 注释写的「39 服务字段」是 v3.14.3 时代的数字；v3.15.1 的
> `IServiceAccessor` = **47 槽**（`vendor/zcode/services/src/accessor.ts:53-111`）。

### 1.1 实接（20 服务）

| 服务 | 接口规模 | ocrc 覆盖 | 缺口 |
|---|---|---|---|
| zcodeAgentService | 142 方法 | 36（v4 三件套 + 附件事务 + workflow 只读 7 + saved-workflow 6 + …） | 106（见 1.3） |
| zcodeSessionService | 16 | 15 | `respondProviderRuntimeHeaders` → reject（web 壳无 provider runtime header 通道；上游仅 desktop 用） |
| zcodeTaskService | 75 | 35 | 5 on* → noop，36 → reject（多为其 ocrc 不用的任务编排面） |
| fileService | 17 | 17 | 0 |
| gitService | 18 | 15 | `getBranchComparison`/`getCommitGraph`/`getIgnoredPaths` → reject（Git 面板对应页签降级） |
| systemService / broadcastService / skillsService / mcpSyncService / offPeakTaskService | 3/6/6/8/11 | 全覆盖 | 0 |
| commandsService | 6 | 2 | 写面 4 → reject（ocrc 无命令文件管理面） |
| shareService | 9 | 8 | `onDynamicImportProgress` noop（导入本就显式拒绝） |
| botsService | 32 | 11 | 22 走旧式 Proxy（见 1.4） |
| codingPlanSubscriptionService | 33 | 1（`getDynamicWorkflowClientConfig`，P4-0 总闸） | 32 reject（订阅/支付类，PRODUCT 裁决） |
| pluginManagementService | 18 | 4（读侧映射 opencode.json） | 14 reject（插件市场不做） |
| modelSelectionService / providerSettingsService | 2 / 14+1 | 全覆盖 | 0 |
| settingService / onboardingRecordService / oauthService（accessor 内联 stub） | 4 / 9 / 13 | 4 / 6 / 3 | reject 兜底（无账号体系） |

### 1.2 显式缺席（1）

`cuaPermissionService: undefined`（accessor.ts:124）——CUA 整体不做（PRODUCT 裁决），vendor UI 全部真值守卫（`useCuaPermissionStatus.ts:37`、`CuaPermissionObservationAttachment.tsx:122` 等），入口正确隐藏。**归属：明确不做。**

### 1.3 ghost 槽（26）与主要可见症状

- **必填槽 ghost（18）**：terminalService、credentialService、fileWatcherService、usageStatsService、clientConfigService、clientScenesService、highspeedCardService、skillSyncService、pluginSyncService、pluginsService、subagentsService（设置页；对话内子代理目录走已实现的 `listSessionSubagents`）、hooksService、memoryService、outputStyleService（v3.15.1 新必填槽，vendored UI 尚无直调消费点）、settingsSyncService、feedbackService、gitCheckpointService、promptAttachmentTransferService。
- **可选槽 ghost（8）**：mediaPreviewService、cloudContentService、marketingTouchService、windowControllerService、genUiService、pluginUiBridgeService、pluginUiSamplingService、pluginUiAppToolsService。
- **已知可见症状**（reject 落到 UI）：automation 管理面板 9 方法（`store/automationManagementStore.ts`）、会话调试（`useSessionDebug.ts:34`）、会话文件改动时间线/回滚预览（`agentConversationTransport.ts:398/410`）、用量页（`useUsageStats.ts`）、反馈工单、credentials 读写、保存全局设置时 `syncAppRuntimePreferences` throw（`useSettingService.ts:159`——botsService 同名已实现，agent 侧未实现是 throw 源）、完成卡「直接保存 run」（`saveSavedWorkflowFromRun`）。
  **归属：需立项（各自单独评估数据面）；在立项前如实 reject（不假装成功）。**
- **⚠️ 真值守卫漏洞**：8 个可选槽的 ghost 是 **truthy** Proxy，vendor 的 `Boolean(services?.genUiService)` 类守卫会误判「在场」后走进 reject（`useGenUi.ts:17`、`usePluginUiHost.ts:30`、`SessionPane.tsx:3229`）。**建议收口**：照 `cuaPermissionService` 的方式对明确不做的 optional 槽显式置 `undefined`。归属：需立项（低风险清理批）。

### 1.4 遗留启发式 Proxy（待收口）

`zcodeAgentService.ts:2137`、`botsService.ts:173`、`offPeakTaskService.ts:136` 仍用 `/^(on|add|subscribe|listen|watch)/` 前缀 noop——与 ghost.ts 的语义分类相悖。已知后果：`addPluginMarketplace`（测试路径）假成功、`botsService.watchAutomationRun` 假订阅。**归属：需立项（低风险清理批，换成 ghostMethod 语义分类）。**

### 1.5 Proxy 兜底 noop（语义上可接受）

`onAgentRuntimeRestarted`（4 个 vendor 订阅点；ocrc runtime 无换代重启语义）、`onDynamicLocalTtftFacts`（TTFT telemetry）、`onDynamicConversationTelemetryFact`（telemetry 静默为空）。**归属：明确不做（ocrc 语义下无事件可发）。**

## 2. 平台面：IPlatformService（~130 成员）

ocrc 实现：`web-next/src/zcode/platform.ts`（`as unknown as IPlatformService` 强转）。

- **实接（7）**：selectFile(s)/getPathForFile（HTML picker → web 句柄）、saveMcpToUserDirectory（N8-3 共享实现）、openExternal、showTaskNotification（Web Notification）、getDeviceId、`canSelectFilePath:false`。
- **显式 stub（~50）**：桌面性能力全部如实拒绝（connectRemote、更新器族、OAuth/deep-link 族、Docker/WSL/SSH 探测、窗口族…）——与上游 `packages/web/src/main.tsx` 的 web stub 同一姿态。
- **缺席（~60，全可选）**：browser-view guest ~18 件套、CUA 4 件套、窗口 chrome 4 件套、内嵌浏览器权限 6 件套、pluginSandbox 等——vendor 全部 `?.`/真值守卫，缺席 = 入口不出现，无崩溃路径。
- **v3.15.1 新增 17 方法**：16 个对 web 无影响（守卫完备或经 alias 不可达——startWebRemoteControl 三件只被 vendor 原生对话框调，而它被 ocrc alias 整体替换）。
- **本轮已修（1）**：`getWebRemoteControlStatus` 缺失 → 页脚触发器挂载后 `useWebRemoteControlStatus.ts:63` 每秒轮询一次 TypeError（被吞成 debug 日志、status 恒 idle）。已按上游 web stub 同形补齐 4 个远控 stub（platform.ts，`startWebRemoteControl`/`refreshWebRemoteControlPairing` reject、`stopWebRemoteControl` resolve、`getWebRemoteControlStatus` → `{status:'idle'}`）。
- **`webRemoteControlAvailable` 能力位**：ocrc 私有 duck-typing（platform.ts:45），vendor 侧消费点是 PATCHES.md #9 的页脚门；上游形态 = desktop-only（全上游无此字符串）。**归属：已可用（ocrc 接管远控链路）。**

## 3. 协议面：protocol-v4 + dwf 引擎

### 3.1 protocol-v4（conversation/sessions-index wire）

ocrc 直接依赖的 8 类协议文件（transport / wire-assembler / delta / snapshot / workflow-runs / workflow-runs-delta / sessions-index-workflow-activity / index）在 Batch 2 覆盖后由三道钉验证：

- `web-next/src/zcode-services/__tests__/v4-recovery.test.ts`（真实 assembler + 真实 store 的恢复阶梯）
- `hostOfflineVisibility.test.ts` / `composerLightup.test.ts`（服务级真代码路径，control patch 逐帧过 `sessionControlSchema`）
- 后端 workflow 域 967 测试

结果：**零断裂**。ocrc 写出的 v4 帧（snapshot/deltas/state.updated/row.*）在 v3.15.1 schema 下全部通过 zod 自检。上游 v3.15.1 的新增键（workflowRuns 容器等）本来就是 additive（容器不 strict）。
**归属：已可用。**

### 3.2 dwf 引擎（vendor/zcode-dwf，仓库根）

v3.15.1 引擎 `JournalStorePort` 读面收紧：`listNodes/listActors/listEvents` opts **必填**（kinds/withResult/withPersona/types/reportItems 全语义，存储层过滤），新增 `countNodes`/`sumResultBytes`/`updateRunScript`。宿主侧已再基底：

- `src/core/workflow/journal.ts`：JSONL journal 实现全部新语义（含 reportItems 的 run 级 report 序号剥离、maxResultBytes 截断、persona/result 剥离）；新增 `run-script` 行种。
- `src/core/workflow/manager.ts` / `imported-cache.ts`：调用点补 opts（`{kinds:'all', withResult:true}` / `{withPersona:…}`）。
- `tests/unit/vendor-dwf-smoke.test.ts`：listNodes 新签名适配（8/8 绿）。
- **归属：已修（Batch 2）。** vendor 文件本身仅 2 行 workspace-import 重放（dwf PATCHES.md #1），无其他修改。

## 4. UI 数据面

### 4.1 composer 工具栏 10 控件（官方对照）

| 控件 | 数据源 | 状态 |
|---|---|---|
| `+` 附件 | platform picker → web 句柄 → v4 附件事务（N8-4 校验和回退） | ✅（仅图片，ocrc 发送通道裁决） |
| 策略下拉（完全访问/build/edit） | **config.mode** ← GET /api/session/:id/policy（批次 3 读路径；写路径 switchCollaborationMode 早已接） | ✅ 批次 3 清零（原「写通读不回显」） |
| 计划 | payload.planEnabled → 引擎 plan agent | ✅ |
| 🤖 子代理徽标 | subagents 投影 | ✅ |
| spinner（运行中） | 引擎 run 存续（rows/turn 状态） | ✅ |
| 模型 | modelSelectionService + overrides | ✅ |
| 思考档 | config.thought/thoughtLevels | ✅ |
| 停止按钮 + Esc | **canStop/stopState/activeWorks** ← ws session.status busy 帧（批次 3）+ **stop 命令** → POST /api/abort（批次 3） | ✅ 批次 3 清零（原恒 false + 命令未接） |
| 运行中排队 placeholder | 同 canStop 面 | ✅ 批次 3 清零 |
| context usage pill | **usage.contextWindow** ← GET /api/session/:id/context 的 tokens.used/max（批次 3；后端 lastKnown 兜底引擎忙窗口归零） | ✅ 批次 3 清零（原恒 null） |

### 4.2 状态面板（ConversationStatusPanel）七族输入

git（gitService，15/18 实接）· goal（goalProjection）· sessionPlans/plan（conversationPlan/todo）· backgroundWorks（collectBackgroundWorks）· runningSubagents（/subagents）· workflowRuns（P4 投影）——**全部有源**。面板级 early-return 已带 ocrc patch #5（已结束子代理开门）。

### 4.3 其余「接了线没数据」清单（现状与归属）

| 项 | 现状 | 归属 |
|---|---|---|
| automation 管理面板 | agentService automation 族 9 方法 reject（ocrc 的自动化主视图走自家 offPeak/schedules 面） | 需立项（或明确不做——与 ocrc 自动化主视图二选一） |
| 会话文件改动时间线 / 回滚预览 | `conversationFileChangesV4`/`conversationFileRewindPreviewV4` reject | 需立项（引擎有 revert 端点，缺投影） |
| 完成卡「直接保存 run / 再次运行预填」 | `saveSavedWorkflowFromRun`/`findSavedWorkflowForRun` reject（saved-workflow 6 件套已接） | 需立项（小） |
| 全局设置保存 | `syncAppRuntimePreferences`（agent 侧）reject → useSettingService throw | 需立项（小；或 agent 侧补同 botsService 的实现） |
| 用量页 / 反馈工单 / credentials / 调试面板 | ghost reject | 明确不做（账号/云面）或低优（调试） |
| sessions-index 侧栏在掉线期冻结 | P5 只覆盖 conversation 面；index 帧同样停流但无掉线横幅 | 需立项（P5 后续，复用 hostConn） |

## 5. i18n/资源面

- **ocrc 消费 vendor key**：仅远控对话框一处 intl 消费面（`src/zcode/remoteControl/WebRemoteControlDialog.tsx`）——`webRemoteControl.*` 16 键（含 4 通道模板键 + 2 个 regionTag 间接键），**16/16 在** v3.15.1 两份 locale 中（上游原生键，零丢失风险）。
- **ocrc 新增 vendor key**：恰 1 条 `settings.remotes.title`（两语言；PATCHES.md #8 的一部分，列入重放清单）。
- **ocrc 无自有 i18n 体系**：文案内联中文（RemotesSection 头注释明写）。已知后果：英文模式下 ocrc 自研 service 的错误串中英混排（CHECKLIST 🔶 项，如实记录，不阻塞）。
- **locale 键数对账**：zh-CN 6363（上游 6362 +1）/ en-US 6365（+1）。

## 6. v3.15.1 新增面可用性

| 新面 | 判定 | 依据 |
|---|---|---|
| workflow-timeline 族（50 文件） | **✅ 已可用** | 静态可达 + 数据面全供给（P4/P4b 四道门禁全绿；引擎 JournalStorePort 已适配） |
| stream-animate（CSS 流式入场动画） | **✅ 已可用（零接线）** | 纯 CSS keyframes + data 属性，styles.css 已入 bundle；`@zcode/stream-animate` 包本身是上游内部工具，不在 ui 模块图，**不 vendor（明确不做）** |
| WebRemoteControlDialog（v3.15.1 新版 = 中继制扫码） | **✅ 已可用（ocrc 接管）** | alias 整体替换为 ocrc 双栏 fork（无中继、LAN 直连，PRODUCT 裁决）；上游中继制实现**明确不采用** |
| remote mobile shell（relay 式极简手机壳） | **🔶 被产品方案替代** | 运行时三重门（switcher prop 只有上游 relay 入口传）；ocrc = 手机直接开 /z/ + N8-7 移动适配。除非未来做 relay 式壳，否则明确不做 |
| highspeed 族 | **🚫 明确不适用** | 依赖上游账号 Coding Plan 加速权益 + 服务端 admission（builtin provider 白名单）；ocrc 无账号体系，UI 代码纯惰性 |
| cloud-content-dialog + marketing-touch（lottie-web 新依赖） | **🚫 明确不适用** | MarketingTouchProvider `desktop=false` 整面停用；内容来自上游账号营销管线。lottie-web 随上游装入（惰性依赖） |
| plugin-ui / gen-ui（MCP ext-apps 新依赖） | **⬜ 惰性（现状零成本）** | 激活需要「带 UI 的插件 payload」；ocrc 插件面只读映射 opencode.json。未来引入插件 UI 生态再立项 |
| 上游新增槽 8 个（accessor 39→47） | ghost 兜底 | 见 §1.3/1.5；`outputStyleService` vendored UI 尚无消费点 |

## 7. 遗留清单（本轮收敛后的全部未决项）

1. **低风险清理批**（建议下批次）：8 个 truthy-ghost optional 槽显式置 `undefined`；3 处旧式前缀启发式 Proxy 换 ghostMethod 语义分类。
2. **需立项（小）**：`syncAppRuntimePreferences`（agent 侧）、完成卡保存 run、文件改动时间线/回滚预览、sessions-index 掉线可见化（复用 hostConn）。
3. **需立项（中）**：automation 面板与 ocrc 自动化主视图的关系裁决。
4. **明确不做**：CUA、账号/云面（usageStats/feedback/credentials/subscription）、中继制扫码、desktop/android 宿主能力、plugin-ui/gen-ui（现状）、highspeed、marketing。

---

*生成：2026-10-11，Batch 4（P5 host 掉线可见化 + vendor v3.15.1 全面升级 + 前端对接差距审计）。*
*数据来源：三个并行只读调研（服务面 87 次检索 / 平台面 33 次 / i18n+新增面 84 次）+ Batch 2/3 的服务级测试与构建产物核验。*
