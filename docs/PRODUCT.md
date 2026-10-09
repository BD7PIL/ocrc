# PRODUCT.md — ocrc 产品宪法

> 每个新需求先过这一页。2026-10-05 经架构 grilling 定稿；**2026-10-06 修订（定位落案 + 双拓扑）**；**2026-10-07 修订（ZCode 平替驾驶舱落案：定位升级 + 功能范围 + backend 域模型 + provisioning/更新矩阵）**。修订需在此文件留痕。

## 第零条：定位（2026-10-07 修订）

**ocrc 是接近 ZCode 体验的开源 agent 驾驶舱（cockpit）**——以 ZCode 前端为蓝本的功能面平替，穿着 ocrc 自己的配色。三重身份：

1. **ZCode 功能面平替**：壳、交互、动效、快捷键、组件规格对齐 ZCode（`zai-org/ZCode`，Apache-2.0，按组件移植母版、保留 NOTICE 归属；不追上游、不是 fork）。
2. **自用生产工具（第一优先）**：远程驾驶你自己的、和你管辖的 opencode。单人自用起步，企业内网受控环境延伸。Local-first：无云、无多租户，LLM 凭证不出企业边界。
3. **走向开源发布**：文档先行、工程卫生保持；npm 发布冻结至用户点头（0.26.17+ 均未发布）。

三个推论：

- **opencode 是可替换的算力内核**：正式 **HarnessAdapter 接口层**（2026-10-07 裁决）——opencode 1.18 是第一个适配器；opencode V2、pi 为后续适配目标。ocrc 自己的核心是 relay/CardBus/registry/双面板。我们不改 opencode 一行内核，全部通过官方 API 与官方插件机制。
- **双拓扑**，同一张功能矩阵的两种宿主：
  - **独立拓扑（第一公民）**：`ocrc host` 自带进程、spawn 或 **ADOPT**（`OCRC_SERVER_URL` 接入用户已在跑的引擎）自己的 opencode。常驻、开机自启、多机编排、桌面壳都长在这条拓扑上。
  - **共生拓扑（轻量接入）**：opencode 配置 `plugin` 数组加一行——保留「安装最简、进程归 opencode 管」的初心。生命周期随宿主。
  - 原则：**两种拓扑 = 同一功能矩阵**；功能差异只允许来自宿主物理边界（如共生拓扑无生命周期自主），不允许来自实现偷懒。
- **引擎关系二元性**：独立拓扑 ocrc 是主（对引擎有看护责任），共生拓扑 opencode 是主。用户选拓扑就是在选谁当主。
- **Windows 约束**：Windows 的 opencode 是 **desktop 版**——Windows 上的 ocrc 壳/控制面以 **adopt desktop 版引擎**为正解，不重复安装 CLI。

## 第零点五条：backend 域模型（2026-10-07 新增）

**backend = (transport × lifecycle) 二元组**，两个正交维度贯穿一切链路：

- **transport（引擎在哪、怎么到达）**：本地直连 / SSH 隧道 / WSL / Docker。
- **lifecycle（谁拉起、生死归谁）**：
  - **adopt**——已有引擎接入，host 只驾驶、**永不 kill**（本地 `OCRC_SERVER_URL` 与远端「纯隧道」态都是它）。用户自己拉起的引擎，重启由用户负责，host 跟着重连。
  - **spawn**——host 拉起并管理生死；本地由 disposer 关闭，远端 spawn **绑隧道共生**（ssh 断则远端引擎死——防僵尸服务/版本漂移，故意设计）。
- 每种 transport 都存在两态；新建任务页/远程向导必须**显式呈现**（探测到已有引擎 → 「接入已有引擎」；没有 → 「拉起新引擎」），不得隐式。
- ZCode 对照：全系 spawn（本地 spawn、远端 deploy+spawn），无任何 adopt——**adopt-first 是 ocrc 的差异化**，也是「生产引擎零测试流量」铁律的架构基础。

## 第零点六条：provisioning 与更新矩阵（2026-10-07 新增，octg 惯例）

- **项目自持二进制**：host 维护官方工件缓存 `~/.ocrc/bin-cache/`——host 安装/更新时从 npm registry 官方平台包拉齐**多平台 pin 版本**（linux-x64/arm64；win32-x64 有界支持）。**按目标平台选工件，与 host 自身平台解耦**。
- **推送为主路径**：远端零联网依赖（scp 推缓存工件）；`curl opencode.ai/install` 降级为「远端自装」可选路径；只用官方工件（never musl/compat）。
- **中心化更新**：host 是唯一版本源。opencode 升级 = 升级 ocrc 一处（pin 随 host 走），**没有任何远端/客户端需要自己更新**；远端漂移检测（`inspection.version` ≠ host pin）→ 向导/面板「推送升级到 pin x.y.z」一键动作；web 资产随 host 发版。
- 企业代理 env（`httpProxy/httpsProxy/noProxy/caPath`）同时覆盖远端 serve 的 LLM 流量与安装/下载通道。
- 版本策略：**pin 1.18.x，不 follow latest**（PRODUCT 第五条）。

## 第零点七条：功能范围（2026-10-07 裁决）

**做**（ZCode 有母版的按母版）：

| 域 | 内容 |
|---|---|
| 壳全家 | 三栏骨架、左栏（新建任务/搜索/自动化/任务四视图/状态点/页脚）、命令中心（cmdk 三段）、快捷键三层架构 |
| 聊天流 | 回合式时间线（行级虚拟化）、markdown 管线（限速流式/Worker 高亮/CJK 友好）、PART 注册表、工具卡渲染器族、composer 全家（权限四档 chip/模型/思考/用量/窄容器收纳）、dock 模式（权限/提问/todo/revert 停靠 composer 下方） |
| 右栏 | SidePane 页签抽屉：子代理目录/子会话转写/任务/文件/Git/计划详情/工具输出/辅助对话/schedules/MCP + 回合导航轨 |
| ocrc 域 | 新建任务页（transport×lifecycle 两态 + provisioning 路径 UI 化 + 远端动态注册）、自动化主视图、通道面板（BotsDialog 寄存器）、PlanHud（ConversationStatusPanel 母版 + 自动展开规格保留） |
| 设置域 | Provider/模型配置（Key/URL/格式+拉模型列表+模态覆盖）、agent 模型映射方案库（导出/导入/切换）、项目 `.opencode/` 五件套（jsonc/commands/rules/AGENTS.md/skills 开关）、技能源管理（冲突检测+symlink 开关）、MCP 编辑。**知识库不做** |
| 增值四件 | 分享只读页（host 快照 6 端点+公开落地页）、工作台多会话分屏（纯前端）、whiteboard 画板（纯前端+发到聊天）、内嵌浏览器/browser-use（host 侧车无头浏览器+WS 流化+MCP 浏览器工具挂引擎） |
| 通道升级 | ZCode 六件传输可靠性（跨进程轮询锁/offset 手工确认/状态 sink/命令策略+菜单同步/附件通用管道/cron 先订阅防漏推）+ grinev 两件（媒体输出相册、session 深命令+运行中换模型） |

**不做**（2026-10-07 裁决）：host 原生 workflow runner（自研编排执行引擎）、终端页签、插件市场、treemapping（ZCode 自身已下架）、developer-tools（引擎不暴露网络级调试数据）、CUA 全家、登录/账号/订阅。

**改判**（2026-10-10，N12）：旧条文的「目标/goal」不再成立——**做**，且扩展为「以引擎插件钩子补齐 ZCode 体验面（goal / 闲时收尾 / workflow 最小形态）」。
**机制在引擎内（仅官方钩子，不改引擎、不追 opencode latest）、状态与调度在 host**；host 原生 workflow runner 仍然不做（workflow 走引擎自己的 dwf 面，ocrc 只做最小形态的接口位）。

## UI 原则（2026-10-06 裁决；2026-10-07 增补）

- **右栏的显示能力 ≥ 中栏**：同一内容在右栏的渲染质量不得低于中栏（tool 输出含 md 切换，subagent 转写走统一 Card 管线）。
- **配色冻结口径（2026-10-07）**：品牌橙 accent、语义色（ok/warn/err/info）、role 色一律冻结；中性灰阶（bg/border/text 梯子）允许向 ZCode 深色双层底靠拢——逐 token 审查 + 前后对比截图，不一把梭。
- **字体**：ZCode `--ui-font-size:14px` 相对阶梯 7 档 + mono CJK 链（0.26.22 已就位，不回退：无 antialiased、无 optimizeLegibility、mono 不落宋体）+ dsh 式字号一等设置（10–22px 全站缩放）。
- **动效**：ZCode 寄存器——流式入场 900ms expo-out + 入场去重 LRU、collapse 300ms、`prefers-reduced-motion` 全局降级；compositor-only（transform/opacity）。
- 发布前必须过 **E2E 门禁**（`scripts/pre-release.sh`：typecheck + 全量测试 + 双 build + 部署 + **真实流式断言**的 live smoke，0.27 起 svelte-check 换 web-next 的 tsc/vitest）。流式断开这类事故的教训：UI 全绿不等于管线绿。
- **测试流量铁律**：生产引擎（用户 :4096）零测试流量；一切冒烟/联调走隔离栈（mock :4098 + host :4199）。adopt 的引擎永不 kill。

## 第一条：ocrc 是什么

**远程驾驶你自己的、和你管辖的 opencode——用 ZCode 级别的驾驶舱。**

- 单人自用起步，**企业内网受控环境**延伸（air-gapped 设备、流量经企业中转）。
- Local-first：无云、无多租户，LLM 凭证不出企业边界。
- 「守护」（生产可靠性）与「远程」（多机器）都是这条定义的自然延伸，不是膨胀。

## 第二条：架构原则——核心永远不知道壳的存在

每个新需求必须先声明落在哪一层，**不属于任何一层的不做**：

| 层 | 内容 | 判据 |
|---|---|---|
| **核心** | relay / CardBus / registry / HarnessAdapter seam | 换掉任何壳它都不变 |
| **壳** | Telegram ✅ / Web（Svelte PWA→M4 退役；**web-next React 壳** ✅ 规划 M0 起）/ ocrc Desktop（规划中，与 web 共用 app 层） | 可替换的表现面 |
| **宿主** | 独立拓扑：host（spawn / **adopt `OCRC_SERVER_URL`**）✅ / Windows 壳=adopt desktop（规划中）；共生拓扑：V1 插件 ✅（npm 数组，1.18.x 唯一可靠路径）/ V2 插件（待立项）；SSH remote ✅（WSL/Docker 补真中） | opencode 在哪跑、谁当主 |
| **分发** | npm 包 ✅ / 桌面安装器（随壳）/ 企业离线分发（未来；自持工件缓存是其地基） | 别人怎么装 |

代码里这个原则已经成立：`ControlPlane` seam 隔离四种宿主入口，核心共用。

## 第三条：组件分发模型

- **`@bd7pil/ocrc`**（被控端）：plugin + 守护/supervisor + CLI + 远程主机管理 + 自持工件缓存。
- **ocrc Desktop**（控制端，规划中）：窗口 + 托盘 + 生命周期编排 + 多设备枢纽。**薄壳**——不内嵌 agent 运行时；与 web 共用同一 React app 层（platform 接缝预留，寄存器：ZCode `IPlatformService`）。壳的启动链 = 检测/拉起本机核心（调守护）→ 等面板端口 → 开窗；**adopt 已运行的 opencode desktop，没有则拉起**（ZCode 只有 spawn，adopt 是 ocrc 领先项）。更新逻辑参考 ZCode autoUpdater/manifest/强更门禁（壳自己的更新线，与 host 管的远端更新是两条线）。
- **壳技术倾向 Electron**：opencode 官方桌面端 2026-05 从 Tauri 迁移到 Electron，ZCode desktop 亦为 Electron——两个最直接参考都收敛于此。最终定案推迟到壳项目启动。
- **企业离线分发**：自持工件缓存（第零点六条）是其地基；参考 DeepSeek harness 社区 pinned-runtime 原子分发模式。

## 第四条：兼容基线

- 被控端 opencode **pin 1.18.x**——这个 HTTP API 形状是 ocrc 的方言；V2 支持单独立项（`v2-backend`/`control-plane` seam 已备好）。**2026-10-05 EL7 实测**：1.18.34（V1 最新补丁）在 glibc 2.17 正常运行。
- **EL7（glibc 2.17）是遗留生产下限**，不强行升级；新部署 x86_64 现代 baseline。构建环境 node ≥ 20（Tailwind v4 门槛；CI 20/22）。
- Windows 被控端 = 有界补丁（`portOwner()` 绑定探测已落地 2026-10-05；余项：配置路径对齐上游 Windows 约定、e2e 真机验证），排企业中转之后。provisioning 对 win32-x64 有界支持（adopt desktop 优先）。
- 信创 arm64 出现时再立项（自持缓存 + 按目标平台选工件后，跨架构推送天然支持）。

## 第五条：明确不做

机器管理 · 多租户 · 云同步 · 通用聊天客户端 · 内嵌 agent 运行时 · 跟随 opencode latest（除非 V2 项目完成）· **个人微信自动化**（2026-10-05 裁决：只有 wechaty 类逆向方案，违反 ToS、封号风险真实；企业侧通道 = 企业微信/飞书/钉钉的官方企业接入）· host 原生 workflow runner（2026-10-07 裁决；goal 已于 2026-10-10 N12 改判为做——机制在引擎钩子、状态在 host，见上）· 终端页签 · 插件市场 · 语音转写 · 管理员分层。

## 附：企业通道矩阵（2026-10-05 评估）

三个企业级通道都走**官方企业接入**（不用社区逆向库）；每个 transport 约 M 级工作量。UI 配置面（channels.json 凭证 + 机器人面板）已按各平台真实所需字段预置。

| 平台 | 官方接入 | 与 ocrc 契合度 |
|---|---|---|
| 飞书 Lark | 自建应用 + WebSocket 长连接 + 交互卡片 | ★ 免公网、卡片更新对齐流式+按钮模型 |
| 钉钉 DingTalk | 企业内部应用 + Stream Mode + 互动卡片 | ★ 免公网、卡片交互成熟 |
| 企业微信 WeCom | 自建应用 + 回调（需公网可验证 URL）+ 模板卡片 | ★★ 官方稳定，多一道公网回调部署门槛 |

优先级由实际企业生态决定；三个都会接（用户裁决 2026-10-05），先到先做。

## 附：参照系（2026-10 勘察结论；2026-10-07 增补）

- **ZCode**（zai-org/ZCode，Apache-2.0）：前端母版库——三栏壳/左栏四视图/命令中心/composer 控制簇/快捷键三层/19 种 SidePane 页签/ConversationStatusPanel/Automations 主视图/BotsDialog/SettingsPage/远程连接三目标（SSH/WSL/Docker 全本地）/自动化（croner+桌面端执行）/分享快照 6 端点契约/工作台纯前端分割树。桌面壳参考：Electron 41 + 每窗口 Host utilityProcess + IPlatformService 接缝 + autoUpdater。
- **DeepSeek harness**（deepseek-ai/deepseek-harness，244k★）：吸收——三层语义令牌（static→alias→specific）、superellipse/滚动条/焦点环三张全局表、0.5px 发丝描边+双层柔光高程、ContextMeter、TurnNavigator、字号一等设置（10–22px）、RiskConfirmation、TextShimmer。
- **opencode web**（sst/opencode `packages/app`，我们生产 `opencode web` 即在代理它）：吸收——24ms 限速流式、Markdown 渲染进 Worker、行级虚拟化时间线、PART_MAPPING 注册表、composer dock 模式、边框做进 box-shadow 的复合阴影、主题即 JSON、CSP+主题脚本哈希。
- **OpenCode-Client**（Mrsandman327，**无许可证，只吸收思路**）：设置管理信息架构（Provider/映射/项目五件套/技能源）、文件层原子写+JSONC 校验路线、知识库→资产化闭环（知识库本体不做）。
- **grinev/opencode-telegram-bot**（MIT）：ocrc 通道的血统上游之一；继续吸收媒体输出、session 深命令。
- **opencode**（anomalyco/opencode，dev 分支）：桌面端 Electron + health-poll 生命周期；provider `options.baseURL` 网关覆盖；loopback 强制 no_proxy。

## 附：重建路线图（2026-10-07 定案，0.27.x）

受控重建：`web-next/`（React）平行新建，旧 Svelte 壳冻结只修 P0，M4 用户验收后一次性切换删除。每程 = CDP 全组件矩阵 + 隔离栈门禁 + :4099 实测。

**M0 地基**（文档/脚手架/搬运层/双 root/令牌重组）→ **M1 壳** → **M2 聊天流** → **M3 右栏** → **M4 ocrc 域+退役切换** → **M5 设置域** → **M6 分享+工作台+画板** → **M7 浏览器/browser-use** → **M8 通道域升级**。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。
