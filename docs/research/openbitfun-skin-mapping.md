# OpenBitFun 设计风格导入 · 映射表与候选皮肤

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **状态**：调研 + 映射 + 样张（2026-10-13）。**未接线**（入库不 import）。
  **终局注记（2026-10-14）**：接线裁决走了另一路——用户经六家体系调研（`ui-color-system-import.md`）选定
  **ocrc ink**（中性轴 + 柿橙，非 OBF 色值），已接线为默认皮肤（`22552dde`）。本文件保留为：覆盖层接缝的
  接线方法依据（§2 盘点全部有效，`zcode-theme-bridge.css` 即按该接缝落地）；OBF A/B 样张与映射表作为
  结构可行性证明归档，`skin-openbitfun.css` 仍不参与构建。
- **来源**：[GCWing/OpenBitFun](https://github.com/GCWing/OpenBitFun)（MIT）。只取色值与设计语言，不复制其代码/资产；MIT 归属在此注明。
- **判据**：PRODUCT.md:116 归壳层；B3「主题即 JSON/运行时导入」判例不撞——本轮只做静态预设，不碰机制。
- **证据物**：`/tmp/obf/*.tokens.json`（reference + dark/light + high-contrast×2 + system，不入库）、README 截图 4 张（`openbitfun-desktop.png` 已目视校准）。

---

## 1 · OpenBitFun 设计语言解析

**token 架构（三层）**：

1. `reference.tokens.json` — `ref.color.*` 数值刻度（159 条，纯色板，不产运行时变量）：neutral 24 档冷灰（`#ffffff`→`#000000`，950=`#0e0e10`、900=`#1c1c1f`、200=`#e8e8e8`、350=`#b0b0b0`、550=`#858585`、650=`#6a6a6a`、750=`#555555`）+ blue/cyan/purple/pink/green/amber/red/navy 全刻度。
2. `dark/light.tokens.json` — `color.*` 语义角色（各 139 条）：surface（canvas/panel/raised/scene/workbench/tertiary/chrome/subtle）、content（primary/secondary/muted/disabled/caption/inverse）、border（subtle/default/strong）、action（neutral/primary/secondary/quiet）、accent（default/hover/secondary + surface/border 派生）、status（info/success/warning/danger × emphasis/content/surface/border）、field、control、link、overlay、scrollbar、codeDiff、shadow、effect、opacity。
3. `system.tokens.json` — **主题无关**：radius（xs4/sm6/base8/lg12/xl16…pill）、space（4px 基）、字排语义角色（heading.page 24px/bold、welcome 32px/semibold…）、mono=Fira Code、sans=system-ui、motion（instant 80/fast 140/base 220/contentSwap 320/slow 420ms；easing standard `cubic-bezier(0.23,1,0.32,1)`）、scrollbar width 6px、focus width 2/offset 2、z-index 阶。

**观感特征（截图 + token 交叉印证）**：

- **亮色近纯白**：canvas `#fdfdfd`、chrome/侧栏 `#f8f8f9`、panel 纯白；边框极淡（rgba(16,26,39,0.08~0.15)，冷蓝黑墨非纯黑）。
- **暗色双平面**：canvas `#0e0e10` / panel `#1c1c1f` 只有**两级**——层次靠阴影（暗色 alpha 0.8 深aaS）与边框（白 0.12/0.18/0.30），不像 zai 的 161616→202020→2b2b2b 三级提亮阶梯。
- **强调色跨主题翻转**：dark accent = **blue-400 `#60a5fa`**，light accent = **cyan-500 `#059cb0`**；link 全主题 cyan 系；secondary accent 紫（dark purple-500 `#8b5cf6` / light purple-600 `#7c6b99`）。
- **主按钮**：dark = 白 16% ghost（`rgba(255,255,255,0.16)` + 字 `#f3f3f5`），light = **深蓝墨 `#101a27`**（navy-950）实色——不是 zai 的纯白/纯黑。
- **语义色跨主题恒定**：info `#2e7eff`、success `#1aa73e`、warning `#ff8c00`、danger `#ec221f` 在 dark/light **同值**（只有 content 派生比例不同）。
- **几何**：radius base 8 / lg 12 / surface 16（composer `radius.xl`=16）、大标题 semibold、system-ui 字族。
- **桌面截图**（`openbitfun-desktop.png` 2568×1672）：近白画布、`#f8f8f9` 侧栏、极淡边框、大圆角面板、"Good morning, coding partner" 大标题、底部悬浮 composer——与 token 一致。

---

## 2 · ocrc 侧接缝（阶段 1 盘点结论）

### 2.1 可覆盖变量面

| 层 | 文件 | 块 | 变量 |
|---|---|---|---|
| vendor | `vendor/zcode/ui/src/styles.css` | `:root`(L75) / `@theme`(L165) / `.dark`(L338) / `.theme-zai-light`(L492) / `.theme-zai-dark`(L638–783) | `--color-*` 143 条 × 三主题块（**三块变量名完全一致**，diff 已证）+ `--ui-font-size`/`--text-ui-*`/`--font-mono` |
| ocrc | `src/styles/theme.css` | LAYER 0 `:root` / LAYER 1 `:root`+`:root[data-theme="light"]`+media / LAYER 2 | `--zai-*` 原料 15 条；alias 语义 ~60 条；场景 ~15 条 |
| Tailwind 默认 | `node_modules/tailwindcss/theme.css` | `@theme` | `--radius-xs..4xl`(L397-404)、`--shadow-2xs..2xl`(L406-412)——**都是 CSS 变量**，纯 `:root` 重设即可覆盖（vendor styles.css:2219 消费 `var(--radius-sm)` 实证） |

### 2.2 加载顺序与特异性（覆盖策略的依据）

1. 入口 CSS（`index.css`→`theme.css`）在 head **先**；vendor `styles.css` + 覆盖层随 ZCodeApp chunk **后**注入——**后到者赢**（dist chunk 字节序 + theme.css:483-485 注释双证）。
2. 特异性：vendor 三主题块是 class 选择器 `.dark`/`.theme-zai-*` (0,1,0)，**高于** `:root` (0,0,1)。⇒ 皮肤对 vendor 面的覆盖**必须重复同名三选择器块**（`.dark`/`.theme-zai-dark`/`.theme-zai-light`）靠顺序赢；对 ocrc 面用 `:root`（dark 基底）与 `:root.theme-zai-light`+`:root[data-theme="light"]`+media 复制（light）。
3. 主题信号双轨：vendor 走 class 三件套（`ZCodeApp.tsx:66-71` applyZCodeTheme：`dark` + `theme-zai-light|theme-zai-dark`，预涂防闪 L55-64）；ocrc 旧词汇走 `data-theme` 属性（`index.html:12` 预涂）。皮肤 light 块两轨都挂，行为与现壳一致。
4. 覆盖层先例：`src/zcode/zcode-mobile.css`（N8-7）——纯 ocrc 侧新 CSS、零 vendor 字节改动，**免 PATCHES 登记**（PATCHES.md:4 + vite.config.ts:54）。皮肤 import 位置 = `src/zcode/ZCodeApp.tsx:10`（`./zcode-mobile.css`）之后加一行。

### 2.3 必须保持的既有契约（样张逐条复验）

| 契约 | 位置 | 皮肤处置 |
|---|---|---|
| A2 superellipse | theme.css:442-444 `@supports corner-shape` | 不动（形状随 radius 变量自动跟随） |
| A3 滚动条圆胶囊 | theme.css:451-476 | 不动规则，只换 `--oc-scrollbar-thumb(-hover)` 值 |
| A4 键盘焦点环 | theme.css:487-497 + `--focus-ring: var(--info)` L113/270/359 | 不动全局表；A 案换 `--info` 值、`--focus-ring` 链保持指向 `var(--info)`（不用 OBF light 灰环 `#6a6a6a`，保 WCAG 与契约） |
| D1 字号 12–20 | theme.css:148-156 + `uiFontSize.ts` | 不动 `--ui-font-size`（OBF base 恰好也是 14px） |
| 动效寄存器 | PRODUCT.md:102 + theme.css:510-549 | 样张不动；OBF motion 仅记录在 §5 |
| 字体栈 | theme.css:158-161（0.26.22 定稿） | 不动；OBF system-ui/Fira Code 不采纳（§5 两案） |

---

## 3 · 主映射表 · 变体 A（全量：含 accent 换蓝/青）

三列：OpenBitFun token → ocrc/vendor 变量 → 候选值（dark / light）。`⇆` 标记 = ocrc 与 vendor 两个变量同值联动。派生值标 `◇`。

### 3.1 表面

| OBF token | ocrc / vendor 变量 | dark | light |
|---|---|---|---|
| surface.canvas | `--bg` ⇆ `--color-background` | `#0e0e10` | `#fdfdfd` |
| surface.panel / scene | `--bg-panel` ⇆ `--color-panel` `--color-header` | `#1c1c1f` | `#ffffff` |
| —（canvas 语义） | `--bg-canvas` | `#0e0e10` | `#ffffff` |
| surface.raised | `--bg-elev` ⇆ `--color-card` `--color-popover` `--color-input` `--color-toast` `--color-tooltip` `--bg-card` `--bg-popover` `--bg-menu` `--bg-input` | `#1c1c1f` | `#ffffff` |
| ◇ 派生（无对应） | `--bg-elev2` ⇆ `--color-secondary` `--bg-menu-hover` | `#232326`◇ | `#f7f7f7`（tertiary） |
| surface.tertiary | `--bg-tag` ⇆ `--color-tag` | `rgba(255,255,255,0.1)`（keyHint.background） | `rgba(0,0,0,0.08)` |
| surface.chrome | `--bg-sidebar` ⇆ `--color-sidebar` | `#0e0e10`（=canvas） | `#f8f8f9` |
| surface.chrome | `--bg-header` | `#0e0e10` | `#ffffff` |
| —（tab 语义） | `--bg-tab` / `--bg-tab-active` ⇆ `--color-tab(-active)` | `#0e0e10` / `#1c1c1f` | `#f8f8f9` / `#ffffff` |
| —（代码井派生） | `--bg-code` | `#131316`◇ | `#f7f7f7` |
| surface.subtle | `--user-bubble` `--surface` ⇆ `--color-surface` | `rgba(255,255,255,0.06)` | `rgba(16,26,39,0.03)` |
| surface.subtle | `--bg-code` 外的 recessed：`--cv-bubble`（跟随） | — | — |
| overlay.scrim | `--scrim` | `rgba(0,0,0,0.56)` | `rgba(16,26,39,0.20)` |

### 3.2 内容（墨水）

| OBF token | ocrc / vendor 变量 | dark | light |
|---|---|---|---|
| content.primary | `--zai-fg-dark`/`--zai-fg-light` 源头（`--text` 及派生跟随）⇆ `--color-foreground` | `#e8e8e8` | `rgba(0,0,0,0.80)` |
| content.secondary | `--text-2` | `#b0b0b0` | `rgba(0,0,0,0.60)` |
| content.muted / caption | `--text-3` | `#858585` | `rgba(0,0,0,0.40)` |
| content.disabled | `--text-4` | `#555555` | `rgba(0,0,0,0.30)` |
| （toolcmd/toolout 派生） | `--toolcmd` / `--toolout` | 引用不动 | 引用不动 |

> `--text-2/3/4` 从 color-mix 派生改为 OBF 字面三档（secondary/muted/disabled 直译）；`--toolcmd`/`--toolout` 仍引 `--zai-ink-light`/fg 派生，跟随源头。

### 3.3 边框与交互中性面

| OBF token | ocrc / vendor 变量 | dark | light |
|---|---|---|---|
| border.subtle | `--border` ⇆ `--color-border` `--color-input-border` | `rgba(255,255,255,0.12)` | `rgba(16,26,39,0.15)` |
| ◇ 派生（更弱分隔） | `--border-2` | `rgba(255,255,255,0.07)` | `rgba(16,26,39,0.08)`（=subtle） |
| field.borderHover | `--border-hover` ⇆ `--color-border-hover` | `rgba(255,255,255,0.24)` | `rgba(16,26,39,0.20)` |
| action.quiet.hover | `--hover` ⇆ `--color-hover` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.05)` |
| action.neutral.surfaceHover | `--selected` ⇆ `--color-selected` `--surface-hover` ⇆ `--color-surface-hover` | `rgba(255,255,255,0.12)` | `rgba(0,0,0,0.08)` |
| action.neutral.surface | `--bg-tag`（见 3.1） | 同上 | 同上 |
| action.primary.background | `--primary` ⇆ `--color-primary` | `rgba(255,255,255,0.16)` | `#101a27`（navy-950） |
| action.primary.content | `--primary-ink` ⇆ `--color-primary-foreground` | `#f3f3f5`（neutral.100） | `#ffffff` |
| scrollbar.thumb | `--oc-scrollbar-thumb` | `rgba(255,255,255,0.20)` | `rgba(0,0,0,0.20)` |
| scrollbar.thumbHover | `--oc-scrollbar-thumb-hover` | `rgba(255,255,255,0.30)` | `rgba(0,0,0,0.30)` |

### 3.4 accent 与交互色（A 案核心差异）

| OBF token | ocrc / vendor 变量 | dark | light |
|---|---|---|---|
| accent.default | `--accent`（=chrome accent；对话系 `--cv` 跟随） | `#60a5fa`（blue-400） | `#059cb0`（cyan-500） |
| accent.surface | `--accent-2` | `rgba(96,165,250,0.12)`◇ | `rgba(5,156,176,0.09)`◇ |
| ◇（accent 底上的墨） | `--accent-ink` | `#0e0e10` | `#ffffff` |
| accent.border | `--accent-line` | `rgba(96,165,250,0.4)` | `rgba(5,156,176,0.4)` |
| link.default | `--oc-unread-dot`（近似「新事」色） | `#36c6d7`（cyan-400） | `#059cb0` |
| accent.secondary | `--idle-task` | `#8b5cf6`（purple-500） | `#7c6b99`（purple-600） |
| accent.secondarySurface | `--idle-task-surface` | `rgba(139,92,246,0.09)` | `rgba(124,107,153,0.09)` |
| focus.ring | `--focus-ring` | `var(--accent)`（OBF=accent） | `var(--info)`（**契约优先**，OBF 灰环不采纳） |

> OBF dark 主按钮/brand 不再是纯白：`--color-brand`（dark）候选 `#f3f3f5`。light 侧 ocrc `--accent` 原=纯黑 → 变 cyan，是对话气泡/shimmer/审批色的整体翻转（`conversation-emerald` 机制保持，`--cv` 跟随）。

### 3.5 语义状态（OBF 跨主题恒定值）

| OBF token | ocrc / vendor 变量 | dark | light |
|---|---|---|---|
| status.info.emphasis | `--info` ⇆ `--color-git-renamed` | `#2e7eff`（blue-550） | `#2e7eff` |
| status.success.emphasis | `--ok` ⇆ `--color-success` `--color-diff-added` `--color-git-added/-untracked` | `#1aa73e`（green-550） | `#1aa73e` |
| status.warning.emphasis | `--warn` ⇆ `--color-warning` `--color-git-modified/-descendant` | `#ff8c00`（amber-550） | `#ff8c00` |
| status.danger.emphasis | `--err` ⇆ `--color-destructive` `--color-diff-removed` `--color-git-deleted` | `#ec221f`（red-650） | `#ec221f` |
| status.info.surface/content | `--ask-surface` / `--ask-fg` | `rgba(46,126,255,0.10)` / `color-mix(in srgb, #2e7eff 62%, #fff)` | 同 dark / `color-mix(in srgb, #2e7eff 76%, #000)` |
| status.success.surface/content | `--confirm-surface` / `--confirm-fg` | `rgba(26,167,62,0.10)` / `color-mix(in srgb, #1aa73e 70%, #fff)` | 同 dark / `color-mix(in srgb, #1aa73e 68%, #000)` |

### 3.6 高程与阴影（OBF 暗色深阴影 / 亮色 navy 墨淡影）

| OBF token | ocrc 变量 | dark | light |
|---|---|---|---|
| shadow.xs | `--shadow-card` | `0 1px 2px rgba(0,0,0,0.9)` | `0 1px 2px rgba(16,26,39,0.04)` |
| shadow.composer | `--shadow-composer` | `0 2px 6px rgba(0,0,0,0.32)` | `0 2px 12px rgba(0,0,0,0.08)` |
| shadow.overlay | `--shadow-palette` | `0 4px 20px rgba(0,0,0,0.48)` | `0 4px 20px rgba(0,0,0,0.12)` |
| （dsh 三件套） | `--elev-panel/-prominent/-soft` | 引用 `--border` 自动跟随 | 同左 |

### 3.7 几何（主题无关，两变体共用）

| OBF token | ocrc 变量 | 现值 | 候选 |
|---|---|---|---|
| radius.lg（12px） | `--radius` | 14px | **12px** |
| radius.base（8px） | `--radius-sm` | 9px | **8px** |
| radius.sm（6px） | `--radius-xs` | 6px | 6px（不变） |
| — | `--radius-tail` / `--radius-bar` / `--radius-pill` | 4 / 2 / 999px | 不变 |
| — | `--ui-font-size` | 14px | 不变（OBF base 同值） |

> Tailwind 侧 `--radius-*`（`rounded-sm` 等 Tailwind 词汇）被 vendor 组件消费（styles.css:2219 等）：候选同步重设 `--radius-sm: 8px`（Tailwind 名）注意 ocrc 的 `--radius-sm`(9px) 与 Tailwind 的 `--radius-sm`(0.25rem) **重名不同义**——皮肤同时给两套赋值，ocrc 阶在 ocrc 块、Tailwind 阶照 Tailwind 语义（sm 6px 档）。实测以样张为准。

### 3.8 vendor 面增量（ocrc 变量之外，143 条中需动的子集）

`.dark` / `.theme-zai-dark` / `.theme-zai-light` 三块同名覆盖（选择器必须同名，靠加载顺序赢）：

- 3.1–3.6 表中所有 ⇆ 变量（background/background-win-alt/panel/header/sidebar/card/popover/popover-header(◇ 派生档)/input/menu/menu-hover/tab(-active)/secondary/toast/tooltip/tag/surface(-hover)/hover/selected/border(-hover)/primary(+foreground)/success/warning/destructive/diff-added/-removed/git-added/-modified/-deleted/-renamed/-untracked/-descendant/idle-task(-surface)/foreground/brand(dark)/accent(dark=ask-surface 候选)/tooltip-tag(-foreground)◇/plugin-paid-plan-badge◇）。
- popover-header 候选：dark `#232326` / light `#f8f8f9`；tooltip-tag：dark `rgba(255,255,255,0.1)`+fg `#b0b0b0` / light `rgba(0,0,0,0.08)`+fg `rgba(0,0,0,0.60)`；plugin-paid-plan-badge 候选 light 保持、dark `rgba(255,163,89,0.15)`+fg `#ffa359`◇。
- **不动**（OBF 无对应领域色，保留 zai）：terminal ANSI 全 ramp、usage-chart 1-6、usage-heatmap 0-4、context-breakdown 1-7、file/skill/command/subagent/session/plugin-node 族、trajectory 五色、workflow、find-highlight(-active)、interaction-ask/confirmation（ocrc 面 `--ask-*`/`--confirm-*` 已覆盖同语义，vendor 原值保留做 vendor 组件内兜底）、terminal-selection。
- `--color-card-selected`/`--color-card-border`/`--color-popover-border`/`--color-input-focused`/`--color-input-border(-hover/-focused)`/`--color-terminal-bg/fg` 均为 var 引用，自动跟随。

---

## 4 · 变体 B（中性层：只换底/边/墨/几何，保留 ocrc accent 与语义色）

与 A 的**差异集**（其余全同 A）：

| 变量组 | A 案 | B 案 |
|---|---|---|
| `--accent`(-2/ink/line)、`--cv` 系 | dark `#60a5fa` / light `#059cb0` | **不动**（dark=白、light=黑，现状） |
| `--primary`/`--primary-ink` ⇆ `--color-primary(+fg)`、`--color-brand` | OBF ghost 白 16% / navy-950 | **不动**（白/黑） |
| `--ok/warn/err/info` ⇆ vendor 语义色 | `#1aa73e/#ff8c00/#ec221f/#2e7eff` | **不动**（zai 值） |
| `--focus-ring` | dark `var(--accent)` | **不动**（`var(--info)`） |
| `--idle-task(-surface)`、`--ask-*`、`--confirm-*`、`--oc-unread-dot` | OBF 值 | **不动** |
| 中性面/墨/边框/滚动条/阴影/scrim/radius/用户气泡/代码井 | OBF 值 | OBF 值（与 A 相同） |

B 的观感 = OpenBitFun 的「底子」（近白/深双平面 + 极淡冷边 + 大圆角 + 深阴影），但强调色仍是 ocrc 现行 zai 黑白——风险最小；A 的观感 = 完整 OpenBitFun（blue/cyan accent 翻转 + ghost 主按钮 + navy 墨 light 主按钮），才是截图里的样子。

---

## 5 · 未映射语义的两案处置

| 语义 | 案 1（推荐，样张采用） | 案 2（备选） |
|---|---|---|
| 语法高亮 `--hl-*` | **保留 zai 终端 ramp**（`--zai-tb-*`/`--zai-tl-*` 源头不动）。理由：OBF 只有 diff 语法色（codeDiff.syntax 6 类），无全功能高亮板；代码区保持 zai 连续性 | 映射 OBF codeDiff.syntax：keyword→`--hl-purple` 用 pink-450 `#ff678d`、string→green-400 `#34d399`、number→cyan-300 `#7cdee9`、property/variable→amber-450/525、comment→neutral-550/450。代价：与终端/图表 ANSI ramp 割裂，两主题各需调档 |
| 用户角色 `--role-*` | 保留 zai t-ramp | OBF 无对应物（identity.assistant pink 单色不适合四角色）——案 2 实际不存在，保留是唯一案 |
| find-highlight | 保留 zai 值（OBF 无搜索高亮 token） | — |
| 字体 | **保留 Inter/JetBrains Mono**（0.26.22 契约）。OBF system-ui + Fira Code 仅记录 | 若采纳：换栈 = 另立计划（涉及 D1 度量与 CJK 链，非本轮） |
| motion | **样张不动**。记录若采纳：`--ease` → `cubic-bezier(0.23,1,0.32,1)`（OBF standard）、`--dur-2` 180→220ms、新增 contentSwap 320ms 档 | 接线时随冻结口径一起裁 |
| density | OBF 走 `data-density` 机制 | 不采纳（机制性改动，撞 B3 精神） |

---

## 6 · 裁决建议（样张后定）

- **范围**：单套静态皮肤（A 或 B 二选一）先接线；不做多预设共存（设置面板皮肤选择器等第二套皮肤出现再说）。
- **落地形态**：**CSS 覆盖层**（`skin-openbitfun.css` import 于 ZCodeApp.tsx zcode-mobile.css 之后）——不替换 theme.css 值层（theme.css 被旧壳残留词汇与分享页共用，替换波及面大）；vendor 三块同名复制靠顺序赢。
- **冻结口径**：PRODUCT.md:100 需加一条例外（「OpenBitFun 皮肤覆盖层」），或把 M9「连颜色照抄 ZCode」修订为「默认 zai + 可选皮肤覆盖层」。**等样张裁决后另立计划**。
- **明确不做**：JSON token engine / 主题运行时导入导出（B3 判例 2026-10-12 维持）；marketplace；vendor 文件改动（覆盖层免登记）；OBF 代码/资产复制（只取不受版权保护的色值与设计语言，MIT 出处已在文首注明）。

## 7 · 样张复验清单（阶段 4 门禁）

- [ ] dark/light 双模下侧栏、时间线（user 气泡/工具卡/代码井/mermaid）、composer、设置-外观全部着色无「zai 残留岛」（重点：vendor 组件 + ocrc 组件交界）。
- [ ] A2 superellipse 圆角形状正常；radius 12/8 生效。
- [ ] A3 滚动条：圆胶囊 + 3px 透明边，thumb 色随 OBF。
- [ ] A4 键盘焦点环：Tab 可见，2px，颜色随 `--focus-ring`（A 案 dark=accent 蓝）。
- [ ] D1 字号设置 12–20 仍全站生效。
- [ ] reduced-motion 下动画瞬时完成（皮肤不新增 keyframes）。
- [ ] light 模式两轨（class 与 data-theme）表现一致。
