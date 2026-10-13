# harness 优点吸收总账（best-of）

> **用途**：把散落在五处的「合并各家优点」记录收口成一张**逐项可查、可裁决**的账。
> **怎么翻**：每一项有**稳定 ID**（`A1`…`E3`）。索引在 §1，逐项详表在 §2。
> **搜 ID（如 `B1`）即定位**——不要靠标题翻，靠 ID。
> **口径**：只记**事实 + 证据**（`file:line` / commit）。建议分「做 / 不做 / 待裁决」并附理由；
> 结论只作裁决输入，`docs/PRODUCT.md` / `docs/ARCHITECTURE.md` 的既有裁决文本不在本文件擅改。
> **裁决已收口（2026-10-12）**：22 项全部裁决见 §5；D2 的文本改判已随批次 0
> 落进 `PRODUCT.md:15` / `ARCHITECTURE.md:76-78`。
> **生成方式**：全库 grep 抽查 + 定向 desk research（非逐行重读四家源码）。全历史
> 「融合 / 对标 / 优点 / 选型」0 命中——本文件即首份收口。

## 0. 五处记录索引

| # | 位置 | 内容 | 在 ocrc git? |
|---|---|---|---|
| 1 | `docs/PRODUCT.md:157-164` | 参照系：六家吸收清单（ZCode / dsh / opencode web / OpenCode-Client / grinev / anomalyco opencode） | ✅ |
| 2 | `docs/PRODUCT.md:15` + `docs/ARCHITECTURE.md:74-82` | HarnessAdapter seam：opencode 1.18 首个适配器；opencode V2、**omp（原生 ACP）/ pi（经第三方桥 pi-acp）/ gjc** 为后续适配目标（2026-10-12 改判，原裸名「pi」） | ✅ |
| 3 | `/home/demo/OCWF/docs/ocrc-fork-development-plan.md:44-56` | 参考三角（OCRC fork / zcode bots / dsh-remote-web-ui）+ OmO 迁移闸门 | ❌ **外部本地库**（不在本仓库） |
| 4 | `docs/next-phase.md:14-15` | OmO 上游已迁 senpi 自有引擎（v5.1.x 全系） | ✅ |
| 5 | `NOTICE:20-28` + `web-next/src/styles/theme.css:12` + commit `66ddc0fb` | 落地证据（归属声明 / 寄存器出处 / 最早移植提交） | ✅ |

## 1. 名册与索引（ID 总表）

> 同一项只出现一次（旧版把「主题即 JSON / CSP / RiskConfirmation」在未落地组和不做组各列一遍，
> 是「翻不到」的原因之一）。每项的「做不做」结论写在**该项自己的条目**里。

### A 组 · 已落地（要过的是「维护 / 回退」，不是「做不做」）

| ID | 项 | 来源 | 状态 | 建议 | 详表 |
|---|---|---|---|---|---|
| A1 | 三层语义令牌 static→alias→specific | dsh | 已落地 | 保持 + **stylelint 令牌约束**（批 1 已落） | §2 |
| A2 | superellipse 全局表 | dsh | 已落地 | 保持（渐进增强） | §2 |
| A3 | 滚动条全局表 | dsh | 已落地 | 保持 | §2 |
| A4 | 焦点环全局表 | dsh | **已修复**（批 1） | 恢复 `:focus-visible` 环（WCAG 2.4.7 / F78） | §2 |
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
| B2 | Markdown 渲染进 Worker | opencode web | 未落地 | **复核后暂不重开**（demap：热点主要在 vendor Mermaid/CSS 解析，markdown 库约 13–17%；需另出 vendor 优化计划） | §2 |
| B3 | 主题即 JSON | opencode web | 未落地 | **不做**（代码主题面板 vendor 已有） | §2 |
| B4 | CSP + 主题脚本哈希 | opencode web | **已落地**（批 3） | 头下发 + nonce + 实测 0 违规（enforce） | §2 |
| B5 | 媒体输出 document / video / audio | grinev | **已落地**（批 4） | 白名单分类 + mime 双信号 + 上限 + 注入式投递 | §2 |
| B6 | 知识库→资产化闭环 | OpenCode-Client | 不做（本体） | **不做** | §2 |
| B7 | **ocrc 桥接数据面窗口化** | （自省项，非别家特性） | **已落地**（批 2） | 尾部快照 + offset 翻页 + 单调行 id + 终态工具缓存 | §2 |
| B8 | 非图片附件上行 | OpenCode-Client（此前未列） | **已落地**（批 5） | 两道门禁拆除 + 落盘/路径注入 + 白名单/上限/staging | §2 |
| B9 | **OpenCode-Client 前后端缺口** | OpenCode-Client | **已回填**（批 6） | vendor 扩展分区插槽 + 4 个设置面 | §2 |

> **B7 新增 / B8 补列**：B7 是自省项——性能实测把瓶颈指向 **ocrc 自己的数据管道**
> （全量 rebuild / 全量快照 / 无 offset），不是别家特性；B8 此前只在 grill 口头过、
> 没进名册，本轮补上（TG 通道已有非图片收件先例，web 侧两道自设门禁挡着）。

### D 组 · 跨项决策

| ID | 决策 | 选项 | 建议 | 详表 |
|---|---|---|---|---|
| D1 | 字号量程 12–20 vs dsh 10–22 | 维持 / 放宽 | **维持** | §2 |
| D2 | future adapter 命名「pi」 | 维持 / 改判 | **改判**：omp（原生 ACP）/ pi（经第三方桥 pi-acp）/ gjc；文本已改 | §2 |

### E 组 · pi 家族适配器候选

| ID | 候选 | 协议入口 | 建议 | 详表 |
|---|---|---|---|---|
| E1 | omp（`can1357/oh-my-pi`，MIT） | `omp acp` ✅ | **只备料**（立项时首选） | §2 |
| E2 | gjc（`Yeachan-Heo/gajae-code`，MIT） | `gjc acp` ✅ | **只备料**（立项时次选） | §2 |
| E3 | pi 本体 | 官方无 ACP；**第三方桥 `@automatalabs/pi-acp` 存在** | **只备料** | §2 |

## 2. 逐项详表

> 影响面六维：**分层**（PRODUCT 第二条：核心/壳/宿主/分发）· **文件** · **工作量**（S<1 人日 / M 1–3 / L>3）·
> **依赖** · **回归风险**（是否撞冻结项：配色口径、右栏≥中栏、EL7 下限、air-gap、发布冻结）· **门禁**。

---

### A1 · 三层语义令牌 `dsh` · **保持**

- **状态**：已落地 —— `web-next/src/styles/theme.css:12-17,32,65,192`（LAYER 0 static / LAYER 1 alias / LAYER 2 specific）。
- **优点**：组件只消费 alias 层 → 换肤零改组件（M9 换色已验证）。
- **缺点 / 代价**：多一层间接，新人找值要跳三层；LAYER 0 raw 值与 ZCode verbatim 强耦合。
- **影响面**：分层=**壳**｜文件=`theme.css`（单文件）｜工作量=0（已落地）｜依赖=无｜回归风险=**token 名是冻结契约，改名波及全部组件**｜门禁=视觉回归（CDP）。
- **建议**：**保持** + **stylelint 令牌约束（批次 1 已落地）**。落地形态：`web-next/stylelint.config.js`
  用内置 `color-no-hex`（对声明值全域，含简写/自定义属性），只扫 `src/**/*.css`；
  豁免两个文件——`styles/theme.css`（token 定义层）与 `styles/persimmon-theme.css`（封存色板）。
  接入 `npm run lint`。**双向验证**：全仓现值 0 error；探针文件写 `#ff0000`/`#abc` → 2 error（门禁确实咬人）。
- **证据**：`theme.css:12-17`（层次说明）、`:32/:65/:192`（三层分节）；`web-next/stylelint.config.js`、`web-next/package.json`（lint script）。

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

### A4 · 焦点环全局表 `dsh` · **修 → 已落地**（批次 1，2026-10-12）

- **原状**：`theme.css:475-487` 全局清空 `outline` 与 focus ring 的 `box-shadow`
  （vendor `styles.css:148-153` 同款，且 vendor 表**后于**本表加载）。
- **缺陷定性（裁决依据）**：全局移除焦点可视指示 = **WCAG 2.2「2.4.7 Focus Visible」失败**，
  官方文档记载的经典失败模式 **F78**；非文本对比度要求 **1.4.11 ≥3:1**（2026-10-11 核查）。
- **落地（批次 1）**：① 新增 LAYER 1 语义 token `--focus-ring: var(--info)`（dark / light 显式 /
  light media 三块同步，KEEP-IN-SYNC 契约）；② 新增 `*:focus-visible:focus-visible { outline: 2px solid
  var(--focus-ring) !important; outline-offset: 2px }` —— 伪类写两遍 = 特异性 (0,2,0)，
  压过 vendor 与本文清除表的 (0,1,0) `!important`（不论加载顺序）。文件在 ocrc 层，**vendor 零改动**。
- **验证（隔离栈 4199 CDP，2026-10-12）**：Tab 走查 **29/29 停点全部有 2px `rgb(11,127,255)`(=--info)
  环**、`outline-offset: 2px`、0 页面错误；最小对照页确认鼠标启发式标准——plain button 鼠标点击无环
  （`:focus-visible=false`）、文本输入点击有环（Chromium 标准）；配对观察：html 令牌随系统 light 分支、
  vendor 壳自持 dark（`#161616`）→ 环在该底上对比度 **4.74:1**（亮底 3.6:1）均 ≥3:1。
  已知提示：自动聚焦的输入框（composer/搜索框）首帧即带环——文本输入的标准语义，保留。
- **影响面**：分层=**壳**｜文件=`web-next/src/styles/theme.css`（+ theme token 三处）｜工作量=S｜
  回归风险=**中**（vendor 组件密集用 `focus:outline-*` 工具类，可能出现双环——CDP 走查未见）｜门禁=CDP 键盘走查（已过）。
- **证据**：原块 `theme.css:475-487`；现规则 `theme.css:490-495`；vendor 对照 `styles.css:148-161`；
  走查产物 `/tmp/ocrc-focus-walk/summary.json`（29/29）；WCAG 2.4.7 / 1.4.11 / F78。

### A5 · 0.5px 发丝描边 + 双层柔光高程 `dsh` · **保持**

- **状态**：已落地 —— `theme.css:162`（「发丝高程三件套：0.5px 描边画进 box-shadow 不占布局」）。
- **优点**：描边不占布局（box-shadow 实现），高程有层次。
- **缺点 / 代价**：半像素在高 DPI 可能糊。
- **影响面**：分层=**壳**｜文件=`theme.css`｜工作量=0｜依赖=无｜回归风险=低（被组件局部 box-shadow 覆盖时失效）｜门禁=视觉回归。
- **建议**：**保持**，**不预改**。调研注（2026-10-11）：Windows 分数缩放（125% / 150%）下 0.5px 的
  实际渲染行为**本轮查不到权威结论（未验证）**；既然「糊」只是可能而非已知事实，预改（改阈值/换实现）
  是猜。判据改为：**观察到糊再调**，并把当时的 OS/缩放比归档。
- **证据**：`theme.css:162`；分数缩放结论=未验证。

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

### B2 · Markdown 渲染进 Worker `opencode web` · **做 → 复测后判「不做」→ demap 复核后暂不重开**（批 2c 2026-10-12；R1 复核 2026-10-13）

- **状态**：未落地。vendor markdown 走**主线程** `streamdown`（`vendor/zcode/ui/src/components/ai-elements/message.tsx:13-16,42,429`），**无 markdown Worker**；ocrc 自有 markdown 仅分享页闭包用（`web-next/src/lib/markdown/sanitize.ts`，主线程 marked+hljs+DOMPurify）。
- **原 C 项 chunk 归因作废**：生产构建把 markdown、vendor UI 与 ocrc bridge 合并进同一 `mermaid-*.js`（9,460,746B ≈ 9.02MiB），不能用 chunk 名把 bridge 或 markdown 单独归因；旧台账中「入口 chunk（React+桥接）7–11%」和「markdown 家族 67–76%」均撤回。
- **R1 demap 测量（2026-10-13，隔离栈 4199，三轮独立复跑）**：`scripts/perf-md-attribution.mjs` 读临时 sourcemap、按原始模块路径聚合（map 不入库、不作为产品构建产物；`demapAvailable` 按目录实际含 map 判定）。会话 254 卡 / 309–328 行；**宿主负载波动大（load 4–5），单轮绝对毫秒不可比，取跨轮范围**：
  · **W1a 无 Mermaid**（JS 忙时 0.86–1.59s）：markdown/mermaid 库 **18–22%**；vendor UI 17.5–27.3%；ocrc bridge **2.0–3.2%**；top 单点 `@radix-ui/react-presence:168`（118–594ms）。
  · **W1b 含 Mermaid**（JS 忙时 1.99–3.18s）：vendor UI **42–60%**（主要就是 `mermaid-block`）；markdown/mermaid 库 **13–17%**；ocrc bridge **0.4–0.6%**。
  · demap 覆盖率：已映射 88–89% 的 JS 忙时，未映射 ≤1.3ms（其余为 native/engine 帧）。
- **热点定位（三轮一致）**：W1b top files 恒为 vendor `mermaid-block.tsx:118`（`resolveCssColor`）与 `:84`（`normalizeCssColorForMermaid`），单轮各 324–718ms；其次 Mermaid core 与 `ConversationTimeline.tsx:1776`。**不是 ocrc `buildRows`/`diffRows`**——最直接的优化边界是 vendor Mermaid/CSS 颜色归一化。
- **W3 live tick（最大窗口前插后，三轮一致形态）**：服务端卡片 `254 → 256 → 258 → 260`，行数随窗口平移（`321→300→303→306` / `309→312→315→318` 两种形态），3 个 tick HTTP 200；bridge 占 JS 忙时 **2.2–2.8%**（13.5–19.1ms / 490–864ms）。**longtask 不恒定**：部分轮次 0 条、部分轮次 3–5 条（54–370ms，热点同为 `react-presence`/`react-dom`/`ConversationTimeline`，非 bridge）。该窗口此前曾被冻结，见 B7 R1 修复。
- **结论（数据驱动）**：**B2 暂不重开**。markdown 库本身只占 13–22%，可复现的主要热点是 vendor `mermaid-block` 的 CSS 颜色归一化（vendor 面；若继续优化，应另出 vendor 计划并登记 PATCHES/CHECKLIST）。`buildRows` 增量重建条件（bridge tick >30%）未满足，W3 实测 2.2–2.8%。
- **影响面**（未来若做）：分层=**vendor 面**｜文件=`vendor/zcode/ui/src/components/ai-elements/mermaid-block.tsx` 与相关 Mermaid 渲染；工作量=M｜回归风险=中｜门禁=vendor PATCHES/CHECKLIST + 时间线渲染 E2E + demap 脚本复跑。
- **证据**：`vendor/zcode/ui/src/components/ai-elements/mermaid-block.tsx:84,118`；`scripts/perf-md-attribution.mjs`；`/tmp/ocrc-perf/md-attribution.json`；`perf-remediation-brief.md:63`。

### B3 · 主题即 JSON `opencode web` · **不做**（2026-10-12 复核维持）

- **状态**：未落地（`theme.*json` 0 命中）。主题走 CSS token 文件。
- **复核澄清（用户问「现在是什么样的」）**：**代码主题面板 vendor 早已有**——`codePreviewPreferences.ts:11-20`
  十个主题（GitHub Light/Dark、Vitesse、Minimal、GitHub HC、Catppuccin）+ 行号/换行/代码字号，
  挂在设置页「外观」分区（`settingsCodePreview.tsx`）。用户截图看到的正是我们自己的 vendor 面板。
  B3 指的是**主题即 JSON 文件格式**（运行时导入/导出/分发），与「能不能切主题」无关——切主题已可用。
- **优点**：主题可运行时导入导出 / 分发（面向主题市场）。
- **缺点 / 代价**：为「运行时主题市场」服务，ocrc **无多主题分发需求**；现有 CSS token 已实现明暗双主题 + 回肤取用（persimmon 封存 `web-next/src/styles/persimmon-theme.css`）。
- **影响面**：分层=**壳**（且要重写 `theme.css` 架构）｜文件=`theme.css` 全线｜工作量=L｜依赖=无｜回归风险=**高**（与 M9 冻结的配色口径冲突）｜门禁=全站视觉回归。
- **建议**：**不做**。判据：无需求 + 与冻结口径冲突 + 代码主题面板已有。
- **证据**：`grep theme.*json` 0 命中；`theme.css:1-20`（token 架构 + M9 裁决）；`codePreviewPreferences.ts:11-20`。

### B4 · CSP + 主题脚本哈希 `opencode web` · **做 → 已落地（enforce）**（批次 3，2026-10-12）

- **改判依据**：原判「不做」的理由是「威胁模型不匹配（LAN/单用户自用）」；用户裁决：**有内网合规需求**——
  企业内网受控环境中 CSP 头是合规门槛，不是自选加固。
- **落地（标准两步走，本批走完）**：
  1. **Report-Only 收集**（隔离栈实测 25 条，全部归因）：`script-src-elem` ×1 =
     HTML 里的**外链入口脚本**被 `'strict-dynamic'` 拒（strict-dynamic 下主机白名单被忽略，
     入口脚本只能靠 nonce/hash）；`script-src` ×24 = mermaid 的 `eval` 与 wasm 模块求值。
     **零** style/img/connect/font 违规（说明策略面选得够）。
  2. **补齐后强制**：host 每响应生成一枚 nonce，**文档由 host 渲染**（`/`、`/index.html`、
     `/next/`、SPA 回落都注入 nonce，静态直出改为渲染路径）+ 策略放行
     `'wasm-unsafe-eval'`（wasm 预览引擎）与 `'unsafe-eval'`（mermaid）——后者**如实登记为代价**：
     它削弱 eval 类注入面，是既有前端栈（mermaid/wasm）的客观需要，不是策略疏漏；
     `style-src` 仍需 `'unsafe-inline'`（shiki/KaTeX/mermaid 往 innerHTML 写 style 属性）。
- **验证（enforce，隔离栈 CDP）**：`/z/` 壳 + 设置页 5 分区 + 会话时间线 → **0 违规 / 0 console 错误**；
  分享只读页（另一套 bundle）→ **0 违规**；同一响应内头 nonce 与文档 `<script nonce>` 配对一致；
  头由 host 下发（非 `<meta>`）。单测 11 条（哈希抽取/策略组装/模式解析/nonce 注入幂等）。
- **运维开关**：`OCRC_CSP=enforce|report|off`，**默认 enforce**；`report` 留作排障与新部署
  （先看未覆盖路径再切回）。已登记 `docs/OPS.md` 环境变量表。
- **未做（如实）**：构建期产哈希（改为请求期从当前 index.html 现算——host 已按 mtime 缓存该文件，
  重建自动跟随，少一条构建↔host 的哈希传递链）；`report-uri` 收集端点（本轮靠 CDP 侧
  `securitypolicyviolation` 事件收集，未建服务端收集器）。
- **证据**：`src/transport/web/csp.ts`；`src/transport/web/index.ts`（nonce 中间件 + 文档路由）；
  `tests/unit/web/csp.test.ts`（11 条）；实测产物 `/tmp/ocrc-perf/csp-collect.mjs`。

### B5 · 媒体输出 document / video / audio `grinev` · **做 → 已落地**（批次 4，2026-10-12）

- **落地**（`src/transport/telegram/m8-journal.ts` + `index.ts`）：
  1. **白名单分类**：`classifyOutboundUrl` 按扩展名分 photo / video / audio / document；
     白名单外（**含 exe/dll/sh/bat/ps1/jar 等可执行类**）一律不发——面板不把可执行文件推进聊天。
  2. **mime 双信号**：`classifyOutboundMime` 读响应 `Content-Type`，优先于扩展名
     （扩展名撒谎/缺失时按 mime 判）。
  3. **大小上限**：`OUTBOUND_MEDIA_MAX_BYTES` 按 TG Bot API——photo 10MB，video/audio/document 50MB；
     超限跳过并如实记日志（不静默）。
  4. **投递循环抽成注入式函数** `deliverOutboundMedia`（fetch/send/warn 注入）：逐条独立容错，
     一条失败不拖累其余；`index.ts` 只留一行 send 分发（sendPhoto/sendVideo/sendAudio/sendDocument）。
     批次 4 后补：分发闭包抽成 `grammyOutboundSender(api, chatId)`（`outbound.ts`）——
     为的是能用**本地 mock Bot API** 验真发送端（见下）。
  5. 抽取面：`extractMediaUrls`（markdown 链接 + 裸 URL，分类过滤 + 去重 + cap 3）；
     `extractImageUrls`（旧图片相册面）保留不动。
- **TG 端验证（2026-10-13 补，缺口收口 B）**：真 grammy 1.46.0 + 本地 mock Bot API
  （`http.createServer` + `listen(0,'127.0.0.1')`，`new Bot('123:TEST', { client: { apiRoot } })`）：
  四种 kind 分别打到 `/bot123:TEST/sendPhoto|sendVideo|sendAudio|sendDocument`；
  multipart 校验 `chat_id` 分片、payload 字段名与 kind 对应、`attach://<id>` 引用的文件分片
  带原始 `filename`（含非 ASCII `报告.pdf`）；换 token → 端点前缀跟着变（非硬编码）。
  即「只差真 bot 投递」：**mock 级集成已验；真 bot 投递仍待用户侧一次确认**（需 token，
  且生产 bot 不接受测试流量）。
- **如实未做**：**真 TG 端投递**——隔离栈按设计跑空 token（不轮询 TG），生产 bot 不接受测试流量。
- **证据**：`m8-journal.ts`（分类/抽取/投递）；`outbound.ts`（`grammyOutboundSender`）；
  `tests/unit/telegram-m8.test.ts`（+9 条，共 15 条）；`tests/unit/telegram-outbound.test.ts`（2 条）。

### B6 · 知识库→资产化闭环 `OpenCode-Client` · **不做**

- **状态**：不做（本体）。
- **优点**：知识资产化（若有需求）。
- **缺点 / 代价**：越界到**通用知识管理**，与「驾驶舱」定位不符；会引入新存储/索引子系统（**核心膨胀**）。
- **影响面**：分层=**核心**（会新增子系统）｜文件=新模块｜工作量=L｜依赖=无｜回归风险=高（核心膨胀）｜门禁=—
- **建议**：**不做**。判据：PRODUCT 第五条「明确不做」已裁 + 越界。
- **证据**：`docs/PRODUCT.md:162`（明示「知识库本体不做」）。

### B7 · ocrc 桥接数据面窗口化（自省项）· **做 → 已落地**（批次 2，2026-10-12）

- **落地内容**（`web-next/src/zcode-services/zcodeAgentService.ts`）：
  1. **尾部快照**：snapshot 只带 `PROTOCOL_V4_LIMITS.snapshotTailWindowRows`（60 行，vendor 常量），
     `totalCount` = 已加载行数；更早行由 loadOlder → `conversationRowsRangeV4` 取回。
  2. **firstRowId 语义修正（根因）**：vendor 的 `hasOlderRows` 判据是
     `window[0].rowId > snapshot.rows.firstRowId`——`firstRowId` 是**分支首行**，不是窗口首行。
     桥接此前填窗口首行 → 恒等 → **「加载更早」按钮永不出现、更早历史不可达**（实测旧行为：
     500/1000 档卡死在 300 行）。现在更早行未加载时填 0 哨兵。
  3. **单调行 id 空间**：vendor 的 range/merge/裁剪全按**数值**比较 rowId
     （`hasOlderRows` / `mergeOlderRows` / `loadAllOlder` / `apply.row.removed`），它要求
     rowId 随行序单调；N9-1 的内容哈希满足身份稳定却破坏单调（这是上面 ② 的深层原因）。
     现在 = 内容身份 → 单调 id：尾部递增（N9-1 的「追加不位移」保持），更早页从
     下界递减且**整块按行序发号**（见「1 行差」条目；最初只逆到卡级，仍非单调）。
  4. **offset 真翻页**：`conversationRowsRangeV4` 改为位置游标 + 服务端
     `[len-limit-offset, len-offset)` 语义逐页前插（最多 5 页/次，防失控），`hasMore` 如实。
  5. **工具卡终态缓存**：消息内所有工具 part 到终态后缓存永不失效（此前 60s TTL 让
     流式期反复回查已完成的消息 = E4）。
- **实测（隔离栈 4199，三档合成会话：102/250/504 卡；CDP 计时 + PerformanceObserver longtask）**：

  | 档位 | 旧：可达行数 | 新：可达行数 | 旧首行 | 新首行 | 旧 tick 取数 | 新 tick 取数 |
  |---|---|---|---|---|---|---|
  | 200 档（≈204 行） | 195（全在窗内） | 全 | 749ms | 445–835ms | 1 次 / 40–43KB | 1 次 / 51–61KB |
  | 500 档（≈495 行） | **300（卡死）** | **507（全）** | 659ms | 450ms | 1 次 / 61KB | 1 次 / 61KB |
  | 1000 档（≈900 行） | **300（卡死）** | **899（99.9%，vendor 判「已到底」）** | 1070ms | 431ms | 1 次 / 61KB | 1 次 / 61KB |
- **流式路径复跑（2026-10-13 补，批次 2 门禁原文要求）**：合成 shell 会话验不到流式，故补一次
  **真回合**（隔离栈引擎，提示词要求 400 字分 8 行 + 首行随机 marker）：
  · **流式在动**：回合 `busy` 期间页面文本持续增长（不是定稿一次性出）；
  · **无重复行**：时间线内**只有 1 行**含模型生成的 marker（`rowsWithMarker=1`），卡片原文同 marker
    也只 1 次——行身份改动没有让 N9-1 的重复渲染回归；
  · **行账自洽**：`data-row-count` 4 = `data-total-row-count` 4（turnHeader/userInput/reasoning/assistantText）；
  · **0 console 错误**。产物 `/tmp/ocrc-perf/{stream-verify,tl-scope}.mjs`。
  （注：首轮探针报「marker 命中 5 次」是探针自身的锅——把侧栏标题摘要与指令里的字面 `XXXXXX`
  也算成命中；限定时间线 + 对比卡片原文后判定无重复。）
- **如实未做 / 未达标**：
  - **全量 rebuild 未改增量**：`buildRows` 仍对已加载窗口整体重建（窗口本身已由 200 消息页封顶）。
    R1 demap 的最大窗口 W3 实测 bridge 占 JS 忙时 **2.2–2.8%**（13.5–19.1ms / 490–864ms，三轮），
    低于 30% 重开阈值；因此维持不做，且旧的「入口 chunk（React+桥接）7–11%」说法已撤回。
  - **live 取数未减字节 → 已减（2026-10-13，缺口收口计划 A）**：live 每 tick 改为取**尾部小页**
    （`?limit=20`，`HISTORY_TAIL_PAGE`）与窗口合并，快照/计划目录仍取全量页；每
    `HISTORY_FULL_EVERY_TICKS`（10）个 tick 兜一次全量页。`hasOlderOnLoad` 改读服务端 `hasMore`。
    **R2 动态对账（隔离栈 4199，`PERF-TAIL-R2`，260→272 卡 / 408 行，`/tmp/ocrc-perf/r2-v3.json`）**：
    open 期实际卡片 260（130 user + 130 assistant），按 `buildRows` 规则动态期望 390 行；
    DOM `rowCount=390`、`totalRowCount=300`（尾窗 60 行）。6 个 tick 各新增 user+assistant 2 卡，
    动态期望 393→408，DOM 每步吻合；每 tick 1 次 `?limit=20`，**5849–6029B**。
    loadOlder 阶段按钮未出现（`buttonSeen=false`、clicks=0），历史取数 **0 次**；阶段结束 408/408、
    `reachedAll=true` 只说明 open/tick 已把当前会话全载入，**不代表该阶段分页取数**。
    R2 产物移除 harness 硬编码 EXPECT；旧 `after-tail-v3.json` 的 `expectedTotal=390` 已过时，不能拿来作 272 卡会话的期望。
    前次 132,463B 的 open 历史 fetch 是 3 次（含 offset 页），与新增 5.8–6.0KB/tick 分阶段统计。
    回归：`historyTailWindow.test.ts` 6 例（小页次数 / 第 10 tick 全量 / 合并后 rowId 全等 /
    小页不污染 hasOlderOnLoad / 锚点缺失快照回退 / 周期 full 前缀失配后持续发帧）。
  - **周期性全量刷新 live freeze → 已定位并修（R1，2026-10-13）**：第 10 个 tick 的 full refresh
    让 recent 头前移，`diffRows` 返回 `null`；旧 guard 把 `deltas=null` 与空数组一起吞掉，在快照回退
    分支前 return，导致服务端卡片继续增长而页面永久冻结。修复为只对 `deltas && deltas.length===0`
    且交互投影未变时 return；`deltas=null` 必走全量 snapshot fallback。
    真实饱和会话复核：修前 220→244 卡片、DOM 停在 303/357；修后第 10 次仍继续收敛（服务端
    220→244，行账 330→357→330→339 等窗口平移后继续增长）。回归 `historyTailWindow.test.ts` 新增第 6 例。
  - **D 证据修正（R2 已核实）**：旧 `after-tail-v3.json` 的 `loadOlder.histFetches=0` 表示该阶段没有新增取数；
    不能再写成「loadOlder 一轮取全」。新动态 harness 分别记录 open/tick/loadOlder 阶段；该档按钮未出现、未点击，
    open/tick 后当前 408 行已全载入。
- **门禁**：`rowWindow.test.ts` 5 例（尾部窗口/firstRowId/单调 id/翻页到耗尽/turn 号稳定）+
  `rowWindowTotals.test.ts` 3 例（对齐档精确/行序 id 单调/非对齐档复现 1 行差）+
  `historyTailWindow.test.ts` 6 例（含周期 full 前缀失配不冻结）+
  既有 `rowIdentity.test.ts` 6 例（N9-1 契约）全绿；双端 tsc + 测试 + build 全绿。
- **证据**：`zcodeAgentService.ts`（`rowIdFor` / `assignOlderPageIds` / `historyWindowFor` /
  `buildWindowRows` / `conversationRowsRangeV4` / `liveUpdate` / `enrichToolRows`）；
  `rowWindow.test.ts`；`rowWindowTotals.test.ts`；`historyTailWindow.test.ts`；
  `scripts/perf-md-attribution.mjs`；`/tmp/ocrc-perf/md-attribution.json`。

### B8 · 非图片附件上行（web 侧）· **做 → 已落地**（批次 5，2026-10-12）

- **送达方式（spike 结论）**：走 **A：落盘 + 路径注入**（`<ocrcHome>/attachments/<sessionId>/` +
  `[附件 <kind>: <name>（NKB），已保存到 <path>——需要时用文件工具读取]`，**TG 收件同款措辞**）。
  不选 B（原生 FilePart）：`url` 的 data:/file: 语义需引擎侧确认，且大文件内联进 prompt 会污染上下文；
  A 引擎无关、已有先例、模型用文件工具直接读。
- **落地**：
  1. **拆两道自设门禁**：`web-next/src/zcode/platform.ts` 的 `getPathForFile` 不再按 `image/*` 返 null；
     `zcodeAgentService` 的 sendText 分支不再拒非图片——图片仍走 `images[]`（引擎原生图片输入），
     其余走新的 `attachments[]`（name/mimeType/base64）。
  2. **host 侧通道**：`src/core/attachments.ts`（新）+ `routes/message.ts` 收 `attachments` →
     边界校验 → 落 staging → 路径说明折进文本；`routes/sessions.ts` 删除会话时清 staging 目录。
  3. **边界**：可执行/脚本类（exe/msi/dll/so/sh/bat/ps1/jar/apk/dmg/deb/rpm/lnk…）拒收；
     20MB 上限（与 TG 收件、vendor 上传事务同档）；staging 按会话隔离 + 会话删除清理。
     客户端先判一次（UX），host 再验一次（纵深防御）——两处都如实回错，不静默丢弃。
- **验证（隔离栈 4199 端到端）**：POST /api/message 带 .md 附件 → 落盘
  `…/attachments/<sid>/1791824517065-b8-note.md`，引擎侧 user 消息文本含注入的路径说明（模型可读）；
  `.exe` → HTTP 400「是可执行/脚本类，已拒绝（上行白名单）」；会话删除 → staging 目录已清理。
  单测：host 侧 9 条（白名单/大小/staging/note/清理/路由三态）+ 桥接侧 3 条（images 与 attachments 分流、
  可执行拒绝、未知 ref 拒绝）。
- **证据**：`src/core/attachments.ts`；`routes/message.ts` / `routes/sessions.ts`；
  `web-next/src/zcode/platform.ts`、`zcodeAgentService.ts`；`tests/unit/attachments.test.ts`、
  `web-next/src/zcode-services/__tests__/attachmentsSend.test.ts`。

### B9 · OpenCode-Client 前后端缺口（设置域欠账）· **做 → 已回填**（批次 6，2026-10-12）

- **原状（欠账）**：`PRODUCT.md:52` 第零点七条「做」清单里的设置域四项，**后端路由在、前端消费方没有**——
  rc.3 大清洗（`e55d3221`）把 rc.2 设置面整体删除（`pages/SettingsPage.tsx` 309 行、
  `components/settings/ProjectCards.tsx` 372 行、`SkillsSourceCard.tsx` 120 行），
  `lib/api/client.ts` 留下死亡包装（0 调用方）。
- **落地（批次 6）**：
  - **6a vendor 插槽**：新增 `settingsExtraSections.ts` 模块级注册表（同 PATCHES #10 品牌层形态，
    一处注册对全部 SettingsPage 实例生效）；`settingsPageConfig` 追加扩展分区、`SettingsPage`
    内容链前缀注册方渲染；**顺带修 `isSettingsSectionId` 漏 `remotes` 的守卫 bug**
    （union 里有、守卫里没有 → 写入可用、读回被静默丢弃）。登记 PATCHES #14 + CHECKLIST §8。
  - **6b–6e 四个面**（`web-next/src/zcode/settingsSections.tsx`，ZCodeApp 模块初始化注册）：
    模型映射方案库（导出/导入/切换 → `/api/settings/model-presets`）、项目 `.opencode/` 五件套
    （编辑 → `/api/settings/project{,/file}`，原子写 + JSONC 校验回显）、技能源
    （加/删源 + 冲突诊断 + 启停 → `/api/settings/skills-manager*`）、全局配置 raw
    （`PUT /api/settings/opencode-config`）。
- **验证**：隔离栈 CDP——4 个分区出现在设置页「Agent 能力」组，逐个点开渲染 + 命中各自端点；
  映射方案读到项目真实映射（`sisyphus → deepseek/deepseek-v4.1-flash`）；
  单测 5 条（插槽进配置与分组 / 未注册零侵入 / remotes 恢复不回落 / 扩展 id 放行 / 未知 id 仍回落）。
- **证据**：`e55d3221`（删除清单）；`settingsSections.tsx` + `settingsSections.test.ts`；
  `vendor/PATCHES.md #14`、`vendor/CHECKLIST.md §8`；`settings-project.ts` / `settings.ts`（后端路由）。

---

### D1 · 字号量程 12–20 vs dsh 10–22 · **维持**（裁决 2026-10-12）

- **选项 A**：维持 12–20（零改动）。**选项 B**：放宽到 10–22（改 vendor `uiFontSize.ts:5-6` 两个常量，S 级）。
- **优点（B）**：与 dsh 寄存器一致，用户可选更小/更大。
- **缺点 / 代价（B）**：改 vendor 需 PATCHES 登记 + CHECKLIST 对账；纯偏好改动是长期维护税。
- **影响面**：分层=**壳 / vendor**｜文件=`uiFontSize.ts`｜工作量=S｜依赖=vendor PATCHES 流程｜回归风险=低｜门禁=vendor CHECKLIST + 视觉抽查。
- **裁决依据（2026-10-11 复核）**：① 上游 `zai-org/ZCode` 源码 raw 核实 = **12–20 verbatim**（`uiFontSize.ts` 三个常量逐字一致），
  即现状不是偏离而是对齐；② `applyUiFontSizePx` 的设计注释自证「只更新 UI 字号 Token 基准、不连带缩放图标/间距/圆角」——设计正确，不该动；
  ③ dsh 的 10–22 本轮**复核不到**（GitHub code search 全部查询 0 命中 / 不可用）——参考值本身未证实，为它改 vendor 不划算。
- **建议**：**维持**。除非「12–20 太窄」是用着不爽的真实痛点——那另算。
- **证据**：`uiFontSize.ts:4-6,26-27`；上游 ZCode `uiFontSize.ts`（2026-10-11 raw 核实）。

### D2 · future adapter 命名「pi」· **改判 → 已落文本**（裁决 2026-10-12）

- **裁决文本**：`PRODUCT.md:15` / `ARCHITECTURE.md:76-78` 的「opencode V2、pi 为后续适配目标」
  → **「omp（原生 ACP）/ pi（经第三方桥 pi-acp）/ gjc」**。批次 0 已落。
- **依据**：pi 本体**官方无 ACP**（自定义 JSONL RPC），裸名「pi」无法直连现有 `AcpBackend`；
  而 omp / gjc 有原生 `acp` 入口，pi 有第三方桥（见 E3 改写）——命名应指**可接入事实**，不是宽泛家族名。
- **影响面**：分层=**文档**｜文件=`PRODUCT.md:15`、`ARCHITECTURE.md:76-78`｜工作量=S｜已完成｜回归风险=无（文本）。
- **建议/状态**：**已改判**（外带一句「2026-10-12 命名改判」留痕）。**是否立项**另议（见 E 组）。
- **证据**：`PRODUCT.md:15`、`ARCHITECTURE.md:76-78`（已改）；E 组调研。

---

### E1 · omp（`can1357/oh-my-pi`，MIT，★35k）· **只备料**（立项时首选）

- **协议入口**：**有 `omp acp`**（JSON-RPC stdio；写操作经 `session/request_permission` 门控；`modes/acp/acp-mode.ts`）——代码 + 文档双证。
- **优点**：fs/terminal 路由 + 权限门最完整 → 接现有 `AcpBackend` 迁移成本最低；内嵌 ripgrep/bash 免 fork-exec。
- **缺点 / 代价**：含 **Rust N-API 原生扩展** → 需跨平台预编译工件，**EL7 / glibc 2.17 下限有风险**；fork 生态，长期维护不确定。
- **影响面**：分层=**核心**｜文件=`src/cli/host-backends.ts`（注册）+ 复用 `acp-backend.ts`｜工作量=M｜依赖=omp 二进制在目标平台（x86_64/arm64/EL7）可得｜回归风险=**低**（`OCRC_BACKENDS` 选择，纯加法）｜门禁=隔离栈 E2E + 权限 dock 联调。
- **建议**：**只备料**（本轮不实现）。立项时首选；第一步=「omp 在目标平台能否运行」平台验证（半日）。
- **证据**：omp 仓库/文档（desk research，2026-10-11）；`host-backends.ts:82-99`、`backend.ts:192-326`。

### E2 · gjc（`Yeachan-Heo/gajae-code`，MIT，★2.9k）· **只备料**（立项时次选）

- **协议入口**：**有 `gjc acp`**（stdio 前端）；文档含 initialize 握手。
- **优点**：外部控制面克制（broker + capability-scoped attachment，凭据不外露）。
- **缺点 / 代价**：`gjc acp` 是**薄前端**，依赖**常驻 SDK broker 守护进程** → 多一个进程要纳入 adopt/spawn 生命周期模型；运行时用 Bun。
- **影响面**：分层=**核心 + 宿主**｜文件=AcpBackend 路径 + 进程生命周期｜工作量=M–L｜依赖=broker 常驻｜回归风险=低（加法），主要复杂点=broker 生命周期｜门禁=隔离栈 E2E。
- **建议**：**只备料**（本轮不实现）。立项时次选（除非 omp 平台验证失败）。
- **证据**：gjc 仓库/`docs/acp-local-development.md`（desk research）。

### E3 · pi 本体 · **只备料**（2026-10-12 改写：第三方桥存在）

- **协议入口（改写）**：pi **官方无 ACP**（RPC 是自定义 JSONL，非 JSON-RPC）——但**第三方 ACP 桥存在**：
  `@automatalabs/pi-acp` **v0.9.4**（npm）：「in-process Agent Client Protocol server for the pi coding agent…
  embeds pi through its published SDK…ACP protocol version 1 over stdio」，bin `pi-acp`，
  repo `agentprism/agentprism-workflows`（2026-10-11 核实）。即「接 pi」不必等官方、也不动 pi core——
  走桥即复用 `AcpBackend`，成本降为**桥的维护风险**。
  （senpi 线另论：app-server 是 Codex 兼容 JSON-RPC over WS/stdio/unix，非 opencode HTTP 形状。）
- **优点**：pi 极简核心、extension/skill/theme 机制；有桥后接入面与 omp/gjc 同级。
- **缺点 / 代价**：第三方桥是社区财产（非 pi 官方背书）→ 版本对齐 / 弃坑风险自担；
  senpi app-server 无法复用 `OpencodeBackend`，新写适配层 M–L；senpi / OmO 线另需 **SUL-1.0（非 OSI）法务复核**。
- **影响面**：分层=**核心**｜文件=新 backend（经桥则复用 `acp-backend.ts`）｜工作量=S–M（第三方桥）/ M–L（senpi 自写）｜依赖=桥维护活跃度｜回归风险=低（加法）｜门禁=隔离栈 E2E。
- **建议**：**只备料**。若立项 pi 线，第一步=验 `@automatalabs/pi-acp` 握手 + 会话/工具流保真度。
- **证据**：pi `docs/rpc.md`；`@automatalabs/pi-acp` v0.9.4（2026-10-11 核实）；senpi `docs/app-server.md`。

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

**集成面**：pi = 严格 JSONL（非 JSON-RPC），**官方无 ACP**——但第三方桥 **`@automatalabs/pi-acp` v0.9.4**
存在（「in-process ACP server…embeds pi through its published SDK，ACP v1 over stdio」，bin `pi-acp`，
repo `agentprism/agentprism-workflows`；2026-10-11 核实）→ 「接 pi」= 复用 `AcpBackend` + 自担第三方桥维护风险；
senpi = 继承 pi + app-server（WS JSON-RPC）；omp = `omp --mode rpc`（NDJSON）+ **`omp acp`**；
gjc = **`gjc acp`**（薄前端 + 常驻 broker）。
**还差验证**：① 实跑 `omp acp`/`gjc acp` 握手 + 权限流；② `pi-acp` 桥的会话/工具流保真 + 版本对齐；
③ senpi app-server 长连接/多会话；④ 四 fork 会话格式互操作；
⑤ 版本锁定（senpi 日历版本、`senpi-task` 私有不可 pin）；⑥ OmO 的 SUL-1.0 法务复核（若走 senpi 线）。

## 5. 裁决记录（2026-10-12 收口）

> 来源：2026-10-11/12 逐项 grill（22 项逐条过、含被排除项）。本表为**最终裁决**，
> 覆盖 §2 各条目的「建议」列；实施批次（0–6）见配套实施计划。

| ID | 项 | 我的建议 | 用户裁决 | 落法（批次） |
|---|---|---|---|---|
| A1 | 三层语义令牌 | 保持 | 保持 | + stylelint 令牌约束（批 1 ✅） |
| A2 | superellipse | 保持 | 保持（仅影响打开 web 的浏览器，可接受） | 无 |
| A3 | 滚动条全局表 | 保持 | 保持 | 无 |
| A4 | 焦点环全局表 | 保持 → 自纠「修」 | **修** | 恢复 `:focus-visible` 环（批 1 ✅） |
| A5 | 0.5px 发丝高程 | 保持 | 保持（观察到糊再调） | 无 |
| A6 | ContextMeter / TurnNavigator / TextShimmer | 保持 | 保持 | 无 |
| A7 | 字号一等设置 | 保持 | 保持 | 无（量程见 D1） |
| A8 | 行级虚拟化时间线 | 已落地（更正） | 保持 | 无 |
| B1 | RiskConfirmation | 不做独立组件 | **不做**（与 dock 重叠） | 无 |
| B2 | Markdown Worker | 实测驱动 | **做**（排 B7 后）→ 2c 改判不做 → **R1 demap 复核暂不重开**（vendor Mermaid/CSS 热点） | R1 归因 ✅（另出 vendor 优化计划再议） |
| B3 | 主题即 JSON | 不做 | **不做**（代码主题面板已有） | 无 |
| B4 | CSP + 哈希 | 不做 → 改判「做」 | **做**（内网合规） | 批 3 ✅（enforce） |
| B5 | 媒体输出 | 待裁决 | **做** | 批 4 ✅ |
| B6 | 知识库闭环 | 不做 | **不做** | 无 |
| B7 | 桥接数据面窗口化 | 待裁决 | **做**（先 500/1000 行基线） | 批 2a/2b ✅ |
| B8 | 非图片附件上行 | （本轮补列） | **做**（禁可执行 / 20MB / staging） | 批 5 ✅ |
| B9 | 设置域缺口回填 | （本轮新增） | **做**（4 面） | 批 6 ✅ |
| D1 | 字号量程 | 维持 12–20 | **维持**（上游 verbatim） | 无 |
| D2 | future adapter 命名 | 改判 | **改判**：omp（原生 ACP）/ pi（经第三方桥 pi-acp）/ gjc | 批 0 文本（已落） |
| E1 | omp | 立项时首选 | **只备料** | 无（立项另议） |
| E2 | gjc | 立项时次选 | **只备料** | 无（立项另议） |
| E3 | pi / senpi | 不作首选 | **只备料**（已改写：第三方桥存在） | 无（立项另议） |

**反向记录（明确排除）**：B1 独立组件、B6 知识库本体、A5 预改、E 组适配器**实现**（只备料）。
**执行序（用户认可）**：批次 0 → 1 → 2 → 6 → 3 → 4 → 5；每批独立提交、双端门禁全绿进下一批。
