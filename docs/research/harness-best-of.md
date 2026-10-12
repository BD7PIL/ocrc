# harness 优点吸收总账（best-of）

> **用途**：把散落在五处的「合并各家优点」记录收口成一张**逐项可查、可裁决**的账。
> **怎么翻**：每一项有**稳定 ID**（`A1`…`E3`）。索引在 §1，逐项详表在 §2。
> **搜 ID（如 `B1`）即定位**——不要靠标题翻，靠 ID。
> **口径**：只记**事实 + 证据**（`file:line` / commit）。建议分「做 / 不做 / 待裁决」并附理由；
> 结论只作裁决输入，`docs/PRODUCT.md` / `docs/ARCHITECTURE.md` 的既有裁决文本不在本文件擅改。
> **生成方式**：全库 grep 抽查 + 定向 desk research（非逐行重读四家源码）。全历史
> 「融合 / 对标 / 优点 / 选型」0 命中——本文件即首份收口。

## 0. 五处记录索引

| # | 位置 | 内容 | 在 ocrc git? |
|---|---|---|---|
| 1 | `docs/PRODUCT.md:157-164` | 参照系：六家吸收清单（ZCode / dsh / opencode web / OpenCode-Client / grinev / anomalyco opencode） | ✅ |
| 2 | `docs/PRODUCT.md:15` + `docs/ARCHITECTURE.md:74-82` | HarnessAdapter seam：opencode 1.18 首个适配器；opencode V2、**pi** 为后续适配目标（裸名） | ✅ |
| 3 | `/home/demo/OCWF/docs/ocrc-fork-development-plan.md:44-56` | 参考三角（OCRC fork / zcode bots / dsh-remote-web-ui）+ OmO 迁移闸门 | ❌ **外部本地库**（不在本仓库） |
| 4 | `docs/next-phase.md:14-15` | OmO 上游已迁 senpi 自有引擎（v5.1.x 全系） | ✅ |
| 5 | `NOTICE:20-28` + `web-next/src/styles/theme.css:12` + commit `66ddc0fb` | 落地证据（归属声明 / 寄存器出处 / 最早移植提交） | ✅ |

## 1. 名册与索引（ID 总表）

> 同一项只出现一次（旧版把「主题即 JSON / CSP / RiskConfirmation」在未落地组和不做组各列一遍，
> 是「翻不到」的原因之一）。每项的「做不做」结论写在**该项自己的条目**里。

### A 组 · 已落地（要过的是「维护 / 回退」，不是「做不做」）

| ID | 项 | 来源 | 状态 | 建议 | 详表 |
|---|---|---|---|---|---|
| A1 | 三层语义令牌 static→alias→specific | dsh | 已落地 | 保持（token 名=冻结契约） | §2 |
| A2 | superellipse 全局表 | dsh | 已落地 | 保持（渐进增强） | §2 |
| A3 | 滚动条全局表 | dsh | 已落地 | 保持 | §2 |
| A4 | 焦点环全局表 | dsh | 已落地 | 保持（注意新增组件自画 ring） | §2 |
| A5 | 0.5px 发丝描边 + 双层柔光高程 | dsh | 已落地 | 保持 | §2 |
| A6 | ContextMeter / TurnNavigator / TextShimmer | dsh | 已落地（vendor 等价物） | 保持 | §2 |
| A7 | 字号一等设置 | dsh | 已落地（vendor 12–20） | 量程见 D1 | §2 |
| A8 | **行级虚拟化时间线** | opencode web | **已落地（vendor 提供）** | 保持；**ocrc 侧见 B7** | §2 |

> **A8 更正**：旧版判「部分/未落地」，与代码不符。vendor 会话时间线**已有**行级虚拟化
> （`ConversationTimeline.tsx:22,784-790` `useVirtualizer`）。详见 A8 条目。

### B 组 · 未落地 / 待处置（每项自带结论）

| ID | 项 | 来源 | 状态 | 建议 | 详表 |
|---|---|---|---|---|---|
| B1 | RiskConfirmation 独立组件 | dsh | 未落地 | **不做独立组件**（与 dock 重叠） | §2 |
| B2 | Markdown 渲染进 Worker | opencode web | 未落地 | 待裁决（实测驱动） | §2 |
| B3 | 主题即 JSON | opencode web | 未落地 | **不做** | §2 |
| B4 | CSP + 主题脚本哈希 | opencode web | 未落地 | **不做** | §2 |
| B5 | 媒体输出 document / video / audio | grinev | 部分（图片相册已落地） | 待裁决（按需） | §2 |
| B6 | 知识库→资产化闭环 | OpenCode-Client | 不做（本体） | **不做** | §2 |
| B7 | **ocrc 桥接数据面窗口化** | （自省项，非别家特性） | 未落地 | 待裁决 | §2 |

> **B7 新增**：性能实测把瓶颈指向 **ocrc 自己的数据管道**（全量 rebuild / 全量快照 / 无 offset），
> 不是别家特性。旧版名册漏了这一项——因为它是照「别家有哪些」列的。详见 B7 条目。

### D 组 · 跨项决策

| ID | 决策 | 选项 | 建议 | 详表 |
|---|---|---|---|---|
| D1 | 字号量程 12–20 vs dsh 10–22 | 维持 / 放宽 | **维持** | §2 |
| D2 | future adapter 命名「pi」 | 维持 / 改判 omp·gjc | **改判更准确** | §2 |

### E 组 · pi 家族适配器候选

| ID | 候选 | 协议入口 | 建议 | 详表 |
|---|---|---|---|---|
| E1 | omp（`can1357/oh-my-pi`，MIT） | `omp acp` ✅ | **首选**（先做平台验证） | §2 |
| E2 | gjc（`Yeachan-Heo/gajae-code`，MIT） | `gjc acp` ✅ | 次选 | §2 |
| E3 | pi / senpi 本体 | 无 ACP | 不作首选 | §2 |

## 2. 逐项详表

> 影响面六维：**分层**（PRODUCT 第二条：核心/壳/宿主/分发）· **文件** · **工作量**（S<1 人日 / M 1–3 / L>3）·
> **依赖** · **回归风险**（是否撞冻结项：配色口径、右栏≥中栏、EL7 下限、air-gap、发布冻结）· **门禁**。

---

### A1 · 三层语义令牌 `dsh` · **保持**

- **状态**：已落地 —— `web-next/src/styles/theme.css:12-17,32,65,192`（LAYER 0 static / LAYER 1 alias / LAYER 2 specific）。
- **优点**：组件只消费 alias 层 → 换肤零改组件（M9 换色已验证）。
- **缺点 / 代价**：多一层间接，新人找值要跳三层；LAYER 0 raw 值与 ZCode verbatim 强耦合。
- **影响面**：分层=**壳**｜文件=`theme.css`（单文件）｜工作量=0（已落地）｜依赖=无｜回归风险=**token 名是冻结契约，改名波及全部组件**｜门禁=视觉回归（CDP）。
- **建议**：**保持**。它是换肤契约，不是可选项；回退=全组件返工。
- **证据**：`theme.css:12-17`（层次说明）、`:32/:65/:192`（三层分节）。

### A2 · superellipse 全局表 `dsh` · **保持**

- **状态**：已落地 —— `theme.css:437-440`（`@supports (corner-shape: superellipse(1.5))`）。
- **优点**：连续曲率外观，1 行全局生效。
- **缺点 / 代价**：依赖实验特性 `corner-shape`（非基线）。
- **影响面**：分层=**壳**｜文件=`theme.css`｜工作量=0｜依赖=无｜回归风险=**低**（`@supports` 门控，老引擎回落普通圆角→外观不一致，可接受）｜门禁=视觉回归。
- **建议**：**保持**（渐进增强）。
- **证据**：`theme.css:437-440`。

### A3 · 滚动条全局表 `dsh` · **保持**

- **状态**：已落地 —— `theme.css:444-459`（双引擎路径门控：`scrollbar-color` + `*::-webkit-scrollbar`）。
- **优点**：明暗统一。
- **缺点 / 代价**：全局 `*::-webkit-scrollbar` 选择器。
- **影响面**：分层=**壳**｜文件=`theme.css`｜工作量=0｜依赖=无｜回归风险=低（组件局部滚动条皮肤需让位）｜门禁=视觉回归。
- **建议**：**保持**。
- **证据**：`theme.css:444-459`。

### A4 · 焦点环全局表 `dsh` · **保持**

- **状态**：已落地 —— `theme.css:483`（`*:focus-visible`）。
- **优点**：无障碍一致。
- **缺点 / 代价**：与组件自定义 ring 冲突。
- **影响面**：分层=**壳**｜文件=`theme.css`｜工作量=0｜依赖=无｜回归风险=**中**（已用 `box-shadow: none !important` 压制，见 `theme.css:478` 注释；**新增组件若自画 ring 会撞**）｜门禁=视觉回归 + a11y 抽查。
- **建议**：**保持**，但新增交互组件需知道这条压制。
- **证据**：`theme.css:478,483-486`。

### A5 · 0.5px 发丝描边 + 双层柔光高程 `dsh` · **保持**

- **状态**：已落地 —— `theme.css:162`（「发丝高程三件套：0.5px 描边画进 box-shadow 不占布局」）。
- **优点**：描边不占布局（box-shadow 实现），高程有层次。
- **缺点 / 代价**：半像素在高 DPI 可能糊。
- **影响面**：分层=**壳**｜文件=`theme.css`｜工作量=0｜依赖=无｜回归风险=低（被组件局部 box-shadow 覆盖时失效）｜门禁=视觉回归。
- **建议**：**保持**。
- **证据**：`theme.css:162`。

### A6 · ContextMeter / TurnNavigator / TextShimmer `dsh` · **保持**

- **状态**：已落地（**vendor 等价物**，非 dsh 原版移植）——
  `vendor/zcode/ui/src/chat-input-toolbar/contextUsage.tsx`（ContextMeter）、
  `vendor/zcode/ui/src/v4/ConversationTurnNavigator.tsx`（TurnNavigator）、
  `vendor/zcode/ui/src/components/ai-elements/shimmer.tsx`（TextShimmer）。
- **优点**：免移植，随 vendor 维护。
- **缺点 / 代价**：是 ZCode 实现而非 dsh 原版，行为/外观以 vendor 为准。
- **影响面**：分层=**壳 / vendor**｜文件=上述 vendor 组件｜工作量=0｜依赖=vendor 上游｜回归风险=低｜门禁=vendor CHECKLIST 对账。
- **建议**：**保持**。要改 = 改 vendor（PATCHES 登记制）。
- **证据**：三文件路径（`grep ContextMeter|TurnNavigator|Shimmer` 定位）。

### A7 · 字号一等设置 `dsh` · **保持（量程见 D1）**

- **状态**：已落地 —— `vendor/zcode/ui/src/lib/uiFontSize.ts:4-6`（`DEFAULT=14`、`MIN=12`、`MAX=20`）+ `SettingsPage.tsx:398-399,1827-1838` 滑杆。
- **优点**：全站缩放，只动 `--ui-font-size` 基准，**不连带缩放图标/间距/圆角**（设计正确，`:26-27` 注释）。
- **缺点 / 代价**：量程 12–20 窄于 dsh 的 10–22。
- **影响面**：分层=**壳 / vendor**｜文件=`uiFontSize.ts` + SettingsPage｜工作量=0｜依赖=vendor｜回归风险=低｜门禁=vendor CHECKLIST。
- **建议**：**保持**；量程是否放宽见 **D1**。
- **证据**：`uiFontSize.ts:4-6,21-28`。

### A8 · 行级虚拟化时间线 `opencode web` · **已落地（vendor 提供）** ← 更正项

- **状态**：**已落地**（旧版误判为「部分/未落地」）。vendor 会话时间线**已有**行级虚拟化：
  `vendor/zcode/ui/src/v4/ConversationTimeline.tsx:22,784-790`（`useVirtualizer({ count: virtualizedUnits.length, overscan: ROW_OVERSCAN, measureElement, scrollMargin })`），
  `ROW_OVERSCAN = 8`（`:112`），行高缓存 `timelineRowHeightCache.ts:13-15`（估算 72px，缓存上限 4000），
  末轮 live tail 拆分 `conversationTimelineLiveTail.ts:19-29`，接线 `SessionPane.tsx:184,5605`。
- **优点**：超长会话 DOM 只挂可见窗口（实测 brief `:43` 亦据此写「虚拟化列表 DOM 只挂可见窗口」）。
- **缺点 / 代价**：无（vendor 承担）。
- **影响面**：分层=**壳 / vendor**｜文件=vendor v4 时间线｜工作量=0｜依赖=vendor｜回归风险=低｜门禁=vendor CHECKLIST。
- **建议**：**保持**。**注意**：DOM 面已解决，但**数据面仍全量**——那才是瓶颈，见 **B7**。
- **证据**：`ConversationTimeline.tsx:22,112,784-790`；`SessionPane.tsx:5605`；`timelineRowHeightCache.ts:13-15`。

---

### B1 · RiskConfirmation 独立组件 `dsh` · **不做独立组件**

- **状态**：独立组件未落地（全库 `RiskConfirmation` 0 命中）；**概念**由 U1 的 approval/question dock 覆盖（`web-next/src/zcode-services/pendingInteractions.ts`）。
- **优点**：危险操作独立二次确认的视觉模式。
- **缺点 / 代价**：与 U1 的 dock **功能重叠**——dock 已承载「权限问询 + 三键应答」；再加一套 = 两套确认模型，认知与维护双份。
- **影响面**：分层=**壳**｜文件=vendor 交互面 + `pendingInteractions.ts` 投影层（会**与 dock 争同一槽位**）｜工作量=S–M｜依赖=无｜回归风险=**中**（确认模型分叉）｜门禁=权限 dock 联调。
- **建议**：**不做独立组件**。语义已由 dock 覆盖；若未来要更强风险语义，给现有 approval 卡加 `risk` 元数据即可（S）。
- **证据**：`grep -ri riskConfirm` 0 命中；`pendingInteractions.ts:1,46-49`。

### B2 · Markdown 渲染进 Worker `opencode web` · **待裁决（实测驱动）**

- **状态**：未落地。vendor markdown 走**主线程** `streamdown`（`vendor/zcode/ui/src/components/ai-elements/message.tsx:13-16,42,429`），**无 markdown Worker**；ocrc 自有 markdown 仅分享页闭包用（`web-next/src/lib/markdown/sanitize.ts`，主线程 marked+hljs+DOMPurify）。
- **优点**：长 Markdown / 大 diff 解析不卡主线程。
- **缺点 / 代价**：Worker 生命周期 + 消息序列化成本；测试面复杂化；vendor 是前端本体后，ocrc 的 markdown 组件只在分享页用，套 Worker 要绕开 vendor 渲染路径。
- **影响面**：分层=**壳**｜文件=`web-next/src/lib/markdown/`（现仅分享页消费）｜工作量=M｜依赖=**需先有实测瓶颈**｜回归风险=中｜门禁=双端测试 + 分享页 E2E。
- **建议**：**待裁决，实测驱动**。**注意**：实测显示瓶颈在数据面（B7）而非 markdown 解析——markdown 解析耗时**从未被测量**（全仓无数据）。无数据不做。
- **证据**：`message.tsx:13-16,42,429`；`sanitize.ts:1-18,57`；`ShareLanding.tsx:52-54`；`harness-best-of.md` 旧 §4.2 自述「需先有实测瓶颈」。

### B3 · 主题即 JSON `opencode web` · **不做**

- **状态**：未落地（`theme.*json` 0 命中）。主题走 CSS token 文件。
- **优点**：主题可运行时导入导出 / 分发。
- **缺点 / 代价**：为「运行时主题市场」服务，ocrc **无多主题分发需求**；现有 CSS token 已实现明暗双主题 + 回肤取用（persimmon 封存 `web-next/src/styles/persimmon-theme.css`）。
- **影响面**：分层=**壳**（且要重写 `theme.css` 架构）｜文件=`theme.css` 全线｜工作量=L｜依赖=无｜回归风险=**高**（与 M9 冻结的配色口径冲突）｜门禁=全站视觉回归。
- **建议**：**不做**。判据：无需求 + 与冻结口径冲突 + 收益为零。
- **证据**：`grep theme.*json` 0 命中；`theme.css:1-20`（token 架构 + M9 裁决）。

### B4 · CSP + 主题脚本哈希 `opencode web` · **不做**

- **状态**：未落地（CSP/哈希 0 命中；`web-next/src/lib/insecure-context.ts` 的 sha256 是 FIPS 回退，与 CSP 无关）。
- **优点**：严格 CSP 防 XSS；脚本哈希免 nonce。
- **缺点 / 代价**：构建期产哈希 + 注入；CSP 会限制 inline `<style>` / style 属性 → 与 vendor 注入样式面冲突（需逐块哈希或 nonce）；**威胁模型不匹配**（LAN/内网 + 单用户自用）。
- **影响面**：分层=**壳 + 分发**（构建链 vite + 部署）｜文件=vite 配置 + `index.html`｜工作量=M｜依赖=无｜回归风险=**高**（CSP 一开 vendor 注入样式可能全挂，需实测）｜门禁=构建 + 全站冒烟。
- **建议**：**不做**。判据：威胁模型不匹配 + 与 vendor 冲突。
- **证据**：`grep -i 'csp|content-security'` 0 命中；`insecure-context.ts:18-23,80-92`（另一回事）。

### B5 · 媒体输出 document / video / audio `grinev` · **待裁决（按需）**

- **状态**：**部分**。图片相册已落地（M8-2：`src/transport/telegram/index.ts:736-751`，cap 3，逐张 `sendPhoto`）；document / video / audio 未接。
- **优点**：完整媒体回传（不止图片）。
- **缺点 / 代价**：TG 各类型尺寸/格式限制；host 要读任意文件并判 mime；**安全面**（任意文件外发要白名单 + 大小门禁）。
- **影响面**：分层=**核心**（transport）｜文件=`src/transport/telegram/index.ts`｜工作量=S–M｜依赖=文件类型白名单 + 大小门禁｜回归风险=低（加法）｜门禁=TG 联调。
- **建议**：**待裁决，按需**。图片相册已覆盖多数场景；有真实需求再接。
- **证据**：`index.ts:736-751`；`grep sendDocument|sendVideo|sendAudio` 0 命中。

### B6 · 知识库→资产化闭环 `OpenCode-Client` · **不做**

- **状态**：不做（本体）。
- **优点**：知识资产化（若有需求）。
- **缺点 / 代价**：越界到**通用知识管理**，与「驾驶舱」定位不符；会引入新存储/索引子系统（**核心膨胀**）。
- **影响面**：分层=**核心**（会新增子系统）｜文件=新模块｜工作量=L｜依赖=无｜回归风险=高（核心膨胀）｜门禁=—
- **建议**：**不做**。判据：PRODUCT 第五条「明确不做」已裁 + 越界。
- **证据**：`docs/PRODUCT.md:162`（明示「知识库本体不做」）。

### B7 · ocrc 桥接数据面窗口化（自省项）· **待裁决** ← 新增

- **状态**：未落地。性能实测把瓶颈指向 ocrc **自己的数据管道**：
  历史取数固定 `?limit=200` **无 offset**（`web-next/src/zcode-services/zcodeAgentService.ts:49`）；
  `buildRows` 对**全部** cards 重建、无 slice（`:505`，调用点 `:766,1118,1422,1442`）；
  快照全量携带 `seq = rows.length`（`:775`）、`rows.window = rows`（`:809`）；
  liveUpdate 每次 refetch→全量 rebuild→按键 diff（`:1059,1118-1161`，去抖 250ms）。
- **优点**：窗口化可去掉全量 rebuild/快照的开销（实测 longtask 残余 **1×137ms**，未达 <16ms 验收线，
  `docs/perf-remediation-brief.md:63`）。
- **缺点 / 代价**：动的是桥接核心路径，波及 liveUpdate / 快照 / rowsRange；「加载更早」现受限于同一
  200 消息窗（`ocrcHistory` 无 offset 透传），窗口化要连带上游 offset。
- **影响面**：分层=**核心**（桥接层，非 vendor）｜文件=`zcodeAgentService.ts`（+ 可能 `src/transport/web/routes/session.ts:14-18` REST 钳制）｜工作量=M–L｜依赖=历史接口补 offset｜回归风险=**高**（流式插入 + 滚动锚定 + 历史回看是 P0 行为）｜门禁=隔离栈 E2E + 长会话实测复跑。
- **建议**：**待裁决**。**这项比 B2 更该优先**——瓶颈证据在它身上，不在 markdown。
- **证据**：`zcodeAgentService.ts:49,505,766,775,809,1059,1118-1161`；`perf-remediation-brief.md:43-63`；旧控制台 569 卡冻结轶事 `src/core/history.ts:104-108`（窗口代码已退役）。

---

### D1 · 字号量程 12–20 vs dsh 10–22 · **维持**

- **选项 A**：维持 12–20（零改动）。**选项 B**：放宽到 10–22（改 vendor `uiFontSize.ts:5-6` 两个常量，S 级）。
- **优点（B）**：与 dsh 寄存器一致，用户可选更小/更大。
- **缺点 / 代价（B）**：改 vendor 需 PATCHES 登记 + CHECKLIST 对账；纯偏好改动是长期维护税。
- **影响面**：分层=**壳 / vendor**｜文件=`uiFontSize.ts`｜工作量=S｜依赖=vendor PATCHES 流程｜回归风险=低｜门禁=vendor CHECKLIST + 视觉抽查。
- **建议**：**维持**。理由：dsh 的 10–22 是参考值非硬需求；为对齐参考值改 vendor 不划算。**除非**「12–20 太窄」是你自己用着不爽的真实痛点——那另算（Q2 的「真实需求」）。
- **证据**：`uiFontSize.ts:5-6`。

### D2 · future adapter 命名「pi」· **改判更准确**

- **选项 A**：维持裸名「pi」。**选项 B**：改判为「omp（首选）/ gjc」。
- **优点（B）**：与事实一致——**pi 本体无 ACP**，接不进现有 `AcpBackend`。
- **缺点 / 代价（B）**：要动 `PRODUCT.md:15` / `ARCHITECTURE.md:78` 的宪法文本。
- **影响面**：分层=**文档**｜文件=`PRODUCT.md:15`、`ARCHITECTURE.md:78`｜工作量=S｜依赖=D2 的裁决｜回归风险=无（文本）｜门禁=—
- **建议**：**改判为 omp / gjc**（更准确）。**是否立项**另议（见 E 组）；立项第一步 = omp 平台验证。
- **证据**：`PRODUCT.md:15`、`ARCHITECTURE.md:74-82`；§4 的 pi 调研。

---

### E1 · omp（`can1357/oh-my-pi`，MIT，★35k）· **首选**

- **协议入口**：**有 `omp acp`**（JSON-RPC stdio；写操作经 `session/request_permission` 门控；`modes/acp/acp-mode.ts`）——代码 + 文档双证。
- **优点**：fs/terminal 路由 + 权限门最完整 → 接现有 `AcpBackend` 迁移成本最低；内嵌 ripgrep/bash 免 fork-exec。
- **缺点 / 代价**：含 **Rust N-API 原生扩展** → 需跨平台预编译工件，**EL7 / glibc 2.17 下限有风险**；fork 生态，长期维护不确定。
- **影响面**：分层=**核心**｜文件=`src/cli/host-backends.ts`（注册）+ 复用 `acp-backend.ts`｜工作量=M｜依赖=omp 二进制在目标平台（x86_64/arm64/EL7）可得｜回归风险=**低**（`OCRC_BACKENDS` 选择，纯加法）｜门禁=隔离栈 E2E + 权限 dock 联调。
- **建议**：**立项时首选**，但先做「omp 在目标平台能否运行」的可行性验证（半日）。
- **证据**：omp 仓库/文档（desk research，2026-10-11）；`host-backends.ts:82-99`、`backend.ts:192-326`。

### E2 · gjc（`Yeachan-Heo/gajae-code`，MIT，★2.9k）· **次选**

- **协议入口**：**有 `gjc acp`**（stdio 前端）；文档含 initialize 握手。
- **优点**：外部控制面克制（broker + capability-scoped attachment，凭据不外露）。
- **缺点 / 代价**：`gjc acp` 是**薄前端**，依赖**常驻 SDK broker 守护进程** → 多一个进程要纳入 adopt/spawn 生命周期模型；运行时用 Bun。
- **影响面**：分层=**核心 + 宿主**｜文件=AcpBackend 路径 + 进程生命周期｜工作量=M–L｜依赖=broker 常驻｜回归风险=低（加法），主要复杂点=broker 生命周期｜门禁=隔离栈 E2E。
- **建议**：**次选**；除非 omp 平台验证失败。
- **证据**：gjc 仓库/`docs/acp-local-development.md`（desk research）。

### E3 · pi / senpi 本体 · **不作首选**

- **协议入口**：**无 ACP**。pi 的 RPC 是**自定义 JSONL（非 JSON-RPC）**；senpi 有 app-server（Codex 兼容 JSON-RPC over WS/stdio/unix，`senpi app-server --listen ws://127.0.0.1:18990`）。
- **优点**：pi 极简核心、extension/skill/theme 机制；senpi app-server 适合无头托管。
- **缺点 / 代价**：本体无 ACP → pi 自建桥 **L**；senpi app-server 是 **WS JSON-RPC，非 opencode HTTP 形状** → 无法复用 `OpencodeBackend`，新写适配层 **M–L**。
- **影响面**：分层=**核心**（新适配层，非 AcpBackend）｜文件=新 backend｜工作量=L（pi）/ M–L（senpi）｜依赖=协议桥稳定性；senpi 线另需 **SUL-1.0（非 OSI）法务复核**｜回归风险=低（加法）｜门禁=隔离栈 E2E。
- **建议**：**不作首选**。
- **证据**：pi `docs/rpc.md`、senpi `docs/app-server.md`（desk research）。

## 3. HarnessAdapter 现状

- **接缝**：docs 名 **HarnessAdapter**（0.27 规划），代码实为 `AgentBackend`：`src/core/agent/backend.ts:192-326`。
- **三实现**：`OpencodeBackend`（`opencode-backend.ts`，SDK typed routes + raw `ocFetch`，pin 1.18.x）·
  `AcpBackend`（`acp-backend.ts`，stdio ACP，自持事件源 + 自持久化 + tombstone + `session/load` 重同步）·
  `V2Backend`（`v2-backend.ts`，ctx 域调用，能力多关、诚实空实现）。
- **注册**：`src/cli/host-backends.ts:82-99`，经 `OCRC_BACKENDS` 选择。**成本边界**：`docs/ARCHITECTURE.md:431-434`。
- **已知先例**：kimi 探针硬编码 `host-backends.ts:44-69`。
- **ACP tradeoff（决定性）**：ACP 系**无法复刻 opencode 的 live shared session**——「用户在自己终端里跑、
  ocrc 旁路同看同一会话」只有直连 opencode HTTP API 才有（`docs/research/ACP_BACKEND_DESIGN.md:318-337`）。
  任何新 harness 走 ACP 都得接受这个降级。

## 4. pi 家族 desk research 事实（2026-10-11）

> 方法注：本机 WebFetch 提取层失效，改用只读 `curl` + `gh api`，零写操作；陈述可溯源。

| 名字 | 仓库 | 作者 / 组织 | 许可证 | ★ | npm | 配置目录 |
|---|---|---|---|---|---|---|
| **pi** | `earendil-works/pi`（原 `badlogic/pi-mono`） | Mario Zechner（@badlogic） | MIT | 114k | `@earendil-works/pi-coding-agent`（bin `pi`） | — |
| **senpi** | `code-yeongyu/senpi` | code-yeongyu | MIT | 476 | `@code-yeongyu/senpi` | `~/.senpi/agent` |
| **omp** | `can1357/oh-my-pi`（Stencil Labs） | can1357 | MIT | 35k | `@oh-my-pi/pi-coding-agent` v18.9.2（bin `omp`） | `~/.omp/agent` |
| **gjc** | `Yeachan-Heo/gajae-code` | Yeachan-Heo | MIT | 2.9k | `gajae-code` v0.18.9（bin `gjc`） | — |

- 四者都是 **pi-mono 后代**（senpi/omp 明示 fork，gjc 有 `docs/porting-from-pi-mono.md`）；「共享会话格式」
  说法成立，但**四者交叉兼容无直接测试证据**（不确定）。
- **senpi-task**：npm/PyPI 均 404；实为 OmO 仓库内**私有包** `@oh-my-opencode/senpi-task`。
- **OmO v5 关系（已验证）**：OmO README 原文 "It runs on senpi, our fork of pi"（★70k，npm v5.1.30，
  **license SUL-1.0 / 非 OSI**）；印证 `docs/next-phase.md:14-15`。
- **假阳性已排除**：Inflection Pi（pi.ai）、Raspberry Pi、npm `pi-ai`、Senpi-ai（Hyperliquid）、`senpi_ebi`。

**集成面**：pi = 严格 JSONL（非 JSON-RPC），**无 ACP**；senpi = 继承 pi + app-server（WS JSON-RPC）；
omp = `omp --mode rpc`（NDJSON）+ **`omp acp`**；gjc = **`gjc acp`**（薄前端 + 常驻 broker）。
**还差验证**：① 实跑 `omp acp`/`gjc acp` 握手 + 权限流；② senpi app-server 长连接/多会话；③ 四 fork 会话格式互操作；
④ 版本锁定（senpi 日历版本、`senpi-task` 私有不可 pin）；⑤ OmO 的 SUL-1.0 法务复核（若走 senpi 线）。

## 5. 裁决记录（随 grill 更新）

| ID | 项 | 我的建议 | 用户裁决 | 日期 |
|---|---|---|---|---|
| — | （待 grill 填写） | — | — | — |
