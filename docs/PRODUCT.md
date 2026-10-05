# PRODUCT.md — ocrc 产品宪法

> 每个新需求先过这一页。2026-10-05 经架构 grilling 定稿；**2026-10-06 修订（定位落案 + 双拓扑）**。修订需在此文件留痕。

## 第零条：定位（2026-10-06 落案）

**ocrc 是以 opencode 为引擎的远程驾驶控制面（control plane）**——不是 opencode 的插件，也不是 fork opencode 的二次开发。三个推论：

- **opencode 是可替换的算力内核**（AgentBackend seam 的存在意义），ocrc 自己的核心是 relay/CardBus/registry/双面板。我们不改 opencode 一行内核，全部通过官方 API 与官方插件机制。
- **双拓扑**，同一张功能矩阵的两种宿主：
  - **独立拓扑（第一公民）**：`ocrc host` 自带进程、spawn 或 **ADOPT**（`OCRC_SERVER_URL` 接入用户已在跑的引擎）自己的 opencode。常驻、开机自启、多机编排、桌面壳都长在这条拓扑上。
  - **共生拓扑（轻量接入）**：opencode 配置 `plugin` 数组加一行——保留「安装最简、进程归 opencode 管」的初心。生命周期随宿主。
  - 原则：**两种拓扑 = 同一功能矩阵**（host 曾缺 remote 驱动、已补齐）；功能差异只允许来自宿主物理边界（如共生拓扑无生命周期自主），不允许来自实现偷懒。
- **引擎关系二元性**：独立拓扑 ocrc 是主（对引擎有看护责任），共生拓扑 opencode 是主。用户选拓扑就是在选谁当主。
- **Windows 约束**：Windows 的 opencode 是 **desktop 版**——Windows 上的 ocrc 壳/控制面以 **adopt desktop 版引擎**为正解，不重复安装 CLI。

## UI 原则（2026-10-06 裁决）

- **右栏的显示能力 ≥ 中栏**：同一内容在右栏的渲染质量不得低于中栏（tool 输出含 md 切换，subagent 转写走统一 Card 管线）。
- 发布前必须过 **E2E 门禁**（`scripts/pre-release.sh`：typecheck + 全量测试 + svelte-check 0/0 + 双 build + 部署 + **真实流式断言**的 live smoke）。流式断开这类事故的教训：UI 全绿不等于管线绿。

## 第一条：ocrc 是什么

**远程驾驶你自己的、和你管辖的 opencode。**

- 单人自用起步，**企业内网受控环境**延伸（air-gapped 设备、流量经企业中转）。
- Local-first：无云、无多租户，LLM 凭证不出企业边界。
- 「守护」（生产可靠性）与「远程」（多机器）都是这条定义的自然延伸，不是膨胀。

## 第二条：架构原则——核心永远不知道壳的存在

每个新需求必须先声明落在哪一层，**不属于任何一层的不做**：

| 层 | 内容 | 判据 |
|---|---|---|
| **核心** | relay / CardBus / registry / 后端 seam | 换掉任何壳它都不变 |
| **壳** | Telegram ✅ / Web PWA ✅ / ocrc Desktop（规划中） | 可替换的表现面 |
| **宿主** | 独立拓扑：host（spawn / **adopt `OCRC_SERVER_URL`**）✅ / Windows 壳=adopt desktop（规划中）；共生拓扑：V1 插件 ✅（npm 数组，1.18.x 唯一可靠路径）/ V2 插件（待立项）；SSH remote ✅ | opencode 在哪跑、谁当主 |
| **分发** | npm 包 ✅ / 桌面安装器（随壳）/ 企业离线分发（未来） | 别人怎么装 |

代码里这个原则已经成立：`ControlPlane` seam 隔离四种宿主入口，核心共用。

## 第三条：组件分发模型

- **`@bd7pil/ocrc`**（被控端）：plugin + 守护/supervisor + CLI + 远程主机管理。
- **ocrc Desktop**（控制端，规划中）：窗口 + 托盘 + 生命周期编排 + 多设备枢纽。**薄壳**——不内嵌 agent 运行时（ZCode 厚是因为它的产品就是运行时；ocrc 的运行时是 opencode，自包含且 remote provisioning 已会安装它）。壳的启动链 = 检测/拉起本机核心（调守护）→ 等面板端口 → 开窗；双模式：控制端枢纽（主）+ 本机编排。
- **壳技术倾向 Electron**：opencode 官方桌面端 2026-05 刚从 Tauri 迁移到 Electron（commit b4147c8d），ZCode desktop 亦为 Electron——两个最直接参考都收敛于此，托盘/单实例/关窗到托盘/子进程生命周期都有现成蓝图（opencode desktop 的 health-poll + Basic + 超时 kill；ZCode 的 desktopTray）。最终定案推迟到壳项目启动。
- **企业离线分发**参考 DeepSeek harness 社区的 pinned-runtime 原子分发模式：运行时打进分发单元、零全局依赖、离线可装。

## 第四条：兼容基线

- 被控端 opencode **pin 1.18.x**——这个 HTTP API 形状是 ocrc 的方言；V2 支持单独立项（`v2-backend`/`control-plane` seam 已备好）。**2026-10-05 EL7 实测**：1.18.34（V1 最新补丁）在 glibc 2.17 正常运行——跟随 1.18.x 补丁版不破坏 EL7；V2 无公开 release、默认安装通道仍发 V1，冒烟脚本 `scripts/v2-smoke.sh` 就绪，拿到 V2 通道后复跑。
- **EL7（glibc 2.17）是遗留生产下限**，不强行升级；新部署 x86_64 现代 baseline。
- Windows 被控端 = 有界补丁（~~Node 端口探测替代 ss~~ 已落地：`portOwner()` 绑定探测 2026-10-05 合入；余项：配置路径对齐上游 Windows 约定、e2e 真机验证），排企业中转之后，做不做看需求。
- 信创 arm64 出现时再立项（scp 的架构匹配检查会拒绝跨架构，安全设计）。

## 第五条：明确不做

机器管理 · 多租户 · 云同步 · 通用聊天客户端 · 内嵌 agent 运行时 · 跟随 opencode latest（除非 V2 项目完成）· **个人微信自动化**（2026-10-05 裁决：只有 wechaty 类逆向方案，违反 ToS、封号风险真实，与企业场景背道而驰；企业侧通道 = 企业微信/飞书/钉钉的官方企业接入）。

## 附：企业通道矩阵（2026-10-05 评估）

三个企业级通道都走**官方企业接入**（不用社区逆向库）；每个 transport 约 M 级工作量（SDK 接入 + 卡片渲染器 + 回调 handler + 测试）。UI 配置面（channels.json 凭证 + 机器人面板）已按各平台真实所需字段预置。

| 平台 | 官方接入 | 与 ocrc 契合度 |
|---|---|---|
| 飞书 Lark | 自建应用 + WebSocket 长连接（官方 `@larksuiteoapi/node-sdk`）+ 交互卡片（按钮回调、卡片 API 更新） | ★ 免公网、卡片更新对齐流式+按钮模型 |
| 钉钉 DingTalk | 企业内部应用 + Stream Mode 出站连接（官方 `dingtalk-stream`）+ 互动卡片 | ★ 免公网、卡片交互成熟 |
| 企业微信 WeCom | 自建应用 + 回调（需公网可验证 URL）+ 模板卡片 | ★★ 官方稳定，多一道公网回调部署门槛 |

优先级由实际企业生态决定；三个都会接（用户裁决 2026-10-05），先到先做。

## 附：参照系（2026-10 勘察结论）

- **ZCode**（github.com/zai-org/ZCode）：左栏三桶模型（置顶/常规/归档）、服务端 LIKE 搜索 + searchSnippets、云朵/文件夹本地远程标识、远程连接四步向导（含「本地下载后上传/远端服务器下载」资源双模式——对应 ocrc provision 双路径）、企业代理的「环境消毒+受控回注」模型（HTTP_PROXY 默认剔除、仅受控路径回注、NO_PROXY 护 loopback、CA 走 NODE_EXTRA_CA_CERTS）。
- **opencode**（anomalyco/opencode，dev 分支）：桌面端 Electron + health-poll 生命周期；侧栏无搜索、归档无恢复——ocrc 左栏直接做满；provider `options.baseURL` 网关覆盖是企业中转的配置承载面；loopback 强制 no_proxy 防企业代理劫持本机流量（Tauri 时代踩过的坑）。
- **DeepSeek harness**：CLI + 本地 Web UI + 薄壳生态；pinned-runtime 离线分发；归档管理靠插件补齐——ocrc 应把归档做成一等能力（已纳入）。
