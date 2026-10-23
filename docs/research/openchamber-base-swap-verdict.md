# 基座替换总判定：openchamber（Win/Mac 面板）+ EL7 被控端 + octg 式 CI 跟随

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **日期**：2026-10-14
- **性质**：三份子调研的汇总判定。细节以子报告为准：
  - 功能面与扩展缝 → [openchamber-feature-surface.md](openchamber-feature-surface.md)
  - 发版跟随与 CI 工作流 → [openchamber-release-following.md](openchamber-release-following.md)
  - omo-slim 身份与接入 → [omo-slim-identity.md](omo-slim-identity.md)
- **实测前提**（本机 EL7/glibc 2.17，2026-10-14）：opencode v2.0.27 原生可跑（`@opencode/cli-linux-x64` 符号上限恰为 GLIBC_2.17）；Node 24.14 起不来（GLIBC_2.28 + CXXABI_1.3.11）。

## 目标拓扑（用户裁决的三机分工）

```
[Win/Mac 面板宿主]  openchamber（Node 24，官方通道自更）
        │  OPENCODE_HOST + OPENCODE_SKIP_START（external 引擎）＋ SSH -L 正向转发
        ▼
[EL7 被控端]  opencode v2 serve（唯一常驻）
        ├─ ocrc IM 通道插件（TG/飞书/钉钉/企微，共生拓扑）
        ├─ omo-slim（多代理编排，可选）
        └─ 形态 B（air-gap）：ssh -R 反向推 HTTP 代理 ← 被控 opencode 的 HTTPS_PROXY
```

## 总判定

| 提案项 | 判定 | 依据 |
|---|---|---|
| openchamber 只跑 Win/Mac | ✅ | npm `@openchamber/web` + GitHub Releases 双渠道，自更新可编程覆盖 |
| EL7 被控端接 external 裸 opencode | ✅ 推荐路径 | `OPENCODE_HOST`+`OPENCODE_SKIP_START` 一手文档；`compatibility.js` 专门探测外部 2.x 引擎 |
| air-gap（形态 B） | ✅ 自洽 | openchamber 对被控机出网零假设；`ssh -R` 是其 extra forwards 一等类型；opencode 原生尊重 `HTTPS_PROXY` |
| octg 式 CI 跟随（不 fork） | ✅ 可行，代价可算 | 双版本线解耦 + manifest 联动；工件=npm tgz（sha512 与 bin-cache 对齐）；工作流见子报告 §7。成本：~5 版/13 天 → 每周 2-3 次回归冒烟 |
| IM 通道矩阵 | ✅ 零改动 | 通道住被控端 opencode 配置数组，不经 openchamber 发版 |
| omo-slim 接入 | ✅ 有条件 | MIT；装被控端 plugins 数组（v2 ≥ 2.0.7）；**唯一硬风险 = EL7 上 ast-grep/jsdom 原生依赖未实测** |
| **接入 ZCode 改造的功能** | ⚠️ **黄档——本方案唯一待决点** | 见下节 |

## 黄档详解：「接入 ZCode 改造的功能」能落到哪

openchamber 的第三方缝只有一条是官方契约：**iframe 扩展**（`@openchamber/sdk`，apiVersion=1，能力审批模型），注入点覆盖 panel/page/statusSection/fileEditors/actions/slash/声明式工具卡/本地 service——深，但**只在前端层，够不到 server 会话循环**；主题=纯配色 JSON，无布局/组件缝；server HTTP API **无公开契约**（能通，属逆向，v1→v2 曾单 commit 换血 7 万行）。

由此，ZCode 侧资产的去向逐域对账（PRODUCT 第零点七条）：

| 域 | 在 openchamber 架构下的命运 |
|---|---|
| 壳全家（三栏/cmdk/快捷键） | **弃**——它有自己的壳（CommandPalette/可自定义快捷键），ZCode 母版对齐程序终止 |
| 聊天流（card/sdelta 契约、composer 全家） | **弃**——它直接吃 opencode 2.x 全局事件流，自有管线；扩展只能声明工具卡，不能换管线 |
| 右栏 SidePane | 部分延续——它有右栏多 tab + 扩展 panel 可注入自定义页签 |
| ocrc 域（新建任务两态/自动化/通道面板） | 通道面板**存续于引擎侧**；transport×lifecycle 由它的 managed/external 两态替代；自动化由它的 Loops/scheduled-tasks 替代 |
| 设置域 | 弃——它有 providers/agents/MCP/skills 全套设置面 |
| 增值四件 | 内嵌浏览器 ✅（preview/browser-control 更强）；分享页/画板/真分屏无 |
| 通道升级（TG 深耕+三企） | **完整存续**（引擎侧插件，零接触面） |

**结论**：以 openchamber 为基座 = 从「自绘 ZCode 级驾驶舱」转为「消费 openchamber 的 UI + 在引擎侧与扩展缝做增量」。ZCode vendor 体系（web-next、PATCHES/CHECKLIST 登记）在此架构下没有挂载点。若要 ZCode 级深度定制 = fork 它的 6600 文件 monorepo，与「不 fork CI 跟随」互斥。

## 红档（明确不可行，勿再投入）

- **managed 远程实例指向 EL7**：被控机要装整个 openchamber（Node ≥24.14）+ 预装 opencode + 被控侧下载 → glibc 与 air-gap 双重不可行（ssh-manager.mjs 实证）。
- **connect-devices / Private Relay 配对裸 opencode**：配对是 openchamber server 的功能，被控端无实例即无服务端。external 路径的访问控制回到 SSH + opencode server 密码（`OPENCODE_SERVER_PASSWORD`，ocrc 已有 Basic 支持）。
- **官方 Docker 镜像**：不存在（GHCR/Docker Hub 零发布），只有源码自建；仅作兜底选项。

## ocrc 在新架构中的存续形态

ocrc 不消失，是**收缩换位**：从「全栈驾驶舱」收缩为「被控端 agent + 通道插件 + provisioning 工具 + **面板侧连接扩展**」。这恰好落在 openchamber 的空白区——它没有轻量被控 agent 概念（remote = 桌面连另一台 openchamber），**「opencode + ocrc 轻量 agent + SSH」覆盖它 managed 模式永远覆盖不了的 EL7/air-gap 场景**（子报告 D3 原文判定为差异化而非对齐点）。PRODUCT 第零点五条的 adopt-first 在 external 引擎模式下被上游正面支持（`OPENCODE_SKIP_START` 即 adopt 语义）。

**面板侧扩展一（2026-10-14 用户裁决：不写独立小工具，以 iframe 扩展形态做）**：连接档案/隧道守护作为 openchamber 扩展实现——UI 层（沙箱 iframe：右栏 panel + statusSection 健康徽标，能力申请 `storage`+`service`）+ service 进程（openchamber 代拉的本机 Node 进程，spawn `ssh -L 4096:...` 并守护保活），档案存 host.storage。引擎接入走「隧道落地默认端口 4096 + 启动自动探测」路径，**全程零环境变量**。git 仓库安装可享上游每小时自更新。边界如实记录：扩展触碰不到 server 的引擎配置/env（换引擎需重启 openchamber，实测项）；mobile/VS Code 不加载扩展（可接受，手机不管隧道）；SSH 认证走 key（Windows 上 sshpass 类密码自动化不可靠）；service 能力装时一次性审批。

**面板侧扩展二（2026-10-14 用户裁决：omo 编排语义视图单独做一个插件）**：omo-slim 的子代理编排（Orchestrator→专家树）在 openchamber 原生 UI 里只是普通子会话/后台任务条目，无编排语义；本扩展用 `sessions`（读子会话树）+ `conversation`（读对话 payload）两个只读能力重组出编排树——树形视图（orchestrator→专家、各 lane 状态/token）、可跳转会话。设计要点：纯读、无 `service`、审批面最小，与连接扩展独立发版；**前置 spike = 摸清 omo-slim 在 session metadata 里写什么标记**——若有结构化标记则全语义化，若没有就按 parent-child + 命名约定推断（语义化降级）；omo 的 metadata 不是契约，解析要防御性（版本 pin 或容错降级），上游若把 `/preset` 服务端化（#1474 方向）视图可顺带挂预设切换。

## CI 跟随工作流（要点，全文见 release-following §7）

双版本线：线 1 = openchamber（Win/Mac，在线自更）；线 2 = EL7 opencode pin（离线推送）。
顺序铁律：**面板先升 → CI diff `compatibility.js` 的 MINIMUM_OPENCODE_VERSION 未越线 2 pin → 回归冒烟 → 产签名 bundle → SSH 推送被控端**。反向顺序会撞「新引擎语义 + 旧面板」未测矩阵。
两个固定回归点：① `/api/*` 无契约面（升级前跑 ocrc 消费面冒烟）；② **双写配置**——openchamber 的 managed plugin 物化（`managed-plugin-config.js`）与 ocrc/omo-slim 写的 plugins 数组同文件，需测合并互不吞。

## 下一步（按阻塞优先级；2026-10-14 用户裁决后更新）

1. ~~拍板黄档~~ **已裁决（2026-10-14）：接受「openchamber 的 UI 为准」**——ZCode 母版平替程序（web-next/vendor 体系）在此架构下终止，转为引擎侧 + 扩展缝增量开发。
2. **资源约束（同日裁决）**：本机跑不动 Docker——回归冒烟走云端 runner（ubuntu 自带 Node 24）；面板实例放用户 Win/Mac 日常机（与目标生产拓扑合一，开发即联调）；Docker 兜底路线全面作废。
3. **连接档案 = openchamber iframe 扩展（同日裁决）**：不写独立小工具；扩展+service 架构与边界见「ocrc 在新架构中的存续形态」节。**omo 编排语义视图 = 第二个独立扩展（同日裁决）**：只读重组编排树，前置 spike 是摸 omo 的 session metadata。
4. **EL7 上实测 omo-slim 原生依赖链**（ast-grep/jsdom，`HOME` 隔离 + 独立 `OPENCODE_DATA_DIR`）——唯一未验证的接入硬风险；**顺带完成 omo metadata 标记摸底**（扩展二的前置）。
5. 按 release-following §7 搭 CI 双线流水线骨架（监听/预检/冒烟/bundle 四阶段，冒烟阶段挂云端 runner）。
6. 开发侧免转 Windows：全部待写代码（插件/扩展/CI 脚本）为跨平台 Node/Web，开发继续在本机；Windows/Mac 只是「装官方包 + 扩展」的用户位。
7. 顺手项：给上游发「UI 管理外部引擎档案」feature request；EL7 上补一次 omo-slim 权限竞态复测（锁 ≥3.0.4）。
