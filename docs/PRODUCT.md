# PRODUCT.md — OCRC 产品宪法

> 每个新需求先过这一页。2026-10-05 经架构 grilling 定稿；**2026-10-06 修订（定位落案 + 双拓扑）**；**2026-10-07 修订（ZCode 平替驾驶舱落案：定位升级 + 功能范围 + backend 域模型 + provisioning/更新矩阵）**；**2026-10-14 修订（基座换位：openchamber 面板 + ocrc 收缩换位）**；**2026-10-16 修订（面板侧 provisioning 与项目级配置：换位后第一份能力契约，见第零点九条与 `docs/research/panel-provisioning-verdict.md`）**；**2026-10-16 二次修订（动线接入 + 运行时闭环：主机现状以命令 chip 交给模型、运行能在被控端真落地，见第零点九条末三段）**；**2026-10-17 修订（对端能力：远程 openchamber 实例 + 引擎 v2 门禁 + 出网中继 + 三级重连，见第零点十条）**。修订需在此文件留痕。

## 第零条：定位（2026-10-14 基座换位修订）

> **换位裁决**：调研 openchamber（MIT，opencode 之上的开源驾驶舱，11.5k★）后裁定
> **接受「openchamber 的 UI 为准」**——面板由它承担（Win/Mac，不 fork，external 引擎
> 模式接入被控端），ZCode 母版平替程序（web-next/vendor 体系）**终止开发、冻结不删**。
> ocrc 收缩换位为：**被控端 agent（opencode v2 + 1.18 双代）+ IM 通道矩阵 +
> provisioning/离线推送（2026-10-16 定案：全链落在**面板侧**扩展，见第零点九条）+
> 面板侧 iframe 扩展（连接扩展、omo 编排视图）+ octg 式 CI
> 跟随**。完整判定与拓扑见 `docs/research/openchamber-base-swap-verdict.md` 与
> `docs/research/e1-verdict.md`。**不改名**（语义仍指准 remote control）。
> 以下三重身份的历史条文保留原样作为沿革记录（第 1 条由 openchamber 承担）：

**ocrc 是接近 ZCode 体验的开源 agent 驾驶舱（cockpit）**——以 ZCode 前端为蓝本的功能面平替，穿着 ocrc 自己的配色。三重身份：

1. **ZCode 功能面平替**：壳、交互、动效、快捷键、组件规格对齐 ZCode（`zai-org/ZCode`，Apache-2.0，按组件移植母版、保留 NOTICE 归属；不追上游、不是 fork）。
2. **自用生产工具（第一优先）**：远程驾驶你自己的、和你管辖的 opencode。单人自用起步，企业内网受控环境延伸。Local-first：无云、无多租户，LLM 凭证不出企业边界。
3. **走向开源发布**：文档先行、工程卫生保持；npm 发布冻结至用户点头（0.26.17+ 均未发布）。

三个推论：

- **opencode 是可替换的算力内核**：正式 **HarnessAdapter 接口层**（2026-10-07 裁决；**2026-10-12 命名改判**）——opencode 1.18 是第一个适配器；opencode V2、**omp（原生 ACP）/ pi（经第三方桥 pi-acp）/ gjc** 为后续适配目标（原「pi」裸名改判：pi 本体官方无 ACP，裸名接不进现有 `AcpBackend`）。ocrc 自己的核心是 relay/CardBus/registry/双面板。我们不改 opencode 一行内核，全部通过官方 API 与官方插件机制。
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

## 第零点六条：provisioning 与更新矩阵（2026-10-07 新增；**2026-10-16 换位修订**）

> **换位**：基座换位后，驱动 provisioning 的机器从「被控端 host」变成「面板宿主（Win/Mac）」。
> 本条按 2026-10-16 裁决重述——**版本源、工件缓存、驱动面全部落在面板侧**；被控端不再承担
> provisioning。完整裁决见 [panel-provisioning-verdict.md](research/panel-provisioning-verdict.md)。

- **面板自持工件缓存**：面板侧扩展维护官方工件缓存（沿用 `core/bin-cache.ts` 的算法），从 npm registry 官方平台包拉齐**按目标平台**选取的版本（被控端 linux-x64/arm64；win32-x64 有界支持）。**按目标平台选工件，与面板自身平台解耦**——面板是 Win/Mac、被控端是 Linux，这是常态而非例外。
- **两条取件路，一个开关**：先探测被控端出网能力（对官方源的连通性），通则**被控端联网直取**，不通则**从面板推缓存工件**（air-gapped 场景零联网依赖）；两条路产物必须过**同一套 sha512 校验**。只用官方工件（never musl/compat）；官方 bash 安装脚本**不作为主路径**（无完整性校验）。
- **落点与身份**：被控端装到 `~/.opencode/bin/`（官方默认路径，与 openchamber 安装器同款），**绝不覆盖用户既有安装**；部署身份用**工件 sha512 记在被控端 marker**（不是版本字符串），以区分「同版本重发」与「升到一半」两种脏态；推送前旧二进制备份 `.ocrc-bak`，失败自动还原；卸载 = 删该目录 + 我们的 marker。
- **中心化更新（版本源已换位）**：**面板宿主是唯一版本源**——被控端装「面板宿主正在运行的那个 opencode 版本」（镜像），推前用 openchamber 的 `isSupportedOpenCodeVersion` 复核不低于其门禁。被控端**不做自更新**；漂移检测 → 面板「推送升级」一键动作。
- **provisioning 清单从「二进制」扩为「能力包」**：opencode 引擎 + **Node 运行时（按目标平台，装进我们自己的命名空间）** + ocrc 插件 + MCP 能力所需的运行时/二进制。MCP 声明里的 `npx -y X` 形态在同步时**改写为指向预装好的本地入口**，运行期不再依赖 npx 联网。**omo-slim 默认不装**。
- 企业代理 env（`httpProxy/httpsProxy/noProxy/caPath`）同时覆盖被控端 serve 的 LLM 流量与安装/下载通道。
- 版本策略：**镜像面板宿主、不 follow latest**（第五条「不追上游」仍然成立）。

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

**改判**（2026-10-10，N12）：旧条文的「目标/goal」不再成立——**做**，且扩展为「以引擎插件钩子补齐 ZCode 体验面（goal / 闲时收尾 / workflow）」。
**机制在引擎内（仅官方钩子，不改引擎、不追 opencode latest）、状态与调度在 host**。

## 第零点八条：远控会话与配对（2026-10-10 新增，P-remote 裁决）

**对齐 ZCode v3.15.1 手机扫码配对语义；不做中继**（隧道用户自理——「隧道我来
解决」），**LAN 直连即可信**（「我们局域网还是安全的」为信任边界裁决）。

- **两层角色，生命周期完全解耦**：
  - **锚设备**（桌面）：持永久 token，`ocrc start` 打印 `#token=` 链接进入；
    远控会话的刷新/停止**从不管它**。撤销 = `ocrc pair --reset` 轮换。
  - **手机**：LAN 扫码/配对链进会话，拿**会话凭证**（内存态、主机重启即清、
    每台独立）；会话刷新（新 epoch）踢全部手机、停止关门——对齐官方
    「刷新二维码」语义及其确认弹窗。
- **TG Bot 通道 = 常驻专线**：一次配置长期有效，配对/会话机制**零改动**
  （`/pair` 只是给手机发一条会话入场景链接）。
- 会话管理仅限主机本机（loopback 403）；非 loopback 浏览器管理按钮置灰。
- `WEB_AUTH=cf-access` 下无会话（409）。per-device 撤销不做（锚/会话两层已覆盖）。
- **明确不做**：中继/隧道服务、跨网可达、per-workspace 会话范围、vendor 快照
  随本工作升级（3.14.3→3.15.1 单独立项）。

**workflow 二次改判**（2026-10-10，P0–P3 落地）：不再只是「最小形态的接口位」。定稿条文是
**「引擎 vendored + 工具走官方钩子 + 状态/调度/审批/预算在 host」**——上游 ZCode 的 dwf 引擎
（`dynamic-workflow` + `dynamic-workflow-runtime`，Apache-2.0，登记制 vendor）负责编译、
typed schema、repair/nudge、replay/resume 与 `vm` 沙箱；ocrc 写 driver 与 host 状态面
（journal、并发、预算、审批、产物、saved workflows），模型经官方 `tool` 钩子拿到
`CreateWorkflow` 等工具。**host 原生 workflow runner（自研编排执行引擎）仍然不做**——
那条旧裁决一个字没动，改判的是「引擎自己的 dwf 面能不能整套用上」，答案是可以，且不用
重造任何编排逻辑。

**workflow 面板面落地**（2026-10-10，P4 + P4b）：`/z/` 里 workflow 面按 vendor 的验收表
逐项对账完成——时间线 run 卡、状态面板 Workflows 分区（含展开后的正文与 run 目录入口）、
run/workspace/artifact/目录四张侧页、saved workflows 面板、侧栏轨道、冷快照不丢 run、4 条命令可用。
**产品口径上「ZCode 有而我们没有的 workflow 体验面」归零**，剩下的是产品裁决不做的项（见上）。
一处**如实拒绝**写在 UI 与文档上，不留静默降级：`moveSavedWorkflow`（全局→项目）拒绝——
ocrc 的已保存 workflow 是一个机器级 store，没有可搬的文件。amend 的转录种子已实现（分歧 actor
的会话从前驱转录复制；缺 `forkSession` 的后端如实降级为空会话并记日志，**不拒绝修订**），仍余
两处按能力/代数降级：不带 in-flight 条目、resume 只回看一代前驱（见 docs/workflow-p4-record.md）。

## 第零点九条：面板侧 provisioning 与被控端项目级配置（2026-10-16 新增）

> 换位后的第一份能力契约。要解决的问题：**面板（Win/Mac）与扩展今天只会开隧道**——
> 被控端必须「已装且已启动」引擎，否则扩展什么都做不了；而现有配置桥写的是被控端
> **全局层** `~/.config/opencode/opencode.json`，与「不直接操作对端用户级配置」的设计意图冲突。
> 本条约定的原则是**「面板控制一切：只要有 ssh，就一定有相应的能力」**。
> 完整裁决（D1–D19 与取证）见 [panel-provisioning-verdict.md](research/panel-provisioning-verdict.md)；
> 上游同构参照是 ZCode 的 `detect → deploy → exec → 握手` 管线（被控端只需 sshd + POSIX sh + tar + 可写 `$HOME`）。

- **全链落在面板侧扩展**（D2）：检测 → 取工件 → 推送/联网安装 → 写配置，四步都在
  `extensions/ocrc-remote`。引擎侧 ocrc 的 provisioning 降为「已装 ocrc 的被控机」辅助路径——
  鸡生蛋：被控机连引擎都没有时，那边没有 ocrc 可驱动。
- **自动程度固定为「检测全自动、安装与写配置一次显式确认」**（D3）：检测在连接时与手动刷新时自动跑；
  安装/写配置必须一次显式确认，可勾「此主机不再询问」。阶段 2/3 会往被控端装东西，这条门禁不得绕开。
- **就绪四档阶梯**（D8，逐档给出可执行动作，不做「部分可用」模糊态）：
  ① ssh 可达 → ② POSIX sh + tar + 可写 `$HOME` → ③ 引擎在位且版本匹配 → ④ 远程工作目录存在且可写。
- **档案 = 主机级**（D16）：`{host, user, port, keyPath, 引擎版本, 运行时, 转发}` 绑主机；
  **项目目录是它下面的子项**。隧道、引擎、运行时、版本都是主机级的，绑到项目上会导致重复探测/重复安装。
- **项目级配置是唯一写入目标**（D5/D9/D10/D11）：写 `<远程工作目录>/opencode.jsonc`（存在 `.jsonc` 就写 `.jsonc`，
  保不住注释就如实提示）；**全局层只读不写**；读远端现状→只写差异、`.ocrc-bak` 兜底、失败回滚、`syncId` 幂等；
  绝不「每次请求都写」、绝不无条件覆盖。
- **同步单位是能力，不是凭据类别**（D11/D12/D13/D14）：每项能力声明它的需求（**密钥 / 网络可达 / 运行时**），
  由 provisioning 在目标侧凑齐——内网地址 → SSH 隧道（按方向补）；本机进程 → 目标侧起进程；
  本机二进制/运行时 → 纳入能力包安装。产物清单含 **Node 运行时（按目标平台，装进我们自己的命名空间）**；
  MCP 声明里的 `npx -y X` 在同步时改写为预装的本地入口，运行期不再依赖 npx 联网。
  **密钥跟着能力走**（粘性合并：面板未提供的密钥字段一律保留远端原值）；
  **传输凭据（SSH 私钥/密码、TG bot token）永不离开面板宿主**。
- **运行时与依赖的落点：`~/.ocrc/`**（2026-10-16 裁决）：复用探测到的 Node（≥ 20）优先；
  不够或缺失时才装进 `~/.ocrc/runtime/<name>/<version>/`，**绝不碰系统包管理器、不碰用户既有 nvm**。
  被控端因此至多出现两个我们的目录：`~/.opencode/bin`（引擎）与 `~/.ocrc/`（运行时与工件）。
- **`npx -y X` 的包两条取件路，一个开关**（2026-10-16 裁决，与 D4 同款）：有网时在被控端 `npm i` 指定版本；
  air-gap 时从面板推 tarball（走 npm 的 integrity 做同一套 sha512 校验）。两条路的产物必须一致。
  **实现进度留痕（2026-10-16 二次修订）**：本轮只落地了「被控端自取」这一条；推送那条留到下一轮，
  期间被控端不出网时 `POST /runtime/plan` 会如实报 `impossible`（理由是「不出网」），不静默降级。
- **运行时补齐的落地约定**（2026-10-16 二次修订，实现见 `service/runtime.ts`）：
  槽位 = 声明里钉的版本/dist-tag，没钉就是 `latest`（`npm install <pkg>` 装到的那个）；
  **入口来自包自己的 npm 元数据 `bin`**（优先 `node_modules/.bin/` 垫片），写进配置的是真实路径；
  槽位里写 marker（`SPEC/PACKAGE/VERSION/ENTRY/SLOT/INSTALLED_AT`），幂等以「spec 相同且入口还在」为准；
  **目录已存在但没有 marker 就不再动手**（那是别人装的东西，不搅乱）；失败时删掉**本次刚建出来**的
  槽位（否则下一次探测会把它当成「别人装的」而永久拒装），旧 marker 还原。
  取件只用被控端自己的 npm——**air-gap 的运行时 tarball 推送尚未实现**，目标机不出网时如实报
  「装不了」，不假装能装。
- **动线：现状交给模型，不改上游动线**（2026-10-16 二次修订）：openchamber 不给 guest 任何项目/
  传输 API（面板入口的硬边界，见 `panel-provisioning-verdict.md` §七），所以 ocrc 的入口只用它**已经
  开放的那几面**：composer 斜杠命令 `/ocrc-host`（现状）与 `/ocrc-plan`（待办）把四档就绪、引擎、
  能力缺口打包成一个 chip 交给模型；主机视图提供「在此项目上新建会话」（目录已是 openchamber 项目时）
  与「贴到当前对话」两条交接。**不做全屏 `contributes.page` 向导、不 fork 上游改它的项目菜单、
  不给扩展加 `background.entry`**（那会让隐藏帧抢走命令解析）。
- **端口语义**（2026-10-16 多路转发实验；**2026-10-16 二次更正**）：**主隧道端口不可静默更换**——
  `localPort` 默认 4096 是**面板宿主启动 openchamber 时用 `OPENCODE_PORT=4096`（或 `OPENCODE_HOST`）指过去的地址**，
  换掉就等于弄坏接入，冲突时如实报错（把 ssh 的 `cannot listen to port` 原话带回来）；**能力转发的端口是实现细节**，
  被占用自动换一个空闲端口，并把实际端口回写档案、把「换了哪个」如实报给面板（URL 改写跟着实际端口走）。
  > **更正留痕**：2026-10-14 的原始裁决写的是「隧道落地 4096 + openchamber 启动自动探测，**零环境变量**」。
  > 上游已**删掉**盲探 4096 的行为（其源码注释：盲探会劫持用户自己开的 OpenCode，把两边生命周期绑死），
  > 现在外接引擎必须**显式 opt-in**（`OPENCODE_PORT` / `OPENCODE_HOST` / `OPENCODE_SKIP_START`），
  > 否则 openchamber 自己拉一个本机引擎。实测证据见
  > [panel-fusion-and-provisioning.md §7.5](handoff/panel-fusion-and-provisioning.md)。面板宿主的启动脚本必须带上这个变量。
- **隧道形态**（D15）：复用**同一条 ssh 进程的多路转发**（`-L`/`-R` 同 ssh），生命周期与主隧道完全一致；
  端口**动态分配并记录**、不写死；能力 URL 按实际端口重写，**重写规则在面板可见**。
- **IM 通道归位**（D18）：**单主固定在被控端**——一个 bot token 只允许一个 `getUpdates` 长轮询
  （第二个拿 409）。**不做冷接管、不做多前端**：主力是面板，TG 只在用户不在电脑前时使用。
- **明确不做**：中继/托管式隧道（延续第零点八条）；IM 跨机接管/双端轮询；远端自更新（版本永远由面板推送）；
  把密钥写进任何配置文件（只允许 `{env:…}` / `{file:…}` 间接引用）；
  碰被控端用户既有的用户级配置（唯一例外：provider 凭据条目追加/更新同名条目 + `.ocrc-bak`）；
  **在被控端起 MCP 进程**（2026-10-16 裁决：那类能力本来就属于桌面侧，D14 已有「面板跑 + 反向接入」的选项；
  实现它要在被控端引入进程守护与收尸，破坏「被控端零守护」这条更值钱的性质）；
  **全屏 `contributes.page` 向导 / fork 上游改项目菜单 / 给扩展加 `background.entry`**（2026-10-16 二次修订：
  动线入口只用 openchamber 已开放的那几面）。

## 第零点十条：对端能力——远程 openchamber 实例（2026-10-17 新增）

**条款（用户口径 R11，2026-10-16 grill 定稿）**：要求在 openchamber 的 **Add project 里直接看到对端**，
中间主页面**直接与对端引擎交互**。这是**能力**要求，机制由实现选。

**机制（已实测，不是设想）**：把 openchamber 实例**跑在被控端**，控制端只建一条转发、打开转发后的 URL。
判据来自上游源码：项目/文件/git 这些面全部在**服务进程内**解析（`project-directory-runtime` 的
`fsPromises.stat`、`lib/fs/routes.js` 直接读本地盘），所以"看见对端"等价于"实例在对端跑"——
不需要 fork、不需要改它的源码，界面就是 openchamber 自己的界面。归档与证据见
[handoff/remote-instance-dev-and-test-plan.md](handoff/remote-instance-dev-and-test-plan.md) §2/§4；
机制裁决见 [research/remote-instance-verdict.md](research/remote-instance-verdict.md)。

- **入口（2026-10-17 收敛）**：控制端固定为 Win/Mac openchamber 桌面版。装好实例后，用户在桌面版原生
  **Remote Instances** 里填一次地址/密码/端口（`ocrc remote connect <id>` 把三项算好）；之后多机切换都用原生能力。
  浏览器直接开 `http://127.0.0.1:<localPort>` 只作为调试/无桌面时的次入口。
  **内嵌试验（同日）**：扩展 guest 的 CSP `frame-src 'self' data: blob:` 与对端 `frame-ancestors` 双重阻断，
  扩展页面无法 iframe 对端 UI；证据见 [research/embedding-experiment.md](research/embedding-experiment.md)。
  **桌面版实测**：2.4.0 external 模式接受自装 2.3.3——桌面壳自建 `ssh -L`，`/api/system/info` 返回对端 pid，
  Add project 列出 `/home/demo`。`ocrc remote connect` 不自动写列表；手工合并 settings.json 时先 `.ocrc-bak`，
  不写明文密码/clientToken。
- **R12 引擎门禁（硬）**：实例的引擎**必须** opencode **major=2 且 ≥ 2.0.20**（上游
  `compatibility.js` 同判据），二进制路径**钉死绝对路径、绝不靠 PATH、绝不回落 v1**。
  三个断言点：`plan`（预演）/ `up` 前（pin 断言）/ 实例自报
  （`GET /api/opencode/compatibility` 的 `state/binary/version`——**这才是"引擎是 v2"的证据**，
  而不是我们"请求它用 v2"）。默认部署**我们自己**的 pin（`~/.ocrc/remote/engine/opencode`，
  pin 顺序：manifest > `OCRC_V2_PIN` > 声明默认），对端既有的 v1/v2 一律不动。
- **R6/R9 出网中继（硬）**：被控端可以**完全没有公网**，计算与引擎留在对端。实例的 serve 行注入
  `HTTPS_PROXY=http://127.0.0.1:<remotePort>`，该端口由**同一条 ssh 的 `-R`** 拉回控制端的中继
  （`core/remote-instance-proxy.ts`）；`NO_PROXY` 恒带 `127.0.0.1,localhost`（回环免代理——实例要和
  自己的引擎在本机说话）。中继**拒绝本机目标**（反向隧道不能变成通往控制端 loopback 的门），
  并把每次出网记进 `~/.ocrc/remote-relay.log`（"请求成功"分不清是走了我们还是对端自己有网，
  CONNECT 记录才行）。**目标白名单**可按实例收紧（`proxy.allow`，点边界后缀匹配；空 = 只拒回环），
  被拒请求在日志里写明原因；注意收紧时要同时放行模型 provider **和**引擎自己的基础设施域名
  （如 `models.opencode.ai`），否则引擎"能起不能用"。装机路径同理：**控制端备件 + ssh stdin 推送**，
  对端脚本零联网命令。
- **R10 三级重连（可开关，默认 开/开/关）**：① 掉线自动重连+重订阅（keepalive + `2s→60s` 退避）
  ② 控制端重启后自恢复（档案 + `ensureAll()`）③ 断线期间操作排队补发（口径持久化；补发本身是实例
  自己的队列行为）。开关**落盘且对运行中的监督进程实时生效**（`store.reload()`）。
- **落点与纪律**：一切新增都在 `~/.ocrc/remote/`（运行时/引擎/应用/暂存）与 `~/.ocrc/remote-instances.json`
  （0600，`uiPassword` 不回显）；换下来的旧树留 `.ocrc-bak`；**被控端既有资产（用户自己的 opencode、
  用户自己的 4096 引擎）一个字节都不动**——验收脚本每轮都断言这一条。
- **兼容包（2026-10-17，CI 化）**：被控端只支持 Linux x64；CI 按 openchamber 版本产出
  **modern / legacy-glibc217** 两档包（legacy 含按 glibc 2.17 重建的 node-pty），控制端取件推送，
  对端**不装 devtoolset、不联网**；没有包时回退控制端跨装。工作流 `.github/workflows/ocrc-pack.yml`。
- **明确不做（v1）**：不 fork openchamber、不改它的源码；不做 WSL/Docker 实际支持（结构留位）；
  不做云端 relay（只保 LAN 直连，中继/托管式隧道的禁令延续）；**不自动写 openchamber 桌面版的 Remote Instances 列表**
  （`desktopSshInstances` 由桌面外壳独占；`ocrc remote connect` 把三项算好交出去，写入留给人；2026-10-17 已实测
  桌面版 external 模式可用，人工合并步骤见 OPS）；
  手机端不做新增连接/装机。

## UI 原则（2026-10-06 裁决；2026-10-07 增补）

- **右栏的显示能力 ≥ 中栏**：同一内容在右栏的渲染质量不得低于中栏（tool 输出含 md 切换，subagent 转写走统一 Card 管线）。
- **配色口径（2026-10-14 修订，替代 2026-10-07 冻结）**：默认皮肤 = **ocrc ink**——中性冷灰双平面轴
  （dark `#0e0e10/#1c1c1f`、light `#fdfdfd/#f8f8f9`）+ 柿橙品牌点缀（accent/焦点环/选中行/用户气泡/未读点，
  剂量经像素级校准：强核心 ≈0.27–0.29%、全屏零实心品牌块、整体色彩度 M≈11–12 与 zai 基线同带）。zai 双主题
  降为上游对齐参照（vendor 块保留）；柿橙原始色板封存 `persimmon-theme.css`（品牌色来源）；回肤/再校准取值
  见 `docs/research/ui-color-system-import.md`。token 名与三层架构不变。
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
| **宿主** | 独立拓扑：host（spawn / **adopt `OCRC_SERVER_URL`**）✅ / Windows 壳=adopt desktop（**归属待裁决**——基座换位后由 openchamber 桌面版承接，见 research/openchamber-base-swap-verdict.md）；共生拓扑：V1 插件 ✅（npm 数组，1.18.x）/ V2 插件 ✅（`plugins` 键 + setup 契约，批次 1-3 交付，CI 跟随 ocrc-follow.yml）；SSH remote ✅（WSL/Docker 补真中） | opencode 在哪跑、谁当主 |
| **分发** | npm 包 ✅（发布冻结待裁决）/ 桌面安装器（随壳，归属待裁决）/ 企业离线分发：bin-cache + ocrc-follow.yml 离线 bundle ✅（2026-10-15 起） | 别人怎么装 |

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

机器管理 · 多租户 · 云同步 · 通用聊天客户端 · 内嵌 agent 运行时 · 跟随 opencode latest（除非 V2 项目完成）· **个人微信自动化**（2026-10-05 裁决：只有 wechaty 类逆向方案，违反 ToS、封号风险真实；企业侧通道 = 企业微信/飞书/钉钉的官方企业接入）· host 原生 workflow runner（2026-10-07 裁决，**维持**；goal 与 workflow 均已改判为做——机制在引擎钩子、引擎本身 vendored 上游 dwf、状态在 host，见上）· 终端页签 · 插件市场 · 语音转写 · 管理员分层 · **中继/托管式隧道**（2026-10-16 裁决：隧道用户自理，我们只做档案驱动的本地 ssh 多路转发）· **IM 跨机接管/双端轮询**（2026-10-16 裁决：一个 bot token 只允许一个 `getUpdates` 长轮询，单主固定在被控端；见第零点九条 D18）。

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
