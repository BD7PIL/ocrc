# ZCode（zai-org/ZCode）远程部署栈调研 — 对 ocrc 的启发

> 调研日期：2026-10-20。对象：开源 ZCode 最新版（仓库 main 同步到 v3.16.2，2026-10-19；GitHub release tag 停在 v3.14.3，2026-09-24——**桌面版本走 main 上的 "sync ZCode source" 提交，GitHub Releases 不是它的发布通道**）。
> 结论面向两个问题：ZCode 的 Source Server 远程部署逻辑对 ocrc 的装配逻辑有什么启发；它的连接 UI 对 ocrc 面板有什么启发。
> 所有 ZCode 侧论断都给出来源（仓库路径或文档 URL）；ocrc 侧给本地文件。

---

## TL;DR

1. **产品定位不同，但部署动线惊人地同构。** ZCode 的 Source Server 是"把一个常驻 daemon 装到远端，桌面端经 SSH 隧道连它"；ocrc 是"把整套 openchamber 装到远端，桌面端配对它"。两者都走：probe → 工具 preflight → 取件（下载或上传）→ 原子落位 → 启动 → 兼容性门禁。ZCode 把这条链做成了**结构化阶段流（phase event stream）+ 错误码合同 + 单一展示模型**，ocrc 目前是"文本日志 + 布尔 ok"。这是最大的一块可借鉴资产。
2. **网络模型相反，且互为补充。** ZCode 默认让**远端自己下载** release archive（`remote-download` 模式，preflight 探测 curl/wget/tar/sha256sum，缺工具时报错并建议"切回本地上传"）；ocrc 默认**控制端备件全量推送**（对端零联网，`offline-proof` 断言）。ZCode 也有 `local-download-upload` 模式（`LocalUploadAssetInstaller`）作为另一翼——**两种模式它都实现了，按 Profile/环境选择**。ocrc 的"对端零联网"是产品红线（air-gap 是核心场景），不该学它默认远端下载；但"**下载/上传双模式 + 按对端能力自动选**"的框架值得吸收：ocrc 已经有 `--provision push|reuse`，可以自然延伸出组件工件的"对端有外网时允许对端直拉 CDN"选项。
3. **glibc 门禁的教训直接命中 ocrc 的场景。** ZCode 的 probe 只看平台/架构，CentOS 7（glibc 2.17）用户先传 87MB、解压后由 ld.so 报错（bug ZCT-2112008575366098944），之后才把 `getconf GNU_LIBC_VERSION` 挪进 probe 并在**确认安装前拒绝**（`SOURCE_SERVER_MIN_GLIBC_VERSION = 2.28`，见 `sourceServerProbe.ts` 注释）。ocrc 走了另一条路（为 glibc 2.17 单独造 legacy pack + `appPackTierForGlibc`），但"**门禁必须在下载之前**"这个原则两边一致；ocrc 的 plan 已经先探 glibc 再定 tier，这点是 ocrc 做得更好的地方。
4. **UI 侧最值得抄的是三样：** ① 步骤向导 + 可折叠实时日志 + 「在后台继续」（截图动线，对应其"三屏向导 + 收起为两行卡片"合同）；② **连接日志的脱敏过滤层**（`sanitizeRemoteConnectionLog`：token 边界匹配秘密、遮蔽 URL/路径/UUID/Authorization，"用户可见日志与原始诊断分开落盘"）；③ **统一五态展示模型**（纯函数把连接事实映射为 已连接/连接中/未连接/需要处理/连接失败 + 语义色 + 主操作，"UI 只能从这里取状态，不得自行计算"）。这三样都不需要改 ocrc 的产品形态。
5. **许可干净。** Apache-2.0，NOTICE.md 与 THIRD-PARTY-NOTICES.md 完整。借鉴思想/结构无义务；若逐行移植代码，需在 ocrc 的 NOTICE 加 Apache-2.0 归属段（与 reeve 引 open-code-review 的做法一致）。SUL-1.0（omo）红线不涉及——ZCode 与 omo 无关。

---

## 1. ZCode 远程栈拆解

### 1.1 仓库与版本事实

| 事实 | 值 | 来源 |
|---|---|---|
| 仓库 | zai-org/ZCode，TypeScript 为主，约 8.0k stars，Apache-2.0 | `gh repo view zai-org/ZCode` |
| 最新桌面版 | v3.16.2（2026-10-19，README 更新日志） | README.md「更新」节 |
| GitHub Release | v3.14.3（2026-09-24）——release 不是主要发布面 | `gh release list` |
| 源码同步节奏 | `chore: sync ZCode source` 每日级（10-19、10-20 都有）；`feat: update to v3.15.1`（10-10） | commits API |
| 开源时间 | 2026-09-20（`feat: open source`） | commits API |
| 结构 | `apps/zcode-cli`（Agent CLI）、`packages/server`（远程主链）、`packages/shared`（合同类型）、`docs/`（大量规格文档） | 仓库根目录 |
| 文档密度 | `docs/architecture/` + `docs/remote/` + 问题台账 + 覆盖矩阵，规格-实现-验证三层分离 | docs/remote/README.md |

### 1.2 Source Server 是什么

- **远端常驻 daemon**，装在 `~/.zcode/server/`，由 `bin/zcode serve --daemon` 启动；桌面端经 SSH `direct-tcpip` 连到**远端 loopback** 的 HTTP+WS 入口（fallback：`zcode server proxy-stdio` stdio 桥）。来源：`docs/architecture/r3-source-server-remote-architecture.md` §2「连接拓扑」、`transportAdapter.ts openChannel()`。
- **身份**：`sourceServerId` = 远端 `install.json.installationId`（UUID，首次安装原子生成，卸载保留数据时保留，重装沿用——"换 IP/端口/连接方式不换 id，换数据环境才换 id"）。主规格 §2/§3。
- **权威**：远端 daemon 以 `standalone-server` authority 运行；模型 Provider 配置由远端 Environment 自权威，桌面端只在首连/重连/本地保存时**自动单向下发**快照（Provider Provisioning，`docs/remote/provider-provisioning.md`："远端只是本机配置的可丢弃执行镜像"）。
- **ingress 鉴权**：`run/ingress-token`（0600）文件 token，Adapter 经 SSH 读出来后每个 HTTP/WS 请求携带；把"网络位置边界"升级为"OS 用户身份边界"。主规格 §2。

### 1.3 部署动线（对照截图逐阶段）

截图里的向导（选择设备→连接→选择目录；SSH→识别设备→安装 Source Server（进度条）→启动并检查兼容性）对应实现链：

1. **probe（单 round-trip）**：`buildSourceServerProbeCommand` 用 `__ZCODE_PROBE_<SECTION>__` 分节标记，**一次 SSH exec** 收齐 platform/arch/root/kernel-ostype/libc（`getconf GNU_LIBC_VERSION`）/是否已装/current.json 版本/status.json（且校验 pid 存活才复用）。注释明确写着教训：过去串行多次往返会超出 10 秒预算、并发会触发 Bad packet length，收敛为"一个只读 POSIX channel"。来源：`packages/server/src/source-server/sourceServerProbe.ts`。
2. **glibc 门禁**：linux 且能读到 glibc 版本时，< 2.28 直接 `SourceServerProbeEnvironmentError`，错误文案给出建议系统（RHEL 8+ / Ubuntu 20.04+ / Debian 10+）。**读不到版本（musl、缺 getconf）时不凭猜测拒绝**。同文件。
3. **工具 preflight**：一条 shell 探测 `download=curl|wget`、`tar`、`sha256=sha256sum|shasum|openssl`、`progress=full|basic`（有 awk+wc+date+sleep 才算 full 进度）。缺件即结构化报错，**并建议"切回本地下载后上传"**。来源：`packages/server/src/remote/remoteAssetPreflight.ts`——这就是截图日志 `[remote-assets] preflight: selected tools download=curl tar=tar sha256=sha256sum progress=full` 的出处。
4. **取件双模式**：
   - `remote-download`：远端 `curl -fL --retry 2 --connect-timeout 20` / `wget --tries=3`，多 URL 候选依次尝试，sha256 校验，`download progress:` 行实时回报（截图里的 `87.2% (75.8/87.0 MB, 2.05 MB/s)`）。来源：`remoteAssetInstaller.ts buildRemoteArtifactDownloadCommand`。
   - `local-download-upload`：`LocalUploadAssetInstaller`，本地上传 + SFTP onProgress 百分比。`transportAdapter.ts installRelease` 里按 `target.assetInstallMode` 与是否有 `localArchivePath` 分流，**两条路汇合到同一 extract/install 链**。
5. **原子落位与自更新**：bootstrap staging 目录带 `pid-timestamp` 后缀（`.bootstrap-<pid>-<ts>`），EXIT trap 清理；**过期 staging 只回收 >24h/30min 的自有目录**（防并发误删、防半包积累）；解压到私有 staging（**注释：/tmp 可能 noexec 或 tmpfs 太小，75MB 包传到 90% 才 EPIPE 的教训**）；然后 `zcode update --from-archive ... --json --progress` 让 CLI 自己完成校验+daemon 换代，JSON 事件行实时解析为阶段。来源：`transportAdapter.ts installRelease`。
6. **ensureDaemon**：probe 已 ready 就只复用端口（省一次往返），否则 `serve --daemon --json`；`serviceRegistered` true/false 分别报告"注册了 OS 用户服务"/"detached fallback"；最后读 ingress-token。`transportAdapter.ts ensureDaemon()`。
7. **错误码合同**：`PUBLIC_ZCODE_ERROR_CODES` 27 个稳定错误码（`remote-authentication-failed`、`remote-preflight-failed`、`remote-space-insufficient`、`remote-recovery-budget-exhausted`…），每阶段失败由 `normalizeRemoteConnectionError(error, phase)` 归类；**probe 只有环境本身失败才算 preflight 失败，传输失败不得兜底误报**（注释：这正是"拒绝连接时永远停在正在连接"的根因）。来源：`packages/shared/src/source-server/errorCodes.ts`、连接 UX 规格「错误码契约」。

### 1.4 Provider Provisioning（与 ocrc 的 sync-config 对位）

`docs/remote/provider-provisioning.md` 的不变量很成熟：

- 本地是编辑权威，远端是"可丢弃执行镜像"；**不提供远端编辑 UI、不做反向同步、不做 diff**——每次整份快照单向覆盖，replace 语义。
- 触发：远端上线、本地保存成功；Environment 级 single-flight lane + generation 尾随同步（同步期间的新触发只推进 generation，轮末重读一次）。
- 首连时 provisioning 失败是连接失败；已发布后的失败只留无 Secret 的结构化 warning，不拆连接。
- 凭据：allowlist 才同步；删除本地 allowlist 凭据会在下次同步删除远端同名凭据；Secret 不进 relay/日志/任务事件。

对比 ocrc 的 `sync-config`：ocrc 做的是**深合并 + 只推差异 + `.ocrc-bak`**（因为对端配置里有用户自己的手写层，v1 时代留下的），ZCode 做的是**整份覆盖**（因为它对远端配置拥有完全所有权）。这是所有权差异，不是优劣。但 ZCode 的 **single-flight + generation 尾随**和"**首连失败=连接失败，后续失败=warning 不拆连接**"这两条语义，与 ocrc bootstrap 的"sync-config 失败只告警"刚好互相印证，且 generation 防并发写得更好。

---

## 2. 与 ocrc 逐项对比

| 维度 | ZCode | ocrc | 判定 |
|---|---|---|---|
| probe | 一次 SSH round-trip，分节标记收齐 8 项；10s 预算注释 | `buildRemoteEnvironmentProbe`（`remote-instance.ts:244`）一次收 UNAME/LDD(glibc)/HOME；egress 探测是独立命令（带 DNS/字面 IP 分离、node 兜底——比 ZCode 细） | **ocrc 不差**；可学"分节标记"格式化输出 |
| glibc 门禁 | probe 内拒 <2.28，**下载前** | `appPackTierForGlibc` 决定 modern/legacy pack，**plan 阶段定 tier**，比 ZCode 多支持 EL7 | **ocrc 更强**（2.17 可用是核心能力） |
| 工具 preflight | download/tar/sha256/progress 四项探测 + 缺件建议切模式 | ocrc 不需要（全推送）；tar 仅控制端用（Windows 用 System32 tar） | 不适用（网络模型不同） |
| 取件 | remote-download 默认 + local-upload 备选，按 Profile 选 | 控制端备件推送（唯一模式），`pushFileOverSsh` 有 onProgress | **可借"双模式框架"**：对端有外网时允许组件工件对端直拉 |
| 原子落位 | bootstrap staging + EXIT trap + 过期回收 + /tmp noexec 教训 | `*.part` → `mv` 原子改名；`.ocrc-bak` | **可学过期 staging 回收**（ocrc 半包只靠 `.part`，中断残留无人清） |
| 启动 | `serve --daemon --json`，serviceRegistered 双态报告，ingress token | `up` + detached ssh 转发 + 面板监护；对端 openchamber 自己管理进程 | 大体等价；ZCode 的 OS service 注册（systemd --user / launchd）ocrc 没有——**ocrc 的 `restoreOnStart` 依赖控制端在线，对端重启后没人拉实例**（切换清单里已列为风险） |
| 升级 | compatibility manifest `{schemaVersion, productVersion, minCompatibleVersion}`，只升旧端，`update --from-archive` 原子换代 + running-task guard | `upgrade` 比对控制端 app pin；组件按 sha256 命中短路 | **可学 manifest 三元组**：ocrc 的 pin 分散在 `DEFAULT_APP_VERSION`/`DEFAULT_ENGINE_PIN`/`ops/components.json`，没有双端握手用的兼容清单 |
| 错误面 | 27 个稳定错误码 + 阶段归属 + "传输失败不得报成环境失败" | `InstanceOutcome {ok, detail}`，detail 是人读文本 | **最值得学**：面板/CLI 想做可靠的主操作按钮，必须有稳定错误码 |
| 长任务 | phase 事件流（preflight/download/upload/extract/install/daemon/channel），UI 可折叠日志、收起为卡片、在后台继续 | CLI 直接流式打印；面板 job + 轮询（`RemoteInstance.tsx:186` jobId 轮询），无阶段结构 | **可学 phase 事件合同**：job result 里加 `{phase, message, progress?}[]` |
| 日志安全 | `sanitizeRemoteConnectionLog`：完整 token 边界匹配秘密、遮蔽 Authorization/Cookie/Bearer/URL/路径/UUID，"用户可见日志与原始诊断分开落盘"；注释里有真实教训（短密码 `dev` 把 `device` 改成 `[redacted]ice`） | ocrc 日志直接含主机名/路径/用户名；`redactInstance` 只管 API 响应不管日志 | **可学且应该学**：ocrc 面板日志会显示 `sshPassword` 所在路径、内网 IP（截图场景就是 192.168.*） |
| 身份 | `sourceServerId` 稳定 UUID，换线路不变 | `instanceIdFor({host,user})` = `user@host` 字符串——**换 IP/端口/用户名就换 id** | **可学**：ocrc 记录以 host:port 为身份，配对链接/桌面端条目换线路就散；但 openchamber 的配对模型（每设备 token）部分缓解，且改 id 牵动 store/pairlink，收益要权衡 |
| 配置同步 | 整份覆盖、单向、generation 并发协调 | 深合并、只推差异、bak、shadowed 提示 | 所有权不同，**ocrc 的做法对自己的场景更对**；学 single-flight 语义即可 |
| 网络 | 远端需公网（下载 release/CDN） | 对端可完全 air-gap | 产品红线，不学 |

---

## 3. 对 ocrc 逻辑的启发（分级）

### A. 可直接采纳

1. **稳定错误码 + 阶段归属**（来源：`errorCodes.ts` + 连接 UX 规格"错误码契约"）。给 `InstanceOutcome` 加 `code?: string`，先覆盖 bootstrap 七步：`remote-unreachable` / `remote-preflight-failed`（glibc/平台） / `remote-install-failed` / `remote-space-insufficient` / `remote-permission-denied` / `remote-auth-failed`。**原则照抄它的注释：只有远端环境检查失败才算 preflight，ssh 传输失败不得兜底误报**——这正是 ocrc 的 `plan.sshError` 与 `engineError` 混在文本里的问题。
2. **连接日志脱敏层**（来源：`connectionLog.ts sanitizeRemoteConnectionLog`）。ocrc 的 `pushLog`（`remote-instance-bridge.ts`）与面板日志应过一遍过滤器：秘密列表（uiPassword、sshPassword、token）按 token 边界替换；URL/UUID/绝对路径遮蔽。**它的正则注释本身就是需求文档**（短秘密子串误伤）。用户可见日志与完整诊断分开——ocrc 的 `peerlog` 可以是那个"完整诊断"。
3. **过期 staging 回收**。ocrc 的对端 `.part` 半包、`.bootstrap` 类残留目前无人清理；学它的"只回收带合法 epoch 后缀且超龄的自有 staging"，加进 apply 的 preflight。
4. **probe 分节输出**。ocrc 的环境探测已是单次往返，但用 `KEY=v` 行；改成分节标记可以把"多个同 key 值"（如多个引擎候选）收得更干净，同时保持纯函数解析可测。

### B. 改造后采纳

5. **组件工件的"远端直拉"可选模式**。ocrc 的 provision.json artifacts 已有 `url + sha256 + size`——恰好是 ZCode 远端下载命令需要的全部参数。可以加 `--artifact-mode remote-download|push`（默认 push，保住 air-gap 红线）：对端有外网时（egress probe 已判 `direct`）大工件（Bifrost 134MB）让对端自己 `curl+sha256sum`，省控制端带宽与时间。preflight 直接复用它的四项探测思路（download/tar/sha256/progress）。
6. **双端 compatibility manifest**。ocrc 已有所有 pin 值，缺一个握手结构：apply 时把 `{appPin, enginePin, schemaVersion}` 写到对端 `~/.ocrc/remote/manifest.json`，plan 时对比得出"可选更新 / 远端必须更新 / 控制端必须更新"三态——现在 `upgrade` 只知 app 一维，组件 pin 漂移靠人眼。
7. **对端 OS service 注册**。ZCode 用 systemd --user / launchd 注册 daemon（探测失败才 detached fallback，且**注册失败 fail-closed 不准用 fallback 掩盖**）。EL7 的 systemd --user 可用（demo 用户有会话），做一个 `ocrc-remote-instance.service` 用户单元能让对端重启后实例自愈——这正是切换清单第 7 条的风险缓解。注意 EL7 systemd 219 的 unit 语法兼容。
8. **generation 式同步协调**。sync-config 现在是单次调用；若未来面板出现"保存即同步"，按它的 single-flight lane + 尾随重读做，避免两个窗口同时推。

### C. 不适用（产品形态不同）

- **远端下载为默认**：ocrc 的 air-gap 场景是存在理由。
- **多 Source 管理页 / 平铺项目导航**：ocrc 是 openchamber 的装配器，设备列表已经由桌面版"其他 OpenChamber 服务器"承载，不再造一套。
- **WSL/Docker transport**：ocrc 明确不支持 Windows 被控端（PRODUCT 边界）。
- **Provider 整份覆盖**：ocrc 对端配置含用户手写层，深合并是正确语义。

---

## 4. 对 UI 的启发（分级）

### A. 可直接采纳

1. **向导三步 + 步骤条**（截图：选择设备 → 连接 → 选择目录）。ocrc 面板现在是"添加表单 + 卡片按钮推进"；bootstrap 落地后天然有 `record→plan→apply→sync→up→pairlink` 七步，把它渲染成截图那种**步骤条 + 每步打勾/转圈/当前阶段 + 折叠日志**是最自然的升级路径。核心已有：`bootstrapRemoteInstance` 的 `steps[]` 正是 phase 事件流，只差 UI 消费。
2. **收起为两行卡片**（RDUX-10）：长任务收起后面板顶部显示"设备名 + 阶段百分比 + 当前阶段 + 进度条"；失败保持收起但呈危险色。ocrc 面板高度有限（宿主 iframe），这个"收起不丢任务"的模式直接解决 apply 30 分钟推包把面板锁死的问题。
3. **「复制日志」**。ocrc 的 `peerlog`/CLI 输出已含全部信息，面板日志区加一个复制按钮 + 脱敏过滤即可。
4. **统一五态展示模型**（RDUX-03）：把 ocrc 状态卡的 state 归并成 已连接/连接中/未连接/**需要处理**/连接失败 五态 + 每态一个主操作按钮。特别是"**需要处理优先于连接失败**——只要存在可执行的修复动作就显示为需要处理"和"**非在线状态必须有文字**（不能只靠颜色）"两条规则，直接写进 ocrc 面板的状态映射纯函数（现在 `stateLabel` 只映射 4 态）。`audit.mjs` 的 24 场景清单正好可以逐态补截图。
5. **错误分类决定主操作**：五态表里每行都有"主操作"与"原因+修复操作"两列。ocrc 卡片可在 `code`（启发 A1）之上做同样映射：`remote-space-insufficient` → 主操作"查看磁盘"，`source-server-install-required` 类比 → "安装并连接"。

### B. 改造后采纳

6. **实时进度**：ZCode 上传/下载都有百分比 + MB/s（SFTP onProgress / 远端 progress 行）。ocrc 的 `pushFileOverSsh` 已有 `onProgress(sent,total)`，但面板 job 轮询没把它带出来——job result 加 `progress` 字段即可。
7. **粘贴拆分**（RDUX-27）：主机框粘贴 `user@host:port` / `ssh user@host -p N` 自动拆字段 + "已识别"提示。ocrc 的 `--target` 解析已有同等逻辑（`runBootstrap` 里的正则），面板表单抄这个交互成本很低。

### C. 不适用

- 手机 replayable / 远控 attachment：桌面版已原生支持配对，ocrc 不做壳。
- 目录浏览器/项目导航：面板装在 openchamber 里，Add project 的目录浏览是宿主能力。

---

## 5. 许可边界

- ZCode：**Apache-2.0**（含完整 NOTICE.md 与 THIRD-PARTY-NOTICES.md）。来源：`gh repo view`、仓库 NOTICE.md。
- **借思想/结构/文案语义**：无义务。本文档描述的动线、状态机、错误分类、脱敏思路都属于这个层级。
- **抄代码（正则、命令构造器等）**：Apache-2.0 §4 要求保留版权声明并在 NOTICE 标注修改。ocrc 的 NOTICE 已有 fork 归属段式样，加一段即可（与 reeve 对 open-code-review 的处理相同）。**建议**：`sanitizeRemoteConnectionLog` 这类精巧正则值得移植，移植时在函数头注释 `Adapted from zai-org/ZCode (Apache-2.0), packages/shared/src/source-server/connectionLog.ts`，并在 NOTICE 登记。
- **SUL-1.0 红线**：ZCode 与 omo/oh-my-openagent 无关，不触碰。注意 ZCode 自己的 NOTICE 声明其"Computer Use 包为不可用占位"等边界——引用其文档时保留原文语境，不要转述成 ocrc 的能力。

---

## 6. 引用清单

ZCode 侧（均 2026-10-20 取自 github.com/zai-org/ZCode main）：

- 仓库元数据：`gh repo view zai-org/ZCode`（license Apache-2.0；pushed 2026-10-20）
- 版本：README.md「更新」（v3.16.2, 2026-10-19）；`gh release list`（v3.14.3）；commits `3c5b2276`/`aac47556`/`872ad960`
- 主规格：`docs/architecture/r3-source-server-remote-architecture.md`（§1 范围、§2 核心决策表、§3 领域模型）
- 连接 UX：`docs/architecture/remote-device-connection-ux-spec.md`（RDUX-03 五态、RDUX-04 流程归属、RDUX-10 三屏向导、RDUX-27 表单）
- 阅读入口：`docs/remote/README.md`
- Provider 下发：`docs/remote/provider-provisioning.md`
- probe：`packages/server/src/source-server/sourceServerProbe.ts`（分节标记、glibc 2.28 门禁与 ZCT-2112008575366098944 注释）
- preflight：`packages/server/src/remote/remoteAssetPreflight.ts`（四工具探测）
- 下载/上传：`packages/server/src/remote/remoteAssetInstaller.ts`（`buildRemoteArtifactDownloadCommand`、`LocalUploadAssetInstaller`）
- 安装链：`packages/server/src/source-server/transportAdapter.ts`（`installRelease` staging/EXIT-trap//tmp 教训、`ensureDaemon`、`openChannel`）
- 错误码：`packages/shared/src/source-server/errorCodes.ts`（27 个公共错误码）
- 日志脱敏：`packages/shared/src/source-server/connectionLog.ts`（`sanitizeRemoteConnectionLog` 及短密码教训注释）
- 合同类型：`packages/shared/src/source-server/contracts.ts`、`release.ts`（compatibility manifest、release descriptor schema）
- 问题台账：`docs/architecture/r3-source-server-remote-open-issues.md`
- 用户截图：ZCode 桌面版连接向导（本会话 image-cache `image-6b6c0fe5…png`）

ocrc 侧：

- probe/egress：`src/core/remote-instance.ts:181`（egress）、`:244`（环境探测）
- tier：`src/core/remote-instance-push.ts:65-75`（`appPackTierForGlibc`）
- 推送：`src/core/remote-instance-push.ts:571`（`pushFileOverSsh` onProgress）、`:886`（`offlineScriptInventory`）
- bootstrap 步骤流：`src/core/remote-instance-bootstrap.ts`（`BootstrapStep[]`）
- 面板 job：`extensions/ocrc/src/panel/RemoteInstance.tsx:186-194`
- 日志：`src/core/remote-instance-bridge.ts`（`pushLog`）、`src/core/remote-instances.ts`（`redactInstance`）
- 状态映射：`extensions/ocrc/src/status/main.tsx`（`stateLabel`）
