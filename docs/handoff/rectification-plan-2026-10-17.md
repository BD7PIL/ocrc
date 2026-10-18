# OCRC 整改方案（2026-10-17）

依据：`docs/research/openchamber-source-review-2026-10-17.md`（源码复盘）+ 本轮配对路径实测。
原则：**上游已经做完的，一律不重做；我们只保留上游做不了的那一层。**

---

## 0. 一句话

把"连接与身份"整层交还 openchamber（配对链接 → 每设备可撤销 token），OCRC 收缩为
**给"自己装不上 openchamber"的机器供货**那一层；同时删掉我们为重复实现而写的全部代码。

---

## 1. 为什么整改（三条已证事实）

1. **上游的连接层完整且更安全**：一次性链接 → 每设备独立 token（可撤销、无过期、与 UI 密码分离）。
   本轮实测：链接在 10 秒内被 app 兑换，对端签发 `auth=pairing` 的 client，app 把它当服务器用，
   而 `desktopSshInstances` **全程为空**——我们写桌面列表这件事本身就是多余的。
2. **上游的安装路径覆盖不到我们的目标机器**：managed 模式在**对端**跑 `npm/bun install`。
   断网实测：DNS 三跳 ENOTFOUND → 回落五个月旧缓存 → `ETARGET`。glibc 2.17 对端也没有可用 Node。
   所以 CI 两档包 + 推送仍是唯一通路。
3. **我这两天的交付方法有系统性缺陷**：在 minified bundle 上 grep，没命中就下结论（两次错），
   且从没走过用户路径。交付物"技术上成立、使用上不成立"。

---

## 2. 整改项

### P1 连接层：改为上游配对链接（核心）
- **现状**：`ocrc remote connect --desktop-add` 往桌面版 `settings.json` 写 `desktopSshInstances`；
  面板给「复制三项」，由人填三个字段。
- **问题**：重复实现上游能力，且比它差（要填字段、要手输 UI 密码、我们还要维护别人的配置文件）。
- **改法**：装好并启动对端后，由扩展 service **自持 `-L`**（`127.0.0.1:<localPort> → 对端:<instancePort>`），
  在对端跑 `connect-url --port <实例端口> --server http://127.0.0.1:<localPort> --name <标签>`，
  面板给出链接 + 「打开」（走 `openchamber://` 深链，app 自己弹确认）/「复制」。
- **状态**：**bridge 已完成并实测**（`pairLink()` 自起转发 + 取回链接，6 项单测通过）。
  面板按钮与 ops 待接。
- **验收**：从面板点一次 → app 弹确认 → 点确认 → 对端出现在 app 服务器列表且能打开项目/会话。

### P2 删除"写桌面版配置"整块
- **现状**：`src/core/desktop-settings.ts` + `--desktop-add` + 「复制三项」+ 相关测试与文档。
- **问题**：它是为 P1 的旧做法存在的；写别人的配置文件还带来真实风险（我昨天修的合并 bug 就是
  它静默删掉用户刚存的 SSH 密码）。
- **改法**：整个模块与调用点删除（P1 落地后）。
- **验收**：`grep -r desktop-settings src/ extensions/` 为空；门禁全绿；P1 的验收仍成立。

### P3 status 区：旧面与新面统一
- **现状**：status 区是批次 2 的 profile/隧道读数（`/connect`、`/disconnect`、`/status`，显示"隧道/未连"），
  与实例面（对端/预演/装机/启动）不是一套；空状态下它就是死的。
- **改法**：status 区改读实例状态（复用面板的 `state/引擎/node` 徽标），或直接去掉，只留面板。
- **验收**：重置状态下不再显示"隧道 未连"；有实例时显示与面板一致的状态。

### P4 面板补日志入口
- **现状**：service 已有 `logs` op，面板没有按钮（用户看不到安装/隧道日志）。
- **改法**：每行加「日志」，展开显示 `manager.logs(id)`。
- **验收**：装机后能看到日志尾部。

### P5 凭据政策收窄
- **现状**：本轮同意"允许明文 SSH 密码"，OPS 写成了通用政策。
- **改法**：明确收窄为**上游原生 SSH 实例那条路的事，我们不碰**；我们自己的路径
  （`plan/apply/up/probe`）继续 key-only；对端 UI 密码保持 `store:"never"`；
  配对链接给的是**每设备可撤销 token**，比存密码更好，所以 P1 落地后我们不需要任何密码存储。
- **验收**：OPS 的凭据段与实际代码一致；`grep -r sshPassword src/` 只出现在 desktop-settings（将被删）。

### P6 文档对齐
- **现状**：OPS 里仍有 `--desktop-add` 步骤；handoff 里有"只走 key、不支持密码"的过期声明。
- **改法**：OPS 的接入步骤整段改为"配对链接"；handoff 标为历史；`AGENTS.md` 补一行定位
  （OCRC = 供货层，连接归上游）。
- **验收**：按 OPS 步骤能从零走通，不需要任何 CLI 命令。

### P7 工作方法整改（防复发）
- 说"上游没有 X"之前，必须读**源码**（`packages/`）而不是打包产物，且**两个 bundle 都翻**。
- 涉及用户路径的改动，交付前**从用户座位点一遍**（面板 → app），不以 CI 绿灯当交付证明。
- 每份结论标注证据等级：**实测 / 源码 / 推断**——推断必须显式标出。

---

## 3. 执行顺序

1. P1 收尾：ops `pairlink` + 面板按钮（依赖 bridge，已就绪）。
2. P2 删除（P1 可用后立刻做，避免两套并存）。
3. P3 + P4（面板与 status 统一）。
4. P5 + P6 文档对齐。
5. 全量验收：从零走一遍（粘 URL 装扩展 → 面板加对端 → 装机 → 启动 → 生成链接 → app 打开）。

每步独立可回滚；P2 是唯一的删除型改动，回滚 = `git revert`。

---

## 4. 本轮已获得的证据

| 结论 | 证据 |
|---|---|
| 配对路径可用 | 对端 `client-pairing-sessions.json`：`pair_81fbf3cd… usedAt=14:02:40Z clientId=8eff9db5…` |
| app 用它当服务器 | 控制端 `settings.json`：`desktopHosts[0].clientToken=oc_client_…`，`desktopSshInstances: []` |
| 对端签发独立 token | `remote-clients.json`：`8eff9db5… auth=pairing lastUsed=14:16:57Z revoked=null expires=null` |
| 我们的代码能自持转发并取回链接 | `pairLink()` 实测：自起 `ssh -N -L 127.0.0.1:4610:127.0.0.1:2610`，返回 379 字符链接 |
| 上游 managed 装不了目标机 | 断网实测 `ENOTFOUND ×3` → stale cache → `ETARGET`（`~/.npm/_logs/…debug-0.log`） |
| `uploadBundleOverSsh` 未实现 | 源码仅 2 处引用（sanitizer + UI 模型），无消费方 |

---

## 5. 不做 / 延后

- **不做**：fork openchamber；自建连接 UI；把 SSH 密码存进我们的记录（P1 之后无必要）。
- **延后**：给上游提 `uploadBundleOverSsh` 实现（schema 已有）——若被接受，我们的 provisioning 可
  进一步退化为"只供货"，把安装也交给原生 managed 流程。

## 6. 待你决定（影响投入产出比）

**EL7 / 离线这一档在生产里有多少台？** 一两台 → provisioning + CI 包体系要重算；
一批 → OCRC 定位就是"供货层"，其余全部让给上游。这个答案决定 P1 之后是否还要继续投入。

---

## 阶段 0 实测结论（2026-10-18）

| # | 不确定 | 结论 | 证据等级 |
|---|---|---|---|
| U1 | 桌面 2.4.0 ↔ 对端 2.3.3 能否真干活 | **成立**。经转发打对端 API：`/api/version` 握手 OK（`apiVersion:1` + 兼容字段）、`/api/session` 24KB 真实会话、`/api/fs/list` 10KB 目录、`/api/provider` 在修好中继后返回 `deepseek`/`zhipuai-coding-plan`（`activation: enabled`）。**"发一条消息拿回答"仍未跑通**（留给 D6 正式写） | 实测 |
| U2 | 对端运行期外联 | **确实外联，且经我们中继**：对端 openchamber 取 `models.dev` 模型目录 + `api.openchamber.dev/v1/update/check`，走我们注入的 `HTTP(S)_PROXY=127.0.0.1:2711`。**发现真缺陷**：我们改走配对路径时丢掉了 `-R` 出网腿（日志里 69 次 `ECONNREFUSED 127.0.0.1:2711`、provider 列表空） | 实测 |
| U3 | 实例崩了会不会重拉 | **会**：`startExternalMonitor` 每 tick 查 health，不健康即 `startInstance` 重拉，健康时也补中继（`remote-instance-bridge.ts:430-460`）。**但监护只在 `up()` 后启动** → 已把起点提前到 `pairLink`。实测：杀掉中继 ssh → 30s 内自动恢复 | 实测 |
| U4 | 对端能不能装扩展 | **能**：对端有 git + `~/.ssh/id_ed25519`，且**经我们中继** `git ls-remote https://github.com/BD7PIL/ocrc.git` 成功 → https 源装扩展可行，**不需要推私钥**（D11 的顾虑不成立） | 实测 |
| U5 | 老机器资源 | **充足**：`/home` 59G 可用、内存 13G 可用，我们占 1.2G、`.ocrc-bak` 仅 1 份 → D5 的磁盘检查降级 | 实测 |
| U6 | C 批值不值得做 | 判断问题（机器数量与一致性需求），不列为前提 | — |
| U7 | 上游会不会补离线能力 | 不可预测 → D10 跟踪 | — |
| U8 | 我能验到哪 | 能验 API 层与链接生成；**Electron app 内的点击需用户** | 实测 |

**阶段 0 修掉的两个真缺陷**（提交 `3092b1bd`）：

1. `pairLink` 现在同时确保 `-R` 出网腿。配对路径替掉了桌面壳的实例记录，而那条记录原先承载这条腿；`-L` 与 `-R` 缺一，对端就失去出网 → provider 列表空、模型目录取不到。
2. `pairLink` 现在启动外部监护。**"在跑"不等于"被监护"**：没有监护，中继会随临时拥有者进程一起死。

**验证**：经中继取 `models.dev` 元数据返回 **200（3.6MB）**；`/api/provider` 恢复列出 provider；杀掉中继 ssh 后 **30s 内**由监护自动拉回。

**收敛后的范围变化**：
- **C 批从"价值待定"升为"硬需求"**——U1 证明"管道通但 provider 空/模型目录取不到时不能干活"，而 provider 配置与凭据正是 C 的内容。
- **D5 磁盘检查降级**（U5）。
- **D11 只需文档**（U4），无需另案。
- **D1 的必要性被 U2 证实**：对端每次取模型目录都依赖中继，中继不在就刷错误。
- 新增约束：**中继寿命必须绑常驻拥有者**（service），临时进程持有会在其退出后断掉（D7 一并处理）。

---

## v10 执行记录（2026-10-18）

按 v10 顺序推进，每项都带证据等级；**"发一条消息拿到真实回答"已实测通过**（阶段 0 的 U1 遗留项关闭）。

| 项 | 交付 | 证据 |
|---|---|---|
| A1 认证两档 | `sshAuth: key\|password` + `core/ssh-askpass.ts`（helper 里没有秘密，密码走 `OPENCHAMBER_SSH_ASKPASS_VALUE`；密码档禁公钥、限一次提示）+ CLI `--ssh-auth` | 单测 15 项；**EL7 实测**：密码档 `plan` 成功、**错密码失败**（负例才是"真的用了密码"的证明，因为该档禁用了公钥） |
| A2 ops `pairlink` | job 型 op + `switch` 的 `never` 穷尽检查 + "每个 union 成员都有 case" 测试 | 单测 12 项；两处防呆**都验证过会响**（临时加假 op 触发编译错误）；`ocrc remote pairlink` 实测取回链接 |
| A3 面板表单 | 表单=装机输入（认证档/装机方式/出口策略/端口/两个开关），派生值只读（档位/运行时/pin/绑定/UI 密码）；**生成配对链接**（打开·复制·重新生成）；日志；查看 UI 密码 | 面板单测 8 项；本机 live 的 `plan` 输出「出口：经控制端中继（探测：对端无出网）」/「对端直连」。**app 内那一步仍需你点**（U8） |
| C1–C6 配置与凭据同步 | `core/config-merge.ts`（一套合并引擎，两个拓扑）+ `core/instance-config.ts`（读两档 base64 / 差异 / 深合并 / 显式删除 / 0600 凭据）+ `ocrc remote config-diff\|sync-config\|sync-auth` + 面板「配置差异」卡 | 单测 23 项；**EL7 实测**：同步后 `/api/provider` 与本地一致（本地 13 个 + 引擎内建 `opencode`）；对端独有的 `acc-provider`/`mcp.servers.acc` 在合并中保留、只在 `--delete-key` 后消失；`opencode.json.ocrc-bak`、`auth.json.ocrc-bak` 都在；`auth.json` 落到 0600（对端原文件是 0777） |
| D1 出口可见 | 面板徽标 + `ocrc remote status` 打印决定与原因（冷进程先探一次）+ 修掉 OPS/研究文档里"`OPENCHAMBER_UPDATE_API_URL` 指空即关"的错误说法（空串会回落默认值，`package-manager.js:26`） | 两端实测：EL7「经控制端中继（探测：对端无出网）」、Ubuntu「对端直连（探测：对端自己可出网）」 |
| D2 status 区 | 改读**实例**状态（原读的是批次 2 的 SSH 档案隧道——用户截图里那个混淆点），单实例给 启动/停机，多实例只报计数 | 面板/status 单测 8 项 |
| D3 对端日志 | `peerlog` op + `ocrc remote peerlog`：一次 ssh 取两份对端日志（我们的 `instance.log` + 实例自己的 `openchamber-<port>.log`），面板日志卡三处并列 | EL7 实测取回两份（含路径） |
| D4 UI 密码 | 面板「查看 UI 密码」（控制端本地，同一信任域） | 面板单测覆盖 |
| D6 验收补"能干活" | 验收脚本新增：建会话 → 发标记消息 → 轮询回答；出网那步改成**按策略断言**（relay 查 `-R`+CONNECT 日志 / direct 查"没绕我们"） | **两类对端各跑一遍全过**：EL7（经中继）与 Ubuntu（直连）都在 ~3s 内拿到标记回答 |
| A4 删旧路径 | 删 `src/core/desktop-settings.ts` + 其单测 + `--desktop-add` + `--desktopRunning` + service 的 `connect` op（面板「桌面版三项」卡在 A3 重写时已消失） | 全量测试 1216 项通过；CLI `connect` 保留为**读出**（浏览器/手动路径），装进 app 走 `pairlink` |
| A5 文档 | OPS：配置同步三层边界表、`--egress/--provision/--ssh-auth`、peerlog、配对链接为推荐路径、D7 已知缺口；本文件为交付记录 | — |
| B1–B4 | `prepare` 预热三件（实测取到 210MB 引擎）；CI bundle 被消费（`cacheArtifact` 缓存→bundle→registry，摘要不符报错、无摘要忽略）+ CI 写真实摘要 + 6 项单测；文档写清 pty 两档/runtime 单档；`--offline-proof --assume-offline` | 实测：`prepare` 三件齐；`--assume-offline` 在对端**能**上外网时**拒绝执行**（参数与事实不符） |
| D5 升级入口 | `manager.upgrade` + 面板「升级到 pin」+ `ocrc remote upgrade`（已在 pin 上则明确说"已是最新"） | 实测 EL7：`OK 已经是对端该有的那一份：2.3.3（pin 来自控制端）` |
| D7 转发所有权 | `core/forward-ownership.ts`：每条腿写 marker（pid/角色/端口），起腿前先看（活的复用、死的清理），`status` 列持有者 | 9 项单测；**实测**：验收脚本报出 `ui: pid 15836（cli，本地 :4655，对端 :2711）`——残留腿的归属第一次有了名字 |
| D8–D12 | 凭据纪律表、omo 边界、`ocrc-follow` 两条上游跟踪（`uploadBundleOverSsh` / models.dev URL 可覆盖）、旧拓扑冻结标注 | — |

**执行中修正的一处 DoD 措辞**：v10 的全局 DoD 写「EL7：日志显示"经控制端（探测：对端无出网）"」——**这句话在 2026-10-18 当天就不再成立**：EL7 的
`registry.npmjs.org` 解析到 `198.18.0.30`（透明代理/假 DNS 段）且直连返回 200，所以探测结论从 `none`（经控制端）翻成 `direct`（对端直连），
策略自动跟着改（重启后实例 env 零代理变量）。这不是回归，正是 D1 要的行为：**出口按探测走，不按预设走**。
所以 DoD 的正确读法是「EL7 与 Ubuntu 各跑一遍，日志与策略一致」——relay 档查 `-R` + CONNECT 日志，direct 档查"对端自己出网 + 引擎零代理变量"。
一条**既有的** `-R 2711`（别的持有者留下的）不算失败，脚本会报出持有者。

**仍未完成 / 需要你**：

1. **A3 的 app 内点击**（U8）：面板生成链接后，需要你在桌面版里点确认——这是唯一只有你能做的验收步骤。
2. **D7 的残余**：桌面壳持有 `-L` 时，CLI 的 `up` 仍会因端口被占失败（现在至少会说清是谁占着）。要彻底解决得让 CLI 也能进 external 模式（本轮没做，属于"新功能"，按 D12 该加在实例拓扑上）。
3. **D6 的 app 内那一半**：验收脚本走的是引擎 API 直连（真发消息、真拿回答）；"从面板点击发消息"仍需你点。

---

## 追加一轮（2026-10-18，扩展 0.8.2）：面板收缩成一个功能、状态区只读、词表对齐上游

**起因**：你截图里的两块——右侧状态区（两个标题、控件换行、读数与面板重复）与面板卡片（同一事实印三遍、两张卡显示的事实集不一样），
外加「连接 / 远程工作区 / 配置同步」三个 tab「完全没有用」。诊断结论（可复现）：

1. **状态区**：宿主那一栏是「manifest 标题 + 我们注册的控件 + 我们的帧」三段拼出来的；我在三处都写了东西 → 两个标题、
   两套计数（帧里的「在线 2」+ rail 图标徽标）。SDK 允许 4 个控件但不保证一行放得下，`对端(下拉)+启动+停机` 在窄栏里换行，
   「停机」落成一个没有主人的按钮。
2. **卡片**：标题里的 `demo@192.168.26.101` 就是记录 id（即 SSH 地址），下一行又原样印一遍；「出口」同时进徽标、摘要与详情；
   六徽标同权；主动作与目的动作（打开界面）权重颠倒；文案里混着 `隧道由桌面版持有`、`预演`、`档位`、`派生值`、`推包`、`Add project 列的`。
   两张卡显示的事实集不同，是因为字段由"最后填它的那条代码路径"决定（活体探测填 app/engine，reconcile 路径只填 detail），缺的字段不写「未知」。
3. **三个 tab 是死的**：磁盘上没有 `ocrc-connect-profiles.json` → 连接页空态、工作区没有活动档案、配置同步停在「需要先建立隧道」；
   而「远程工作区」**就算加了档案也打不开任何目录**——服务端每个 `/fs/*` 要过 `profile.allowedRoots`，面板的添加表单**从不发这个字段**
   （验收脚本 `accept-workspace.sh:57` 是直接 POST 带白名单的档案，所以脚本绿、UI 死）。更根本的是这三块属于上一代拓扑
   （控制端 `ssh -L` 连远程机器上裸跑的引擎），而现在是远程机器自己跑 openchamber、app 用配对链接连它。

**这一轮交付**（详见 [OPS](../OPS.md) 的「面板与状态区」一节）：

| 项 | 交付 | 证据 |
|---|---|---|
| 面板收缩 | 去掉 tab 栏；删 `HostView.tsx` / `Workspace.tsx` / `ConfigSync.tsx` / `OmoOrchestration.tsx` / `commands.ts` + 对应测试与 manifest 的 `commands`；面板 = 服务器列表 | 扩展测试 295 项通过；`Panel.test.tsx` 断言"没有 tab、没有那三块" |
| 卡片重做 | 固定三行（名称·状态 / 地址·登录方式 / OpenChamber·OpenCode·直连或经本机转发），缺的写「未知」；主动作随状态推进；「详情」「更多」分组折叠；移除服务器二次确认 | 10 项面板单测（含"地址只出现一次"「两台机器不许显示成两个产品」） |
| 状态区只读 | 每台一行读数（名称·状态 / OpenChamber 版本·直连或经本机转发）；撤 `setStatusControls`、撤 `setBadge`、不再自写标题；`defaultExpanded: true` | 7 项状态区单测（含"不注册控件、不挂徽标"） |
| 词表对齐 | 面板/状态区/core 的用户可见串换成上游 zh-CN 词：远程机器 / OpenCode / 经本机转发 / 联网方式 / 检查·试运行 / 安装 / 兼容档 / 界面密码 / 停止 | 后端 1245 项 + 扩展 295 项全绿；两处 typecheck 绿 |
| 自查工具 | `extensions/ocrc-remote/scripts/preview.mjs` + `preview/*`：真面板（真 kit、真 guest.css）挂假宿主，`?scenario=` 切状态 | **截图看过** 0/1/2/3 台 × 未安装/已停止/在线 × 详情/更多展开；靠它抓出两处真 bug：esbuild 没注入 `guest.css`（样式全丢）、`.oc-row-between` 从批次 2 起被用着却一直没定义 |
| 发布 | `0.8.2`（zip 无自更新，需重粘同一 URL 覆盖安装） | CI + `ocrc-ext.yml` |

**仍未完成 / 需要你**：

1. **三块服务端的去留**：面板已不再暴露它们，服务端端点还在（批次 2–5 的验收脚本仍在用）。收缩成"只为这一个功能服务"
   要删的是 `tunnel/tunnels/remote-fs/config-bridge/config-project/provision/runtime/capabilities/auth-sync/detect/artifact/omo-config`
   及其测试、两个验收脚本、OPS/handoff 对应段落——**等你看完 demo 再动**（demo 见可视化目录 `ocrc-panel-redesign-demo.html`）。
2. 上面那三条 U8（app 内确认配对链接 / 面板点一次发消息）仍然只有你能做。
