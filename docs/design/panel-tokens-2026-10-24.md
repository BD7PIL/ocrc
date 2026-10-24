# 面板设计令牌表（实测自 openchamber 2.5.1，2026-10-24）

> 出处：本机 openchamber 桌面 app（`@openchamberelectron/resources/web-dist` 的 JS bundle
> 内嵌样式）与 SDK `style.js`（`GUEST_UI_LOOK_CSS`，宿主追加给每个 guest 文档的样式副本）。
> guest 面板的视觉**只能**用这张表；`scripts/check-style-tokens.mjs` 是门禁。

## 字阶（三档，最小 12px——11px 不存在于整个体系）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--text-base` | 1rem（16px） | 页面级标题（当前由宿主 chrome 承担，面板未用） |
| `--text-markdown` | .875rem（14px） | 正文、卡名（配 `--font-weight-semibold`）、组头（配 medium） |
| `--text-code` | .75rem（12px） | 元信息（配 `--font-mono`）、耗时/时间戳、日志 |

## 字重 / 字体

`--font-weight-normal/medium/semibold/bold`（400/500/600/700）；
`--font-sans`（系统栈）/ `--font-mono`。

## 颜色（oklch 双主题，暗色由令牌双值自动跟随——不写颜色就自动获得暗色支持）

| 令牌 | 用途 |
| --- | --- |
| `--foreground` / `--muted-foreground` | 正文 / 次要文字 |
| `--border` / `--interactive-border` | 分区线 / 控件描边 |
| `--surface-muted` | 日志块底、结果 chip 底 |
| `--status-success / -warning / -error / -info` | 状态徽章、阶段轨道图标、错误横幅、升级徽章（info） |

## 圆角

`--radius-sm` .25rem ｜ `--radius-md` .4375rem（chip）｜ `--radius` .5625rem（卡片）｜
`--radius-xl` .75rem。

## kit 几何（SDK `style.js`）

按钮 32/28/24px 高 × 14/13/12px 字 × 500 字重 × `controlRadius`；五 variant
（default=主/secondary/outline/ghost/destructive）+ `loading` 自带 spinner。
Menu（下拉，destructive 项）、Progress、Tabs、Empty、Separator(label)、Spinner、icons
（chevron/check/close/search；`icon()` 未从 ui 入口导出，guest 侧按同 path 复刻）。

## 交互时序（参考 zcode，只学时序不学像素）

- 长操作运行 → 操作台自动展开：阶段轨道（tick 实测的状态迁移）+ 默认折叠的等宽日志
  （失败自动展开；贴底 ≤2px 才自动跟随；展开给复制）。
- 成功 → 3 秒收起成结果 chip（点开回看）；失败 → 保持展开 + 红横幅。
- 动作三级：唯一 primary（推进动线）/ outline 次级 / ghost 三级与折叠器；危险项
  destructive + 独立确认块。
- 组头 = 标题 + 计数（muted）+ 右侧动作；卡名 14px/600。

## 历史注记

0.9.x 的面板病灶：`oc-xs:11px` 低于体系最小字号、卡名裸 `<strong>` 不进字阶、维护动作
全是 ghost 文字链、依赖宿主未文档化类（`.oc-stack/.oc-muted`）。0.10.0 重写 guest.css 为
纯布局层后全部消除；`check-style-tokens.mjs` 防回归。
