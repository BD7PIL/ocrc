# 界面配色体系调研 · 「协调」从哪来 + ocrc 完整导入计划

- **状态**：2026-10-13 调研定稿；**2026-10-14 批 1 已接线**（提交 `22552dde`，取值 = 用户裁决的 ink v4 样张）。
  实测剂量：dark S=0.26%/M=11.62，light S=0.29%/M=10.97（参照带 S≈0.27/M≈11–12，全屏零实心品牌块）；
  R2 对比度 29/29（light `--text-2` 提 65% 修 4.10→4.80:1）；桥接序产物级实证（vendor@409935 < bridge@443055，
  compute-style 三轨探针 0 diff）。冻结口径已修订（PRODUCT.md「配色口径 2026-10-14」）。
  **批 2 吸收进批 1**（vendor 桥已随批 1 落地）；批 3（radius 刻度统一 14/9/6→12/8/6、桥接 var() 化、
  Tailwind 阴影对齐）与批 4 残项（CHECKLIST 登记复核）仍为后续。
- **剂量方法论（可复用）**：同壳同内容下先测「已被接受」的参照（zai 基线 / OBF 蓝皮肤）得目标带
  （S≈0.27%、B 无块状、M≈11–12），新皮肤剂量瞄准同一带；管线 = PPM 逐像素 + 绝对色度分档
  （P 存在感 d≥12 / S 强核心 d≥100 / B=20px 网格最大强占比）+ Hasler–Süsstrunk 色彩度。
  脚本在会话记录（/tmp/accent-measure.py、dose-final.py、colorfulness.py），fuzz 色距法已废弃（数据偏差）。
- **定位修正（用户原话）**：「OBF 不是标杆不是标准，是我个人认为还算协调的参考。」——所以本文调研市面上经受过大规模检验的配色体系，提炼可迁移的**方法**，OBF 只降级为样本之一。
- 证据源：Radix Colors 官方文档、Material Design 3、GitHub Primer、Tailwind v4、Apple HIG（Dark Mode）、Refactoring UI；本地实测 = `persimmon-theme.css`（rc.1 用户调校的柿橙）、`theme.css`（现行 zai）、OpenBitFun tokens（`/tmp/obf/`）。

---

## 1 · 六家成熟体系的共同做法（跨行业提炼）

| 体系 | 行业 | 核心机制 | 对「协调」的关键贡献 |
|---|---|---|---|
| **Radix Colors**（React 组件库） | 开发工具 | 每色 **12 阶固定语义刻度**：1-2 背景 / 3-5 组件态（常-hover-按下）/ 6-8 边框（弱-交互-强+焦点环）/ 9-10 实底 / 11-12 文字（低/高对比）；刻度内互测对比度有保证（APPCA Lc 60/90） | **阶 = 用途**。设计师不再挑颜色，只挑用途；同刻度任意两阶放一起天然协调 |
| **Material Design 3**（Google 全家桶） | 移动/全平台 | **tonal palette + HCT 感知均匀色空间**：每色一条 tone 0-100 亮度轴，主题=「角色→tone 映射表」（light surface=tone 98 / dark surface=tone 6）；低饱和中性+中性变体盘担大面积，主色只做点睛 | **同一条亮度轴取色** → 全界面亮度节奏统一；亮暗主题是同一轴的两段映射，不是两套颜色 |
| **GitHub Primer** | 开发者平台（亿级日活） | 两层 token：基础角色（fgColor/bgColor/borderColor × default/muted/emphasis）+ 组件模式 token（button 各状态、focus、overlay）；每个意图色（accent/success/danger…）fg/bg/border 三面成套 | **语义角色而非色值**；中性面全部 alpha 组合（`#818b981a`），任何底色上叠加都不脏 |
| **Tailwind v4** | Web 全行业事实标准 | 每色 11 阶 **OKLCH 手调**（非 lighten/darken 生成），同阶跨色感知均匀（所有 500 一样鲜、900 一样深）；9 套带倾向的中性盘（slate 冷 / stone 暖 / zinc 微冷…） | **中性盘的「倾向」定调性**：换一套灰，全站气质就变；色值质量靠人工逐阶校准 |
| **Apple HIG Dark Mode** | 桌面/移动 OS | 暗色≠反色：高程越高面越亮；饱和色在暗底上「振动」，必须提亮/降饱和再上暗底；语义色（systemBlue 等）亮暗两套值动态切换 | **暗色是独立设计的盘**；大面积纯白文字刺眼，用次级灰白阶 |
| **Refactoring UI**（设计方法论） | 通用 | 灰要 **8-10 阶**（不是 3-4 阶）；先定「按钮底」基准阶 + 最深文字阶 + 最浅染色底阶，中间对半补；accent 克制使用 | **从用途倒推刻度**，禁止现场 lighten/darken 造色（造出几十个近似色=没有体系） |

**收敛成五条公理**（下面诊断和方案全部挂在这五条上）：

1. **阶即用途**：一条刻度里每一阶生来就有用途（底/组件/边/实底/文字），组件只许按用途取阶。（Radix/M3/Primer）
2. **亮度轴统一**：所有颜色（含 accent 与语义色）来自同构的亮度轴，全界面只有一个亮度节奏。（M3 tonal / Tailwind OKLCH）
3. **中性盘带倾向**：大面积灰不是纯灰，带一点品牌色的倾向（暖/冷），定全站气质；数量要够（8-10 阶）。（Tailwind/Refactoring UI）
4. **暗色独立设计**：暗色不是亮色反转——高程提亮方向、饱和度降档、白字降为灰白阶，两主题是同一角色表的两套映射。（Apple/M3/Radix）
5. **角色化消费**：组件只消费语义角色 token，永远不写裸色值；换肤=换角色映射表。（Primer/全部）

---

## 2 · 用五条公理诊断：为什么 OBF 协调、现在的 ocrc 不够协调

> 「协调」的观感本质 = **亮度节奏统一 + 边框/底面对比关系成刻度 + accent 克制而贯通**。OBF 三条都占；现行 zai 壳三条都有暗伤。值得强调：**这三条伤都不是 zai 色值本身难看，而是 M9「连色值一起照抄」时丢掉了 ocrc 原有的体系性**——我们的 rc.1 柿橙其实做对过（见 §2.3）。

### 2.1 逐条对照

| 公理 | OpenBitFun（参考样本） | 现行 ocrc（zai 壳） | 柿橙 rc.1（封存） |
|---|---|---|---|
| ①阶即用途 | 12 阶刻度+语义角色双层，边框三阶白 0.12/0.18/0.30 | `--border`/`--border-2` 两阶 + hover/selected 四个孤立 rgba——**边框没有刻度**，组件各写各的 | `--border #262626` 发丝线单值——最简但自洽 |
| ②亮度轴统一 | 全部取自 neutral 冷灰一条轴（950→0），accent blue/cyan 同轴贯通 | **两套灰阶拼贴**：ocrc 面 `#161616→#202020→#2b2b2b`（暖，zai 桌面阶梯）× Tailwind `neutral-*`（另一条冷灰）× vendor 组件内散落的字面灰（`#363636` tag 等）——**亮度节奏在三套之间打架** | `#0d0d0d→#121212→#171717→#1f1f1f` 一条暖黑轴 + `#262626` 发丝，节奏统一 |
| ③中性盘倾向 | 冷灰（blue-black 倾向）与蓝 accent 同族 | zai 中性盘无明显倾向；ocrc 专属面（focus 环/信息蓝/unread 天蓝/紫 idle）与 zai 灰**不成族** | 暖黑（ink wash）+ 柿橙 accent 同族（暖） |
| ④暗色独立设计 | canvas/panel 两级 + 深阴影高程，语义色两主题**同值恒定**（蓝 `#2e7eff` 不随主题变） | 基本合格（zai 双主题原盘），但 ocrc 派生色（--text-3/4 等）只有暗色语义 | 双套静态值（`--oc-static-*-dark/light` 全刻度成对） |
| ⑤角色化消费 | token→角色→组件三层，改一处全局变 | ocrc theme.css 是好的（LAYER 0/1/2）；**vendor 面仍写死字面色**（terminal ANSI、图表族、node 族）——换主题只换得到一半 | 同 theme.css 架构，同样受 vendor 面限制 |

### 2.2 直接回答：为什么它们比现在的 ocrc 协调

1. **OBF 的灰只有一条轴**。它的近黑 `#0e0e10/#1c1c1f`、边框白 alpha 三阶、文字四阶全部从同一条冷灰轴取——你眼睛接收到的亮度关系处处同构，这就是「干净」。而当前壳里 ocrc 面（zai 灰）、Tailwind 工具类灰（neutral）、vendor 组件字面灰三套并存，亮度节奏在块与块之间微跳，说不出哪里错但处处差一口气。
2. **OBF 的边框是刻度**。subtle/default/strong 三阶 + field 边框独立两阶，交互/非交互/焦点各就各位；当前壳只有 `--border/--border-2` 两阶加几个孤立 hover 值，导致有的框太重、有的太轻。
3. **OBF 的 accent 有克制的叙事**：每主题一个 accent（dark 蓝 / light 青），大面积低饱和表面，accent 只出现在交互与少量文字上；link 色、focus 环、control.highlight 全部由 accent 族派生。当前壳的 accent 是「白/黑」——等于没有品牌叙事，同时 ocrc 专属彩（信息蓝、紫 idle、天蓝 unread）又各自为政，形成「无主色但满屏小彩点」的松散感。
4. **几何与字排也是体系**：OBF 的 radius 刻度（4/6/8/12/16/20…）每档有用途，字排是语义角色（heading.page/welcome/body.md）；zai 壳 radius 只有 ocrc 侧 5 档、Tailwind 侧另一套，vendor 组件消费 Tailwind 默认值——圆角节奏同样不统一。

### 2.3 关键自省：我们丢掉的不是颜色，是体系

对照 `persimmon-theme.css`：rc.1 的柿橙暗色是 `#0d0d0d → #121212 → #171717 → #1f1f1f` 单轴暖黑 + `#262626` 发丝线，亮色 `#f2efe8` 纸白——**这就是公理 ②③ 的正确做法**（那条暖黑轴的「ink wash」倾向与柿橙同族）。当年 M9 裁决「连颜色一起照抄 ZCode」时，把这套自洽的轴换成了 zai 的三块拼贴。所以正确的路线不是「抄 OBF」也不是「抄 zai」，而是：**重建自己的轴，把品牌色放回轴上**——OBF 证明的只是这条方法论成立。

---

## 3 · 完整导入计划（分四批，各批独立提交、双端门禁）

> 总原则（from §1）：不抄任何一家的色值表，**抄结构**——刻度分层 + 单一亮度轴 + 角色化。OBF 的近黑双平面、Primer 的 alpha 边框、Radix 的阶即用途、Apple 的暗色降饱和，全部吸收进一套 ocrc 自己的「ocrc ink」体系；品牌色用回柿橙（用户调校过、有暖黑轴配 Dump）。

### 批 1 · ocrc ink 轴重建（theme.css 值层重写，组件零改动）

- **LAYER 0 新原料**：定义 `--oc-ink-*` 单一暖黑轴（暗色 10 阶：`#0c0c0e → #ffffff`）与 `--oc-paper-*` 暖纸白轴（亮色），**带 2-3% 柿橙倾向**（Tailwind stone 的做法）；accent 柿橙 `#fb8b3c`（dark）/`#e4580f`（light）各生成 5 阶（Radix 9/10/11/12 + surface 档），语义色恢复 persimmon 双主题刻度。
- **边界刻度**：边框改 Primer 式 alpha 三阶（暗色白 0.08/0.13/0.22，亮色 ink 0.08/0.14/0.24），替换现 `--border/--border-2` 双值；`--border-2` 保留为兼容别名指向第一阶。
- **token 名结构不变**（M9 配方继续成立：组件零改动换值）；KEEP-IN-SYNC 双轨照写。
- **门禁**：双端测试全绿 + 4199 截图矩阵（主视图 dark/light）+ 契约探针（A2/A3/A4/D1 五条）+ 与 zai 壳并排对比板。
- **工作量** M；回归风险 中（色值全变，但角色不变）。

### 批 2 · vendor 面变量接轴（零 vendor 字节改动）

- 用皮肤覆盖层形态（`skin-ocrc-ink.css`，本轮已验证的接缝：vendor 三块同名选择器 + 加载顺序取胜）把 vendor `--color-*` 143 条映射到 ink 轴：neutral 系指向轴、边框三阶、语义四色、保持 terminal ANSI/图表族不动（领域色保留 zai 值，它们是内容不是 chrome）。
- Tailwind 侧 `--radius-*`/`--shadow-*` 对齐 ocrc 刻度（样张已验证可覆盖）。
- **门禁**：同批 1 + vendor 组件重点巡检（popover/toast/tooltip/tag/menu 四态）+ CHECKLIST 核对一遍（不改 vendor 文件则免 PATCHES）。
- **工作量** M；回归风险 中。

### 批 3 · 几何与字排刻度（最小 vendor 面）

- radius 统一：ocrc 5 档映射 OBF 式用途档（panel 12 / card 8 / control 6 / pill）；焦点环 2px 已达标不动。
- 字排：`--ui-font-size` 机制不动（D1），新增两个语义角色档（`--ui-title` 页标题 / `--ui-section` 区块标题）映射现有 calc 档，不新增字号。
- **门禁**：typecheck + 视觉抽查 + 字号设置 12-20 全站生效复验。
- **工作量** S；回归风险 低。

### 批 4 · 冻结口径修订 + 收尾

- PRODUCT.md:100 修订：M9 从「连颜色照抄 ZCode」改为「**默认皮肤 = ocrc ink（自建轴）；zai 双主题保留为上游对齐参照**」；persimmon-theme.css 头注更新为「品牌色来源」。
- 台账 harness-best-of B3 段补终局记录；AGENTS.md 架构段一行带过。
- **门禁**：全站 dark/light 截图矩阵 + 文档门禁 + 构建产物确认。
- **工作量** S。

### 明确不做

- 主题运行时导入/JSON 引擎（B3 判例继续维持）；
- marketplace/皮肤选择器（先单皮肤落地）；
- vendor 文件字节改动（覆盖层路线已验证足够）；
- 语法高亮/终端 ANSI/图表族换色（内容色不是 chrome，保留 zai ramp；ink 轴落地后若仍违和，另批评估）。

### 与本轮已交付物的关系

- `skin-openbitfun.css` 保留入库（A/B 样张配方 + data-skin-neutral 差集开关已验证的覆盖层机制），批 2 直接复用该接缝写 `skin-ocrc-ink.css`；OBF 样张作为「结构可行性证明」归档。
- 映射文档 `openbitfun-skin-mapping.md` 的接缝结论（§2 盘点）全部有效；色值映射部分由本文档 §3 的 ink 轴方案取代。
