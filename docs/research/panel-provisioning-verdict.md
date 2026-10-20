# 面板侧 provisioning 与项目级配置 —— 设计裁决

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **日期**：2026-10-16
- **性质**：六轮 grill 的结论汇总（用户逐轮拍板），是本项目在「基座换位」之后**第一份能力契约**
- **触发**：批次 6 Windows 验收（`docs/handoff/batch6-windows-result.md`）暴露出
  面板扩展只会开隧道、不检测不安装不配置；且现有配置桥写的是**被控端全局配置**
- **落点**：改写 PRODUCT 第零条/第零点六条、新增第零点九条、第零条措辞对齐

## 一、问题陈述

1. 面板（openchamber，Win/Mac）与我们的扩展今天只做 `ssh -N -L` 隧道；被控端必有
   **已装且已启动**的引擎，否则扩展什么也做不了。用户要求的原则是
   **「面板控制一切，只要有 ssh，就一定有相应的能力」**。
2. 现有配置桥（ocrc-remote 0.3.0+）把面板产物写进被控端
   `$HOME/.config/opencode/opencode.json`——这是**全局层**，与「绝不直接操作对端用户级配置」
   的设计意图冲突；实测该文件在被控机上还与用户真实配置 `opencode.jsonc`（共享目录）
   并存，存在优先级/静默无效问题。
3. 上游参照 **ZCode**（zai-org/ZCode，Apache-2.0，commit `aac4755`）已把这件事做完整：
   `detect → deploy → exec → 握手 → stdio`，被控端只需 **sshd + POSIX sh + tar + 可写 $HOME**，
   **连 Node 都不需要**（Node/server/pty/agent/工具全套由控制器推或远端拉）。

## 二、事实基础（本轮取证）

### 2.1 ZCode 远程控制（源码级）

| 项 | 事实 |
|---|---|
| 传输 | `ssh` / `wsl` / `docker` / `server`；前三者实现同一 5 方法接口 `IRemoteBackend{detect,upload,exec,exists,readFile}`；`server` 只接入、无 deploy backend |
| 生命周期 | ssh/wsl/docker **全系 spawn、从不 adopt**；stdin EOF / SIGHUP → 幂等关停；keepalive 15s×3；**不做 SSH 自动重连** |
| 版本 | `ZCODE_VERSION` 编译进 App，远端 `--version` **必须完全相等**，不等即重装；**无最低版本门禁、无远端自更新**——远端是控制器的镜像 |
| 身份 | 内容寻址：远端 `.asset-components/<id>.json` 记 **sha256**；另有 `pendingRefreshAppVersion` 让「升到一半」的重试保持正确 |
| 推/拉 | 每目标可选：默认 `local-download-upload`（控制器本地缓存+校验后 SFTP 上传，失败回退 `cat >` 管道）／`remote-download`（远端 curl/wget + sha256 校验） |
| 落点 | `~/.zcode/server/`，**只碰自己的命名空间**，从不写别的 dotfile |
| 凭据 | 带 schema 版本的 RPC 信封 + **白名单**；源端解密、目标端**重新加密**（两端 cipher 可能不同，禁止复制密文）；事务 + 每域回滚 + `syncId` 幂等；**明确不导出 SSH 密码/私钥、bot 凭据、MCP token、插件 secret** |

### 2.2 opencode 配置作用域（源码级）

- **没有任何键被排除在项目级之外**。项目根 `opencode.json[c]` 与全局同 schema，
  **优先级最高**，且逐层向上合并祖先目录。
- `.opencode/` 是项目级发现根：`agents/ commands/ plugins/ skills/ tools/ themes/ modes/`，
  且 `.opencode/opencode.json` 本身也是一层配置输入。
- 同目录 **`.jsonc` 优先于 `.json`**。
- **只有凭据是用户级**：`~/.local/share/opencode/auth.json`（`opencode auth login` 写入）。
- **v1 与 v2 的项目层语义不同**（必须记档）：向上遍历边界 v1 止于 git worktree（含）、
  **v2 直到文件系统根**；`.opencode/opencode.json` 的祖先优先级 **v1「越远越赢」**
  （且 `~/.opencode` 压过所有项目 `.opencode`）、**v2「越近越赢」**。
- omo-slim（v3.0.4）**有项目层**：`<project>/.opencode/oh-my-opencode-slim.json[c]`，
  用户层为基底逐层覆盖、越近越赢；嵌套深合并、顶层数组整体替换；有 `skills_add`/`skills_remove` 增量。

### 2.3 被控机（`user@192.0.2.10`，buildhost / RHEL 7.9 / glibc 2.17）

- 出网实测：`api.telegram.org` 302、`registry.npmjs.org` 200、`opencode.ai` 200（连接 ~5ms）——
  **该机有网**，IM 与联网安装都可行。
- 真实配置 `~/.config/opencode/opencode.jsonc`（8.8KB，符号链接到 VMware 共享目录，
  文件头自述「三端同步：WSL / VMware VM / Windows 原生」）。
- **4 个 MCP**：`searxng`（local `npx mcp-searxng`，`SEARXNG_URL=http://192.0.2.11:8080` 内网地址）、
  `playwright`（local `npx @playwright/mcp@next --cdp-endpoint http://127.0.0.1:9222` 本机进程）、
  `tavily`（**remote**，URL 内嵌 `tavilyApiKey`）、`codegraph`（local，依赖本机二进制）。
- 插件：`oh-my-openagent@5.0.0`、`@bd7pil/opencode-deep-memory`、`@ramtinj95/opencode-tokenscope`；
  12 个 provider（多为第三方网关 + `baseURL`）。
- TG 通道：token/allowlist 已配、`ocrc.log` 有 10MB 活跃痕迹；
  轮询锁为**本机文件租约** `tg-runtime.lock`（含 `leaseExpiresAt` 与 `host` 字段）
  + 本机 `tg-offset.json`；grammY 对 **409 按致命处理**（防竞争自杀）。

### 2.4 上游 openchamber 的 v2 安装器（可沿用路线，但不可直接调用）

- 纯本地：仅用 `process.platform/arch`，装到面板宿主 `~/.opencode/bin`，
  由本机已鉴权路由触发——**没有远程/SSH 维度**。
- 门禁 `MINIMUM_OPENCODE_VERSION='2.0.20'` 且要求主版本为 2；而安装器取
  `@opencode/cli/latest`。**门禁是下限、安装器是最新**，两者不是一回事。
- 有回滚（锁目录快照 + 失败还原）；Windows 走 npm 平台包 + **sha512 校验**，Unix 走官方 bash 脚本（无校验）。

## 三、裁决（逐条）

| # | 决策 | 结论 |
|---|---|---|
| D1 | **凭据建立** | 两条都做：**(b)** 扩展生成/展示密钥对 + 一键复制公钥（零新依赖）；**(c)** 一次性密码引导自动写入 `authorized_keys`（需引入 JS SSH 库，如 `ssh2`）。文档侧已补 `docs/handoff/batch6-windows-testing.md` §0-③-补 |
| D2 | **能力落点** | **面板扩展自持完整链**：检测 → 取工件 → 推送/联网安装 → 写配置。引擎侧 ocrc 的 provisioning 降为「已装 ocrc 的被控机」辅助路径。理由：鸡生蛋——被控机连引擎都没有时，那边没有 ocrc 可驱动 |
| D3 | **自动程度** | **检测全自动**（连接时 + 手动刷新）；**安装与写配置需一次显式确认**（可勾「此主机不再询问」） |
| D4 | **安装形态与落点** | 装到 **`~/.opencode/bin/`**（官方默认路径，且 openchamber 安装器同款）；**一律走 npm 平台包 + sha512**（放弃官方 bash 脚本）；**先探测出网能力**，通则联网取、不通则从面板按**目标平台**推送本地缓存工件 |
| D5 | **项目级配置的「项目」** | 档案上显式绑定**远程工作目录**，项目级配置写在该目录下 |
| D6 | **版本锚点** | **镜像面板宿主**：面板宿主保留一份 openchamber 管理的 opencode（`~/.opencode/bin`），我们镜像它，推前用 `isSupportedOpenCodeVersion` 复核。`ops/v2-pin-manifest.json` 退化为「取不到工件时的降级版本」 |
| D7 | **被控端装几件** | ① 引擎（必需）+ ② **ocrc 插件（保，模型面工具/编排的前提）**；③ omo 默认不装。② 的推送**有网时在被控端 `npm i` 指定版本，air-gap 才推整棵 `node_modules`**（一个开关） |
| D8 | **就绪判定** | 四档阶梯，逐档给出可执行动作，不做「部分可用」模糊态：① ssh 可达 ② POSIX sh + tar + 可写 `$HOME` ③ 引擎在位且版本匹配 ④ 远程工作目录存在且可写 |
| D9 | **同步时机与幂等** | 连接成功后 + 面板侧配置保存后各一次；读远端现状→**只写差异**；`.ocrc-bak` 兜底；失败回滚；`syncId` 幂等。绝不「每次请求都写」、绝不无条件覆盖 |
| D10 | **配置写入目标** | 写 **`<远程工作目录>/opencode.jsonc`**（项目级，优先级高于全局）；**全局层只读不写**；写入目标必须解析为引擎实际在读的文件（存在 `.jsonc` 就写 `.jsonc`，保不住注释就如实提示） |
| D11 | **能力同步的粒度** | 同步单位是**能力**而非凭据类别：每项能力声明它的需求（**密钥 / 网络可达 / 运行时**），由 provisioning 在目标侧凑齐。**密钥跟着能力走**；**传输凭据（SSH 私钥/密码、TG bot token）永不离开**；合并时**密钥字段是粘性的**——面板未提供的密钥字段一律保留远端原值 |
| D12 | **能力补齐的三类手段** | 内网地址 → **SSH 隧道**（按方向补，URL 按侧重写）；本机进程 → **在目标侧起进程**（ocrc 已有侧车浏览器先例：`core/browser.ts` + `ocrc mcp-browser`，CDP :9222）；本机二进制 → **纳入 provisioning 在目标侧安装** |
| D13 | **运行时前提** | provisioning 产物清单加 **Node 运行时（按目标平台）**，装到我们自己的命名空间（不碰被控端既有 nvm/系统 node）；同时把 `npx -y X` 类声明在同步时**改写为指向预装好的本地入口**，运行期不再依赖 npx 联网 |
| D14 | **MCP 执行位置** | 能力项上显式可选：**远端本地跑**（默认，需补运行时）vs **面板跑 + 远端远程接入**（需补反向隧道）。后者留给本来就属于桌面的能力（浏览器、桌面级工具） |
| D15 | **隧道形态** | 复用**同一条 ssh 进程的多路转发**（`-L`/`-R` 同 ssh）；生命周期与主隧道完全一致；端口**动态分配并记录**，不写死；能力 URL 按实际端口重写，**重写规则在面板可见** |
| D16 | **档案基数** | **档案 = 主机级**（host/user/port/key/引擎版本/运行时）；**项目目录是它下面的子项**。理由：隧道、引擎、运行时、版本都是主机级的，绑到项目上会导致同机重复探测/重复安装 |
| D17 | **升级与回滚** | 检测自动、升级**提示后一键**；身份用**工件 sha512** 记在被控端 marker 文件（不是版本字符串），避免「同版本重发」与「升到一半」两种脏态；卸载 = 删 `~/.opencode/bin` + 我们的 marker，**绝不碰用户既有 opencode 安装**；推送前旧二进制备份 `.ocrc-bak`，失败自动还原 |
| D18 | **IM 通道归位** | **单主固定在被控端**：一个 bot token 只允许一个 `getUpdates` 长轮询（第二个拿 409），**不做冷接管、不做多前端**。理由：主力是面板，TG 只在用户不在电脑前时使用——那时笔记本可能根本不在，接管过来只能对着空气说话；且接管要付「共享 offset journal」的代价（ocrc 的 offset 是本机的，会重放或丢消息） |
| D19 | **参照一致性** | 上述 D4/D6/D15/D17 与 ZCode 的 `detect→deploy→exec` 管线、内容寻址身份、控制器镜像版本、绑连接生命周期的多路隧道**同构**；差异只在**我们保留 adopt 态**（PRODUCT 第零点五条：生产引擎零测试流量的架构基础），ZCode 全系 spawn |

## 四、明确不做

- **不做中继/托管式隧道**：隧道是用户自理的（延续 PRODUCT 第零点八条「不做中继」裁决），
  我们只做「档案驱动的本地 ssh 多路转发」。
- **不做 IM 跨机接管/双端轮询**（见 D18）。
- **不做远端自更新**：被控端版本永远由面板推送（延续「中心化更新」，只是中心换位）。
- **不把密钥写进任何配置文件**：项目文件里只允许 `{env:…}` / `{file:…}` 间接引用。
- **不碰被控端用户既有的用户级配置**：唯一例外是 provider 凭据条目（追加/更新同名条目 + `.ocrc-bak`）。

## 五、对既有条文的影响

| 条文 | 改动 |
|---|---|
| 第零条（换位裁决段） | 「provisioning/离线推送」的归属由被控端 host 改标为**面板侧扩展** |
| 第零点五条（backend 域模型） | 不变。adopt/spawn 两态继续成立，本设计在 transport 维度新增「多路转发」，lifecycle 语义不动 |
| 第零点六条（provisioning 与更新矩阵） | **重写**：版本源从「被控端 host」改为**面板宿主**；工件缓存落在面板侧、按目标平台选；provisioning 清单从「opencode 二进制」扩为**能力包** |
| 第零点七条（功能范围） | 设置域/ocrc 域条目不冲突；本设计不改 UI 功能范围 |
| 第五条（明确不做） | 新增「中继/托管式隧道」「IM 跨机接管」两条 |
| 新增 **第零点九条** | 面板侧 provisioning 与项目级配置（本裁决的正文落地） |

## 六、实施注意（工程侧）

1. **重建扩展产物前必须先 `npm ci`**：本地扩展 `node_modules/.bin` 会是不完整空壳，
   静默回落到仓库根的 vite 5.4.21，产出的包与 CI 不一致（本轮已踩）。
2. **vite lib 模式不替换 `process.env.NODE_ENV`**，guest 沙箱无 Node 全局 → 必须显式 `define`；
   三个 bundle 从批次 2 起加载即 `ReferenceError`（本轮已修）。
3. **guest 沙箱没有 `allow-modals`**：`window.prompt/confirm/alert` 被忽略返回 null →
   「添加档案 / + 根目录 / 提交信息」三条 UI 流程必须改成内联表单（待修）。
4. **v1/v2 项目层语义不同**（见 2.2）：pin v2 时按 v2 语义（遍历到文件系统根、越近越赢），
   但被控端现存 v1 实例的行为需要按 v1 记录，双代共存期不得假定一致。

## 七、面板入口的硬边界（2026-10-16 追问后核实）

**问题**：能不能不改 openchamber 的操作动线，把「连接我们的通道」做进它原生的
新建任务 / 新建工作区 / 项目右键菜单里？

**结论：不能注入，只能"在旁边挂"**。证据来自 `@openchamber/sdk` 自己的 `API.md`
与 `manifest.d.ts`（2.3.2/2.3.3 实测）：

| 想要的位置 | 能不能 | 依据 |
|---|---|---|
| 项目右键菜单（「打开文件夹 / 远程连接」那一层） | ✗ | 没有任何项目级菜单贡献面；`actions` 只覆盖 **消息与会话**（`where: session \| message`） |
| 新建任务 / 新建工作区 / 「Choose project」流程 | ✗ | SDK 无 project/transport API（`openProject`/`createProject`/`addProject` 一个都没有） |
| 注册一个 transport（像 ZCode 的 ssh/wsl/docker） | ✗ | 无该面；transport 是宿主第一方的事 |
| 左侧栏的 rail 图标 + 右侧面板 | ✓（已有） | `contributes.panel`（`icon` 是 Remixicon 名或包内 svg） |
| **全屏页** | ✓ | `contributes.page`；入口在侧栏「Extension pages」菜单；`ctx.surface === 'page'`；**API.md 明确写 "Pages are not context-rail surfaces"**，`openSurface` 打不开它 |
| 命令面板 / 斜杠命令 | ✓ | `contributes.commands`（composer 斜杠命令，挂 chip） |
| 会话里的常驻状态区 | ✓（已有） | `contributes.statusSection` |
| 文件编辑器接管 | ✓ | `contributes.fileEditors` |

**推论**：上游的「远程实例」（设置 → 远程实例，`remoteOpenchamber.mode = managed | external`）
是**第一方功能**，装/连的是**远端 OpenChamber 服务器**，不是裸 opencode；ZCode 的
「远程连接」向导（SSH/WSL/Docker + 两条下载方式）同理是 ZCode 的第一方功能。
guest 扩展拿不到那条动线。

**因此我们的落点（裁决）**：
1. 面板 rail 图标 + 面板内「主机视图」（已有）——**不替代原生页面，只负责"把路铺好"**；
2. 补 `contributes.commands`：让「连接 / 部署引擎」在命令面板里可搜到（这是 guest 唯一能进
   全局动线的入口）；
3. 就绪后用宿主的会话 API 交接（`startSession`/`compose` 对 guest 开放）——在主机视图里加
   「在此项目上新建会话」，点了就进原生新建任务流；
4. 明确**不做**：fork openchamber 去改它的项目菜单/新建流程（与「不 fork」的既有裁决冲突）。

**同机共存红线**：上游「远程实例」的 managed 模式会在被控端起 OpenChamber 服务器
（要 Node ≥ 24.14），与我们往同一台机器装 `~/.opencode/bin/opencode` 会**争 4096 与引擎所有权**。
两条路线在**同一台被控机上不得混用**——文档里写死，探测到对方存在时要如实提示。
