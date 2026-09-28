# Agent 工具的动效设计原则（ocrc web 动效规范）

日期：2026-09-28 ｜ 来源：GetStream purposeful-animations、Material Motion 时长/缓动、
HIG 减弱动态、ChatGPT/Discord/Slack/Perplexity 的实际模式（见文末参考）。

## 核心论断

**Agent 工具里，动效的主体不是装饰，而是"工作的可见性"。** 用户等待的是
一个正在劳动的 agent：流式文本、工具行、思考折叠——这些"过程动画"本身就是
反馈；除此之外的一切入场/装饰动效都必须极度克制，且**绝不重放历史**。

## 七条规则（本仓库动效的判断标准）

1. **历史即即时（history mounts instantly）。** 打开会话时，全部历史一次性
   渲染，零入场动画。动效只属于"你注视时到达的新事件"。回放历史动画 =
   闪动（已踩坑：入场级联导致多轮会话打开闪屏）。
2. **流式即动画（streaming is the animation）。** 文本流式上屏、思考折叠、
   工具行 running→done 的就地变化是主反馈；容器只入场一次，token 级内容
   更新绝不重复触发容器动画。
3. **等待用叙事，不用大转轮。** 忙碌态 = 思考卡/工具行/脉冲点（叙事型），
   不用全屏 spinner；历史加载中 = 三点脉冲的安静占位，且**空态（"要让
   agent 做什么？"）必须等历史到位且确认为空才出现**——空态闪现是最伤的
   闪动源。
4. **入场 120–220ms、只动 transform/opacity、decelerate 缓动**
   （--ease-out cubic-bezier(.22,1,.36,1)）。只对"最新的那一个"元素入场
   （:last-child 或等价机制），永远不做全页级联。
5. **状态变化就地换装。** 审批卡 resolve、任务完成勾选：在原元素上切换
   状态样式，不做"删除旧的+插入新的"的进出场对。
6. **动效为可读性服务。** 弱化动态（prefers-reduced-motion）时全部入场/
   循环动画立即跳过（theme.css 全局杀开关）；被动画表达的状态必须有
   非动效冗余（颜色/文字）。
7. **智能滚动优先于动效。** 用户上滚阅读时，任何入场动效都不得争夺滚动
   位置（已实现：仅贴底时 re-pin）。

## 本仓库已落地的映射

| 表面 | 动效 | 规则 |
|---|---|---|
| 历史加载 | 即时渲染 + 三点占位 | 规则 1、3 |
| 新消息（含流式定稿） | 仅 :last-child 浮升 200ms | 规则 1、4 |
| 流式 | 文本节流上屏 + 思考卡 | 规则 2 |
| 工具行 | running 脉冲点 → done 原地变色 | 规则 5 |
| 审批卡/问题卡 | 本地换装 fade 150ms；外部 resolved/回放不播 | 规则 5、1 |
| 悬浮控件（跳到最新/加载更早） | fade 150ms / rise-sm 160ms 入场，消失瞬时 | 规则 4 |
| 断线横幅 | 180ms 自头部下滑入，消失瞬时 | 规则 4、5 |
| Inspector 列表（Skills/Worktrees） | 首次到达 fade 150ms；tick 重取不重播 | 规则 4 |
| REST 重同步 | 350ms 内压制 :last-child 入场（feedResyncing） | 规则 1 |
| 悬浮球 | 暗轨+进度弧 0.4s 生长；首现 pop | 规则 4 |
| 计划卡/建议 chips/palette/modal | pop/fade 入场，chips 45ms 级联 | 规则 4 |
| reduced-motion | 全局 .01ms 杀开关 | 规则 6 |

## 参考

- GetStream, "Purposeful iOS Animations" — 动画要敏捷精准、不增加感知延迟
  （github.com/GetStream/purposeful-ios-animations）
- Material Motion — 入场 decelerate、150–300ms、仅 transform/opacity
  （m3.material.io/styles/motion）
- Apple HIG — Reduce Motion（developer.apple.com/design/human-interface-guidelines）
- ChatGPT / Claude / Discord / Slack 模式归纳 — 历史零动画、流式为主体、
  打字指示器掩蔽延迟、上滚暂停自动跟随
