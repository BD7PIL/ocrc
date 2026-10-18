# 面板融合 + 面板侧 provisioning —— 交付与验收
> **已过时（2026-10-19）**：本文件描述的入口/脚本属于**上一代拓扑**（控制端 `-L` 连被控端裸引擎），其中连接页、远程工作区、配置同步、omo 编排面板、`/ocrc-host`、`/ocrc-plan` 与它们的服务端端点、验收脚本已在扩展 **0.9.2 删除**；`scripts/cdp/guest-ui.mjs` 由 `extensions/ocrc/scripts/{preview,audit}.mjs` 取代。保留作为沿革记录。


- **日期**：2026-10-16
- **性质**：`ocrc 面板侧能力 + UI 融合 —— 开发测试计划` 四个阶段的交付记录
- **正文（裁决）**：[PRODUCT 第零点九条](../PRODUCT.md) · [panel-provisioning-verdict.md](../research/panel-provisioning-verdict.md)
- **前置**：批次 6 Windows 验收（[batch6-windows-result.md](batch6-windows-result.md)）——那一轮暴露了本轮的起点：
  扩展只会开隧道（引擎不在位就什么也做不了），UI 与宿主割裂，配置桥写的是被控端**全局**配置。

---

## 一、这一轮改了什么（一句话版）

**面板不再只会开隧道**：连上之后它会告诉你就绪到第几档、缺什么、点哪个按钮补上；配置只写**项目级**
（用户级配置只读）；密钥只在「能力需要」时按 provider 搬，且从不落配置文件。**UI 不再是一套自绘控件**：
guest 帧吃宿主的主题令牌、用宿主的组件套件，视觉语言与壳一致。

| # | 交付 | 位置 |
|---|---|---|
| 1 | 三个 guest 入口接入宿主主题（`applyHostReady`），五份重复 `theme.css` 收敛成一份 `guest.css` | `extensions/*/src/shared/{host-theme.ts,guest.css}` |
| 2 | React 绑定宿主的 SDK 组件套件（按钮/徽标/字段/选择/tabs/列表/空态/横幅/开关） | `extensions/*/src/shared/kit.tsx` |
| 3 | 图标换成宿主同款 Remixicon（替掉 📁📄⎇▾▸└✓✗） | `@remixicon/react` 依赖 |
| 4 | 四个真实缺陷修复：`window.prompt` ×4 → 内联表单；omo 视图 `onItem`/`onDirectory` 从未订阅；omo 树可点 `<div>` → 真按钮；tab 切换清空草稿 | `extensions/ocrc-remote/src/panel/*`、`extensions/ocrc-omo-view/src/panel/Panel.tsx` |
| 5 | 两个**契约性**缺陷修复：`countSubagents` 依赖宿主从不发送的 `agent` 字段（面板永远显示「暂无编排」）；`outcome` 判的是 `succeeded` 而宿主发的是 `completed` | `extensions/ocrc-omo-view/src/shared/tree.ts` |
| 6 | Work Status 区块：`setHeight` 自适应、`setStatusControls` 宿主渲染控件、`setBadge` 待办数、`toast` 报错 | `extensions/ocrc-remote/src/status/main.tsx` |
| 7 | **主机视图**：四档就绪 + 引擎版本/漂移 + 部署预演与一次确认 + 能力盘点与转发落地 | `extensions/ocrc-remote/src/panel/HostView.tsx` |
| 8 | service 侧六个新模块：探测 / 取件 / 安装 / 能力 / 转发 / 项目级配置（+ 凭据通道） | `extensions/ocrc-remote/src/service/*` |
| 9 | **移除**「写被控端全局配置」的整条路径（旧入口返回 410 并指向新端点） | `extensions/ocrc-remote/src/service/main.ts` |
| 10 | 三道新门禁：guest 产物不变量、CDP 视觉对照、provisioning 真机验收 | `scripts/check-guest-bundles.mjs`、`scripts/cdp/guest-ui.mjs`、`extensions/ocrc-remote/scripts/accept-provision.sh` |

---

## 二、验收证据（都在本机可复跑）

| 门禁 | 命令 | 本轮结果 |
|---|---|---|
| 扩展单测 | `cd extensions/ocrc-remote && npm test` | **207 通过**（改动前 56；含真机形状的探测/身份/安装输出解析） |
| 类型 | `npm run typecheck` + `tsc -p tsconfig.service.json` | 绿 |
| guest 产物不变量 | `node scripts/check-guest-bundles.mjs` | 3 个 bundle：无 `process.env`、有主题桥、无 `window.prompt`；两份共享层逐字节一致 |
| CDP 视觉对照 | `node scripts/cdp/guest-ui.mjs` | **48/48**；真 Edge + 真 `sandbox="allow-scripts"` iframe，明暗两套主题各截一张（`/tmp/ocrc-guest-ui/`） |
| provisioning 验收（真机） | `extensions/ocrc-remote/scripts/accept-provision.sh --target demo@192.168.26.101` | **全过**：探测 RHEL 7.9 / glibc 2.17 → 四档就绪 → 规划（`@opencode/cli-linux-x64@2.0.27` via remote）→ 确认门禁 → 项目级配置写入（密钥改写为 `{env:…}`）→ **全局层 md5 未变** → 幂等 → 粘性合并 → 转发落地 |
| 安装脚本本体 | 本地起 sh 跑一遍生成的脚本 | 校验 → 解包 → 验版本 → 落盘 → marker 记 sha512；篡改则拒绝且不动旧件 |

**安装段（真把工件装进被控端 `~/.opencode/bin`）默认不跑**，需要 `--with-install` 且只对一次性容器或
专用测试账号使用——**绝不对生产机跑**（脚本会把这句话打在自己的用法里）。

---

## 三、这一轮从真机与测试里捞出来的东西（都不在计划书上）

1. **`config-bridge` 写全局配置是设计错误**（grill 时用户指出，本轮落地改判）：被控端
   `~/.config/opencode/opencode.json` 是**用户级配置**，而项目根 `opencode.jsonc` 优先级最高。
   现在只写项目级；旧入口 410。
2. **omo 视图在真机上永远是空的**：`countSubagents` 要求 `agent` 字段，而 openchamber 的
   `GuestSessionRecord` 从不发它（schema 只有 id/title/parentId/activity/outcome/items）。
   面板因此一直显示「暂无编排会话」。改成以 `parentId` 为唯一信号。
3. **`outcome` 词汇表**：宿主发 `completed | failed`，面板判的是 `succeeded`。
4. **键名正则漏了数字**：探测解析器把 `AVX2=yes` 整行丢掉——而 baseline 构建的选择完全依赖它
   （老 VM 常见无 AVX2）。
5. **`npx @scope/pkg@ver` 的版本剥法**：`split('@')[0]` 会把 scoped 包名整段吃掉，导致带版本的
   scoped 包永远查不到预装入口。
6. **不能用改 `HOME` 的方式沙箱化服务**：Windows 的 ssh 从 `HOME` 找私钥，改了就认证失败。
   验收脚本改用 `OCRC_CACHE_DIR` / `OCRC_CONNECT_PROFILES` 单独指。
7. **宿主渲染的控件不能提前宣告**：状态区块在首次探测回来之前就 `setStatusControls`，会闪一排
   禁用按钮（单测抓到）。

---

## 四、明确没做（都写在这里，不留静默降级）

> **第一轮的缺口有两个已在 §七 补齐**：能力包里的运行时落在目标侧（npm 形态）✅；
> 多路转发的端到端 ✅（spike 见 `scripts/spike-multi-forward.sh`）。仍在的缺口见 §七 的「明确没做」。

| 项 | 为什么 |
|---|---|
| 能力包里的**运行时安装**（Node / MCP 二进制的目标侧落地） | ~~已建模（`capabilities.ts` 的三类需求 + `npx` 改写规则），但真装运行时需要目标机上的包管理器决策（nvm？系统 node？我们自己的命名空间）……~~ **2026-10-16 第二轮已做（npm 形态）**：见 §七。非 npm 形态的二进制仍不做。 |
| **MCP 进程在目标侧起**（D12 的第二类手段，如面板侧浏览器 CDP） | 同上：需要先定「跑在哪个命名空间、谁负责收尸」。ocrc 已有侧车浏览器先例（`core/browser.ts`），可作落点。**第二轮裁决：不做**（写进 PRODUCT 明确不做）。 |
| **多路转发的端到端** | ~~argv 已生成并进单元测试（一条 ssh、多个 `-L`/`-R`），但「与被控端防火墙的交互」需要真机验证~~ **2026-10-16 第二轮已做**：`spike-multi-forward.sh` 八步实测（含端口冲突自动换端口）。 |
| `ocrc-follow.yml` 的「面板宿主镜像版本未被超越」断言 | 该断言要读面板宿主上 openchamber 的版本；CI 里没有面板宿主，硬造一个只会是假的门禁。改为在 `accept-provision.sh` 里以锚点版本的形式实测。 |

---

## 五、下一轮要做的（按优先级）

1. **运行时与 MCP 能力的目标侧落地**（上文第四节前两项），这是「能力包」真正闭环的最后一块。
   → 第二轮已交付 npm 形态；剩下的只有 **air-gap 推送运行时 tarball**（见 §七）。
2. **多路转发的真机验证**：在一台能到达内网服务的被控机上跑 `searxng` 那条能力。
   → spike 已做；**还差 searxng 那台内网机器的真实确认**（需要在能访问该内网的机器上跑一次）。
3. **`docs/handoff/batch6-windows-testing.md` 的 provisioning 增补**：本轮已把
   「被控端 v2 部署 + 面板 external 启动」的前置写进脚本与 PRODUCT；handoff 正文仍需一段
   「装完之后怎么验」。（本文件 §二 就是那段内容，可直接引用。）
4. **Windows 平台性的后端测试失败**（7 项）与**扩展的 4 项路径断言**——后者本轮已修，前者仍在。

---

## 七、第二轮（2026-10-16）：动线接入 + 运行时闭环

- **性质**：用户批准的落地方案（AI 生成的计划，用户 review 后放行）执行记录。
- **动因**：第一轮交付后用户在真机上发现两处断口——① 动线：ocrc 的能力进不了
  openchamber 的原生操作动线（左侧栏/新建任务/项目右键），`主机视图` 还报 `not found`
  （面板里跑的是旧版扩展）；② 运行时：能力清单只说「需要什么」，没有任何一条路把 npm 形态的
  MCP 真装到被控端。

### 7.1 交付

| # | 交付 | 位置 |
|---|---|---|
| 1 | **命令面**：`/ocrc-host`（现状）与 `/ocrc-plan`（待办）——把四档就绪、引擎、能力缺口打包成 chip 交给模型 | `extensions/ocrc-remote/{package.json,src/panel/commands.ts}` |
| 2 | 主机视图「交给模型」：**在此项目上新建会话**（目录已是 openchamber 项目时）+ **贴到当前对话**；`sent` 四态如实显示 | `src/panel/HostView.tsx` |
| 3 | **运行时补齐**：`~/.ocrc/runtime/<pkg>/<slot>` 落点、入口由包自己的 `bin` 解析、marker 幂等、非 ocrc 目录不碰、失败不留半截目录 | `src/service/runtime.ts` |
| 4 | 三个新端点：`POST /runtime/plan` / `/runtime/apply` / `/runtime/remove`；`/capabilities` 出参加 `runtime` | `src/service/main.ts` |
| 5 | 探测扩项：`npm --version` 与 `nodeOk`（≥ 20） | `src/service/detect.ts` |
| 6 | **npx 改写接线**（D13 从「有规则」变成「真写进配置」）：`/project-config` 写入前把已就位的运行时改成真实入口，并逐条回报 `npxRewrites` | `src/service/main.ts`、`src/panel/ConfigSync.tsx` |
| 7 | 转发端口变化可见：`/forwards` 的 `portChanges` + 改写后的 URL（跟着实际端口走） | `src/shared/provision.ts`、`src/panel/HostView.tsx` |
| 8 | 门禁扩项：CDP 加一段真实命令解析 + 交接（48 → **57** 项）；验收脚本加 `--with-runtime` | `scripts/cdp/guest-ui.mjs`、`extensions/ocrc-remote/scripts/accept-provision.sh` |

### 7.2 证据（都在本机可复跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 扩展单测 | `cd extensions/ocrc-remote && npm test` | **305 通过**（第一轮 207；新增命令摘要/运行时脚本与决策/端点契约/端口改写） |
| 类型 | `npx tsc --noEmit` + `tsc -p tsconfig.service.json` | 绿 |
| guest 产物不变量 | `node scripts/check-guest-bundles.mjs` | 3 bundle / 3 共享文件逐字节一致；**新增清单门禁**：用 SDK 自己的 `parseManifest` 解析 `package.json`（命令名、能力名、入口路径），并钉住「不许有 `contributes.background`」（它会把命令解析抢给隐藏帧）——两条都做过反向验证 |
| CDP 视觉与动线 | `node scripts/cdp/guest-ui.mjs` | **57/57**：多出「`/ocrc-host` 真解析成 chip」「chip 五字段与机器可读 data」「按钮真建会话（`start-session` 被宿主收到）」 |
| provisioning 全链验收（真机） | `extensions/ocrc-remote/scripts/accept-provision.sh --target demo@192.168.26.101 --with-install --with-runtime --registry-host 192.168.26.1` | **1–24 步全过**：探测 RHEL 7.9 / glibc 2.17 / node v20.20.2 / npm 10.8.2 → 规划 → 确认门禁 → 项目级配置（密钥改写、全局 md5 未变）→ 幂等 → 粘性合并 → 转发 → **引擎真装（remote 取件）** → **换过字节的工件被拒且旧件未动** → 卸载 → **运行时真装（`npm install` 落到 `~/.ocrc/runtime/ocrc-accept-runtime/1.0.0`，入口 = 包自己的 `.bin` 垫片）** → 幂等短路 → 重盘变 `present` → **npx 改写写进项目配置** → 不存在的包如实报 npm 的错误且不留残渣 → 移除只删我们的槽位 |

**这一轮新增的验收开关**：`--with-runtime`（在被控端真跑一次 `npm install`）、
`--registry-host`（远程靶机时 fixture registry 绑定的面板侧地址；loopback 靶机用默认值）。
两个 `--with-*` 段都会往目标机写东西，脚本的用法里写着只对一次性容器或专用测试账号跑。

### 7.3 这一轮从真机与测试里捞出来的东西（都不在计划书上）

1. **fixture registry 自带的 bug**：引擎工件的元数据请求带 scoped 包名（`@opencode/cli-linux-x64`），
   按它拼出来的文件名与磁盘上的对不上——第 [13] 步因此一直报「下载失败」。修好后
   **`--with-install` 第一次在真机上跑通**（第一轮只跑过 1–12 步）。
2. **「篡改工件必须失败」原来验不到任何东西**：旧脚本改的是请求体里的 `integrity`，而安装脚本比的是
   **计划里的**值。改成篡改**磁盘上的工件字节**（元数据不变）之后，这条门禁才真的挡住了东西。
3. **`/provision/uninstall` 的 `home` 语义**：它是被控机的 `$HOME`（引擎落点 `<home>/.opencode/bin`），
   而验收脚本传的是项目临时目录 → 卸载早就静默失效。现在端点显式校验（拒绝 `/`、相对路径、`..`），
   验收脚本传 `$HOME`。
4. **失败会污染槽位**：`npm install` 失败后目录已建、marker 没写，下一次探测会把它当成
   「别人装的目录」而**永久拒装**。现在失败收尾只删「本次刚建出来且仍无 marker」的目录，别人早有的不动。
5. **`npm install --prefix` 的参数不能攒成字符串**：`NPM_ARGS="--prefix \"$D\""` 展开后引号是字面量，
   npm 拿到的是带引号的路径（`$D` 有空格时更糟）。改成直接写在命令行上。
6. **出网探测是活依赖**：`/detect` 与 `/provision/plan` 各探一次时可能给出不同答案（第一次跑就撞上）。
   验收脚本改成把面板显示的那份 detect 原样传给规划接口——面板本来也是这么做的。
7. **`runtimeSlot` 的槽位名**：没钉版本落在 `latest` 槽（`npm install <pkg>` 装到的那个），
   钉了版本才用版本目录名；验收据此改用钉版本形态来断言槽位。
8. **装完的消息会被下一次盘点擦掉**（HostView 的 `loadCapabilities` 清 `msg`）：先重新盘点再报结果。

### 7.4 明确没做（第二轮）

| 项 | 为什么 |
|---|---|
| **air-gap 的运行时推送**（面板缓存 tarball → 推给不出网的被控端） | 引擎工件那条推送路已经跑通（`provision.ts` 的 upload 段可复用），但运行时的入口解析、marker 与「npm 在别处装出来的树」之间还差一层验证。本轮**如实报「装不了」**（`impossible`，理由写「不出网」），不静默降级。 |
| **非 npm 形态的运行时**（`uv`/`pipx`/二进制分发） | 只做 npm 一种，其余形态在能力清单里如实显示（`kind: path` → 存在即用，不存在就报「ocrc 只装 npm 形态」）。 |
| 全屏 `contributes.page` 向导、fork 上游改项目菜单、给扩展加 `background.entry` | 动线裁决（见 PRODUCT 第零点九条与 `panel-provisioning-verdict.md` §七）：只用 openchamber 已开放的那几面。 |
| searxng 那台内网机器的真实确认 | 需要一台能访问 192.168.96.11 的机器；机制已用假靶子（`spike-multi-forward.sh`）验过。 |
| `ocrc-follow.yml` 的镜像断言 | 同第一轮：CI 里没有面板宿主。 |

---

## 六、给面板侧操作的人（一次性动作）

1. **重建扩展产物前先 `npm ci`**（扩展目录里各跑一次）：本地 `node_modules/.bin` 可能是不完整
   空壳，会静默回落到仓库根的 vite 5.4.21，产出的包与 CI 不一致。
2. 重装两个扩展（`POST /api/guests`，或面板里的扩展安装入口），审批能力。
3. 被控端要跑 v2 引擎时：在「连接」页点**部署引擎**（先预演、再确认）。它装到
   `~/.opencode/bin`，**不覆盖**你既有的 `~/.local/bin/opencode`。
4. 不出网的被控机：先在面板侧点**下载工件到面板**，再推送。

### 第二轮增补（`ocrc-remote` **0.6.0**）

5. **必须重装扩展**：`0.5.0` 的产物在面板里跑起来，主机视图会报 `操作失败 / not found`
   （新端点还不存在）。重装后版本应为 `0.6.0`。
6. **会多要一个能力**：`sessions`（用于「在此项目上新建会话」）。重装时面板会再弹一次审批——
   批准它，否则那个按钮会如实报「没有权限」，其它功能不受影响。
7. **命令面怎么用**：在 composer 里敲 `/ocrc-host`（现状）或 `/ocrc-plan`（待办）。
   两者都要求**先连上一台主机**（没连上时会明说，不会静默失败）；后面可以跟档案名指名一台。
8. **交接的两条路**（在「主机视图 → 交给模型」）：
   - **在此项目上新建会话**：只有在「被控机上的工作目录」**已经是 openchamber 的项目**时才建会话；
     不是就把 chip 贴进当前对话并说明（扩展没有创建项目的 API）。新建成功后如实报
     `sent` 四态（`no-model` / `failed` 时会话仍在）。
   - **贴到当前对话**：把同一份 chip 放进输入框，不建会话。
9. **运行时**：在「主机视图 → 项目与能力 → 盘点能力」之后，每项能力会显示它的运行时是
   **已就位 / 待安装 / 装不了**（装不了会写明理由：没有 node、node 太老、没有 npm、目标机不出网、
   目录不是 ocrc 装的）。点「安装这一项」→ 一次确认 → 在被控端跑 `npm install`，
   落到 `~/.ocrc/runtime/<pkg>/<slot>`（`slot` = 声明的版本，没钉就是 `latest`）。
   装好后再写项目配置时，`npx -y X` 会被改成真实入口（预览里能看到 `npxRewrites`）。
