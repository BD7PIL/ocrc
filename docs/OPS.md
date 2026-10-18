# Operations Guide

> ocrc 运维手册，对齐 **v0.26.5** 现状（npm 包 `@bd7pil/ocrc`、`ocrc start`
> 生命周期、SSH remote hosts）。架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装

```bash
npm i -g @bd7pil/ocrc     # npm 上的 opencode-remote-control 是无关包，别 npx
ocrc install              # 交互：Telegram bot token + user id（可留空 → web-only）
ocrc start /path/to/your/project
```

要求：Node 20+，opencode 1.17+（生产验证至 1.18.32，EL7/glibc 2.17 是硬边界）。
`ocrc install` 写插件桥到 `~/.config/opencode/plugins/ocrc.js`、配置到仓库 `.env`
（0600）。从源码跑：`npm install && npm run build:all`，CLI 入口 `node dist/cli/index.js`。

## 生产生命周期（supervisor 内建）

```bash
ocrc start <dir>    # spawn 自身 --supervisor（detached），adopt-or-spawn
ocrc status         # binary / server / supervisor / web panel / workdir
ocrc stop           # 先 TERM supervisor，再实例；15s 后 SIGKILL 兜底
ocrc restart [dir]  # stop + start
ocrc restore        # 读 ~/.ocrc/run/last.json 幂等复活（@reboot cron 用）
```

语义（cli/service.ts）：
- **崩溃自愈**：子进程 SIGKILL/段错误/OOM 都视为崩溃，5s 后重启
  （`OCRC_WATCH_DELAY` 可调）；SIGTERM/SIGINT 或 stop 文件 = 真停。
- **adopt**：端口已被占用时收编现有实例而不是双起。
- 开机自启（opt-in）：`@reboot sleep 60 && ocrc restore >> ~/.ocrc/prod.log 2>&1`
- 日志：`~/.ocrc/prod.log`（supervisor/实例 stdout）+ `~/.ocrc/ocrc.log`
  （应用日志，10MB 轮转）。

## Standalone host（可选，多后端）

```bash
OCRC_BACKENDS="opencode, kimi=kimi acp" ocrc host
```

独立进程（非插件），ACP agent 需先登录（如 `kimi login`）；opencode 后端由
host 自 spawn（4096 起，被占则向后探测 10 个）。ACP 会话持久化在
`~/.ocrc/acp-sessions.json`。前台进程，崩溃不自启——生产建议 plugin 模式。

## SSH remote hosts（0.26+）

> **不推荐新用（D12，2026-10-18）**：这是**引擎级**旧拓扑（控制端跑面板、隧道连对端
> 引擎，v1 口径），只保留兼容。产品形态是**实例级**——openchamber 跑在对端，见
> 「远程 openchamber 实例」一节；配置同步也请用实例的 `config-diff`/`sync-config`
> （深合并 + 显式删除），不要用这里的整文件覆盖版。本节只修 bug，不加功能。
> 冻结的入口：`src/core/remote-host.ts`、`remotes.json`、`/api/remotes/*`、`ocrc_remote_*`。

Web 面板 Inspector → **Remotes** 卡片（API：`/api/remotes`）：

| 操作 | 路由 | 说明 |
|---|---|---|
| 注册/编辑 | `POST/PATCH /api/remotes[/:id]` | host/port/user/remotePort；密码自动生成（0600 存储，API 永不回显） |
| 探测 | `POST /api/remotes/:id/inspect` | 一轮 ssh：平台/glibc/opencode 路径+版本/凭据/端口 |
| 安装 | `POST /api/remotes/:id/provision` | 官方安装器 pin 本地版本；无外网回退 scp 本地二进制 |
| 同步凭据 | `POST /api/remotes/:id/sync-auth` | 复制本机 `~/.local/share/opencode/auth.json`（0600） |
| 启停 | `PATCH /api/remotes/:id` `enabled` | 启动 = 隧道+serve 一个 ssh 进程；删除两步确认 |

状态机：`unknown → detecting → provisioning → launching → online`，异常态
`needs-auth / error / offline / disabled`；面板轮询 GET /api/remotes 看
`status.logTail`（ssh 输出 200 行环）。远端默认端口 4199（避开用户自己的
4096 serve）。注册生效需重启实例（channels 同款语义，UI 已标注）。

添加主机走**四步向导**（选择方式 → 填写配置 → 连接中 → 完成）：向导自动
探测 → 缺装则部署 → 启动隧道 + serve → 等待在线；「连接中」页实时展示
部署/隧道日志。

## 远程 openchamber 实例（2.0.0-alpha.8，「对端能力」）

在被控端跑一个 openchamber 实例，控制端只建转发并打开它——Add project 列的、中栏连的就是对端。
契约见 [PRODUCT 第零点十条](PRODUCT.md)，设计/证据见
[handoff/remote-instance-dev-and-test-plan.md](handoff/remote-instance-dev-and-test-plan.md)。

```bash
# 登记一台（生成 UI 密码，只落 ~/.ocrc/remote-instances.json 0600）
ocrc remote add --host 192.168.26.101 --user demo

# 只读预演：ssh/环境/引擎门禁/将要做什么（不写对端）
ocrc remote plan demo@192.168.26.101

# 装机：推运行时(node24-glibc217) + 引擎(opencode v2 pin) + 应用(@openchamber/web)
# 控制端备件 → ssh stdin 推送 → 对端原子落位；对端**零联网命令**
ocrc remote apply demo@192.168.26.101

# 起实例 + 转发 + 出网中继，然后打开 http://127.0.0.1:4610
ocrc remote up demo@192.168.26.101 --open
```

| 操作 | 命令 | 说明 |
|---|---|---|
| 状态 | `ocrc remote status [id]` | 对端引擎**路径与版本**、隧道 pid/重连次数、中继端口，以及**出口决定**（`对端直连` / `经控制端中继` + 原因）。冷进程里 status 会先探一次——出口是"决定"，不是内存里的开关 |
| 出口策略 | `ocrc remote add … --egress auto\|relay\|direct` | `auto`（默认）探测对端：能自己出网就直连、不通才经控制端；`relay`/`direct` 强制。**有外网的对端不该被无脑拉进控制端**（2026-10-17 起为默认行为） |
| 装机方式 | `ocrc remote add … --provision push\|reuse` | `push`（默认）推控制端备件；`reuse` **一个字节都不推**，只检查运行时/应用/引擎并把引擎 pin 下来，缺件就明确失败 |
| 认证档 | `ocrc remote add … --ssh-auth key\|password` | `key`（默认）用本机 `~/.ssh` 与 agent；`password` 经 askpass 喂密码并**禁用公钥**（否则带口令的私钥会先被试，报的错与密码无关）。密码只落 0600 档案、接口不回显；省略 `--ssh-password` 时从终端（不回显）或 stdin 读 |
| 日志 | `ocrc remote logs <id>` | 本端隧道/重连日志尾（受监督时同屏） |
| 开关 | `ocrc remote switches <id> [--reconnect on\|off] [--restore on\|off] [--replay on\|off]` | R10 三级；**改完立刻对运行中的监督生效** |
| 出网 | `ocrc remote proxy <id> on\|off` / `relay-status <id>` / `proxy-log <file>` | R9；中继日志 `~/.ocrc/remote-relay.log` 记每次 CONNECT |
| 白名单 | `ocrc remote proxy <id> allow api.deepseek.com,openai.com` / `allow-clear` | 点边界后缀匹配；**空 = 只拒回环**。收紧后必须同时放行模型 provider 与引擎基础设施域名（`models.opencode.ai` 等），否则引擎能起不能用；改完要 `down`/`up` 重启中继 |
| 一键 external | `ocrc remote connect <id> [--json] [--open]` | 桌面版 Remote Instances 要的地址/密码/端口一次给出；`--open` 直接开浏览器那档。桌面版 external 模式已实测可用（2.4.0 连自装 2.3.3）；列表由桌面外壳独占，**不自动写**（人工合并见下） |
| 停机 | `ocrc remote down <id>` | 停实例 + 撤转发（保留档案） |
| 删档 | `ocrc remote remove <id>` | 只删档案；对端 `~/.ocrc/remote` 不动（要清跑验收脚本 `--teardown --purge`） |
| 离线证明 | `ocrc remote offline-proof` / `trace-check <file>` | 结构性零联网断言 / strace 判读 |
| 预热备件 | `ocrc remote prepare [--app-version V]` | 只在控制端取件+打包（离线部署前预热缓存） |
| 监督 | `ocrc remote supervise` | 前台跑 R10 ①②（无面板机器用）；面板宿主 `ocrc start` 里是同一份实现 |

> EL7 终端修复：`bash scripts/remote-node-pty-glibc217.sh <ssh-target> [--verify\|--rollback]`
> —— 按宿主 glibc 重建 node-pty（见「排障」最后一条）。

**HTTP 面**（面板/自动化）：`GET/POST /api/remote-instance`、`PATCH /api/remote-instance/:id`、
`:id/plan|apply|up|down|status|logs|url|delete`。`apply` 要 `confirm:true`（否则 409 + dryRun）。
密码不回显（`hasUiPassword`）。

**接进 openchamber 桌面版（多机聚合，2026-10-17 真机实测）**

1. 装官方桌面版（2.4.0+；Windows 安装包 `OpenChamber-<v>-win-x64.exe`，per-user 安装，不需要管理员）。
2. 桌面版 → Settings → Remote Instances → 新增：
   - **SSH command**：`ssh demo@192.168.26.101`（key 或密码都行，见下方凭据政策）
   - **Mode**：**必须选 `external`**。`managed` 会在对端装**第二套** openchamber 并起它自己的服务
     （走对端的 bun/npm + 公网 registry），与我们推的实例争端口与引擎所有权——同机不得混用。
   - **Remote port**：`2610`；**Bind**：`127.0.0.1`
   - **UI password**：按需填写；**勾"不保存"**（`store: "never"`），或用完删掉
3. 连接后桌面壳自己建 `ssh -L 127.0.0.1:<local>:127.0.0.1:2610`。验证：
   `curl -s http://127.0.0.1:<local>/api/system/info` 返回对端 `openchamberVersion` 与 pid；
   带登录 cookie 请求 `http://127.0.0.1:<local>/api/fs/list?path=%2Fhome%2Fdemo` 列的是对端目录；
   Add project 的目录浏览器就是它，会话跑在对端引擎。
4. **版本不必相等**：external 模式只要求 major=2 且能力 `api.runtime-url.v1`（2.3.3 有）；版本不等提示
   update-recommended，仍可连。
5. **推荐路径：`ocrc remote pairlink <id>`（面板上是「生成配对链接」）**——把链接交给官方 app 确认，
   身份由上游发（一次性链接 → 每设备、可撤销、无过期的 token），机器出现在「其他 OpenChamber 服务器」。
   **我们不写桌面版的 `settings.json`**（2026-10-17 收敛：那是桌面壳自己拥有的面，写它属于「不做」清单；
   `--desktop-add` 与 `src/core/desktop-settings.ts` 已删除）。手工往 `desktopSshInstances` 里合并请自己
   备份 `.ocrc-bak`、只 upsert 并设 `desktopDefaultHostId`、**不要写 clientToken**。

**SSH 凭据政策（2026-10-17 修订：允许明文密码）**

- **允许**在桌面壳里存 SSH 密码（原生 UI 的 `auth.sshPassword`，`store: "settings"`，**明文落在
  `~/.config/openchamber/settings.json`**）。原生壳实现方式是生成 `SSH_ASKPASS` helper 并把密码经
  `OPENCHAMBER_SSH_ASKPASS_VALUE` 传给它（`SSH_ASKPASS_REQUIRE=force`），**不需要 sshpass**，Windows 可用。
  好处：全新机器不再需要人工把公钥放进 `authorized_keys`。
- **我们自己的路径（`plan/apply/up/probe`）仍只走 key**：推送与探测不需要交互式密码，也不引入
  askpass helper；对端的 `authorized_keys` 已就位。
- **对端 openchamber 的 UI 密码**（`auth.openchamberPassword`）**保持 `store: "never"`**——它是另一个密钥
  （登录对端 UI 用），代价只是首开手输一次。别把两者混为一谈。
- **保密纪律**：`settings.json` 及其 `.ocrc-bak` 现在可能含明文密码；`~/.ocrc` 的记录保持 0600。
  任何备份/截图/贴日志前先确认里面没有 `sshPassword.value`；**永不进仓库**（2026-10-17 曾有一次文档里
  写入口令字面量、提交前拦下）。

> **出网中继归谁（2026-10-17 实测）**：控制端的**中继监听**（`ocrc remote proxy-serve`，端口 4711）与
> 对端的 `-R 127.0.0.1:2711` 两条腿合起来才是出网通道。历史形态是桌面壳的 `portForwards` 里带 `-R`
> （那条路随 `--desktop-add` 一起删了）；现在是**谁起实例谁带腿**：面板 service 在 `up` 时起
> 控制端监听 + 自己的 `-R`，CLI `up` 的隧道自带 `-L`+`-R`。已有一条 `-R` 在听时**复用而不是抢**。
> 因此 service 的 `status` 在 external 模式下**不拿配置里的 localPort 当"连上了"的判据**，
> 而是实测远端实例健康 + `-R` 是否在听；CLI 的 `status` 同样会在本地转发不属于自己时如实说明。
> service 本身由 openchamber **懒启动**（第一次打开「OCRC Remote」面板/触发 service 请求），此后每 20s
> 自检远端、实例掉了会自动重拉——它管的是"对端实例还在不在"，不是"隧道在不在"。
> **已知缺口（D7）**：桌面壳持有 `-L` 时，CLI 的 `up` 会因本地端口被占而失败（`ExitOnForwardFailure`），
> 所以"重建出网中继"目前只有面板 service 能做；`ocrc remote proxy-serve` 可以单独把控制端监听起成
> detached 进程补上这一半。

> **内嵌结论（2026-10-17）**：扩展页面不能 iframe 对端——guest CSP `frame-src 'self' data: blob:` 与对端
> `frame-ancestors` 双重阻断；guest sandbox 也没有 `allow-popups`，`window.open` 同样被拦。扩展页面的
> 「打开」必须用 SDK 的 `host.openUrl`（系统浏览器）。证据见
> [research/embedding-experiment.md](../research/embedding-experiment.md)。

> **web 版不能做这件事**：`openchamber --port 3000` 的 Settings 里也有 Remote Instances 页，但 SSH 隧道由
> Electron 主进程的 `desktop_ssh_*` IPC 提供，浏览器里没有这个桥。`desktopSshInstances` 在 settings registry 里
> 标注 `scope=instance, owner=desktop-shell, surfaces=[desktop]`，这是“必须走桌面壳”，不是“不能用”——
> 桌面版 external 模式接受我们自装的实例，不需要它来安装。

**CI 兼容包（Linux x64 两档，2026-10-17 真机验证）**

> **命名规则（2026-10-17 收敛）**：名字从**机器标识**派生，不从显示名派生；第二段是件类。
> 版本放在哪一侧，由"这个件怎么被寻址"决定——**平铺目录寻址的带版本，tag 寻址的靠 tag**。

| 件 | 资产名 | 版本轴 |
|---|---|---|
| 对端 openchamber 应用包 | `ocrc-openchamber-pack-<ver>-linux-x64-<tier>.tar.gz` | tag `ocrc-openchamber-pack-<ver>`，同时也在文件名里 |
| 控制端扩展 | `ocrc.zip` / `ocrc-omo-view.zip` | tag `ocrc-remote-<ver>`（钉）/ `ocrc-latest`（通道） |

应用包文件名**必须**带版本：`OCRC_PACK_DIR` 是平铺目录，离线镜像会把多个版本放在一起，
tag 不是唯一的版本轴。扩展相反——它只有一个入口 URL，所以文件名恒定、版本全交给 tag。
`ocrc` 从此只指扩展，不再兼任应用包前缀（`ocrc-openchamber-pack-*` 才是）。

- **产物**：`ocrc-openchamber-pack-<ver>-linux-x64-modern.tar.gz` 与 `...legacy-glibc217.tar.gz`，各带
  `.sha512`（base64）、一份 tier manifest 与一份 `.lock.json`（构建时冻结的依赖图）；
  发布在 GitHub Release `ocrc-openchamber-pack-<ver>`。
- **档位规则**：对端 glibc **< 2.31 → legacy**（node-pty 按 2.17 重建 + glibc-217 Node）；
  **≥ 2.31 → modern**。`ocrc remote apply` 自动探测，不需要手工选。
- **两档 vs 单档（如实，别按直觉猜）**：
  - **node-pty（终端能不能用）= 两档**：modern 用官方 prebuild；legacy 用 CI 里 `centos:7` 重建的那份。
    对端装好之后还可以用 `scripts/remote-node-pty-glibc217.sh <ssh-target>` 在**对端**按宿主 glibc 重建
    （换 openchamber 版本后要重跑）。
  - **Node 运行时 = 单档**：只有 `24.22.0` 的 **glibc-217 非官方构建**一份（24.x 线里没有别的 glibc-217 产物）。
    所以 modern 档的对端**也**跑这份 glibc-217 Node——"modern/legacy" 只区分 pty 来源，不区分 Node。
    上游没有 glibc-217 官方产物，这一档只能我们自己供。
- **控制端取件**：默认从 release manifest 下载并按 sha512 校验后缓存；离线/内网用
  `OCRC_PACK_DIR=<目录>` 指向本地包目录；两处都没有时回退控制端跨装（`npm install --os=linux`）。
- **引擎（opencode v2）取件（B2）**：默认 npm registry → sha512 校验 → 缓存；离线/内网用
  **`OCRC_BUNDLE_DIR=<目录>`** 指向 `ocrc-follow.yml` 的 `bundle` 产物（`cli-<target>-<ver>.tgz` +
  `manifest.json`，内含每个 target 的 sha512/sha256/字节数）。取件顺序是 **缓存 → bundle → registry**：
  bundle 命中且摘要对得上就不走网络；**manifest 里没有摘要的 bundle 文件会被忽略**（不装没校验过的字节），
  摘要不符则**报错**而不是悄悄回退下载。
- **预热三件（B1）**：`ocrc remote prepare` 现在把**运行时 + 应用 + 引擎**都备好（此前漏了引擎，
  离线 `apply` 会装到一半才缺件）。加 `--engine-version` 可指定引擎版本，`--force` 重新取件。
- **构建**：`node scripts/build-app-pack.mjs --version <ver> --tier modern --out pack`；
  legacy 在 CI 的 centos:7 容器里跑（`scripts/build-pty-legacy-local.sh` 重建 pty，
  `objdump` 断言 GLIBC ≤ 2.17、GLIBCXX/CXXABI 引用 0）。工作流：
  [`.github/workflows/ocrc-pack.yml`](../.github/workflows/ocrc-pack.yml)（每日 + 手动）。
- **一个版本只构建一次（2026-10-17 修正，octg 式闸门）**：`detect` 把 Release tag 当构建身份——
  `ocrc-openchamber-pack-<ver>` 已带齐 7 件核心资产就**整条链跳过**，所以每日 cron 在上游没发版的日子
  只花几秒，且**已发布的包永不被静默替换**。Release 存在但缺资产 = 不完整 → 门放行、补建，
  那是唯一会 `--clobber` 的路径。要强制重建已发布的版本，先
  `gh release delete ocrc-openchamber-pack-<ver> -R BD7PIL/ocrc --yes`（或删掉其中一个资产）再 dispatch。
  门的判定是"资产名齐不齐"，不校验内容——内容由控制端取件时的 sha512 兜底。
- **可复现（2026-10-17 修完）**：安装改成 `npm install --package-lock-only` + `npm ci`（不再裸装），
  打包用确定性 tar。三处都是踩过才知道的：① 依赖图必须冻结，否则"同版本"每天解析出不同传递依赖；
  ② 不能用 tar 的 `-z`——centos:7 的 tar 1.26 会把当前时间写进 gzip 头，于是内容完全相同的包每次
  字节都不同，改用 `gzip -n`；③ mtime 用 **1980-01-01**（`--mtime=@315532800`）而不是 epoch 0——
  tar < 1.28 对 1980 以前的时间戳每个文件都警告一次，epoch 0 会在 EL7 部署日志里刷出两万行。
  排序后的文件表代替 `--sort`（tar 1.26 没有这个选项）。`.lock.json` 随包发布：同版本同字节可审计，
  被清理的版本也能原样重建。**注意 npm ci 的树是提升布局**（`lib/node_modules/node-pty`），
  与旧的 `-g` 嵌套布局不同；`build-pty-legacy-local.sh` 与 `remote-node-pty-glibc217.sh` 两种都探测。
- **保留策略**：中间 artifact 3 天（够重跑一次失败的 publish）；本工作流的 run 只留最近 30 次；
  pack Release 超过 90 天清理，但**永不清理 `DEFAULT_APP_VERSION` 钉住的版本**（清掉也能 dispatch 重建，
  且字节一致）。
- **证据**：`tests/unit/remote-app-pack.test.ts`；RHEL7 真机 `apply` 后远端 `pty.node`
  GLIBC 上限 2.14、终端 `/api/terminal/create` → `running`，fs/sessions/providers 均正常。
  2026-10-17 追加：同一版本连跑两次 CI，modern（`0PBpyTNFD3Nwdupd…`）与 legacy
  （`YWHHK4OllFJhsilj…`）两次 sha512 各自完全一致；新包在 EL7 上解包 0 警告、
  `cli --version` → 2.4.0、`node-pty` 在 glibc 2.17 上 spawn 成功（`PTY_OK | /dev/pts/0`）。
- **旧 tag 兼容**：`ocrc-remote-pack-2.3.3` 保留不动，字节与新 tag 下的一致。它是给
  **2026-10-17 之前构建的扩展**（其内嵌的是旧包名）留的兜底；等所有控制端都换成新构建的扩展后再删。
  修剪任务只匹配新前缀，所以它不会被自动清掉。

**装扩展（控制端，粘 URL）**

面板 Settings → Extensions 直接粘 URL 即可，**不要** clone 仓库走 folder 安装。两种装法，按要不要自更新选：

```
# ① 自更新（推荐日常用）：git 装法 —— app 能自己发现并应用更新
https://github.com/BD7PIL/ocrc#ocrc

# ② 钉版本 / 离线分发：zip 通道（永不变），没有自更新
https://github.com/BD7PIL/ocrc/releases/download/ocrc-latest/ocrc.zip

# ②' 复现"这台机器装的是哪一版"：钉 tag 的 zip（不可变）
https://github.com/BD7PIL/ocrc/releases/download/ocrc-0.9.0/ocrc.zip
```

`ocrc` 是**扩展自己的分支**（`ocrc-extension.yml` 每次发布用 `git subtree split` 把
`extensions/ocrc` 推到该分支，force-push）。为什么要有这个分支：`parseGitInstallUrl`
认 `url#ref`，但 `cloneGitRepository` 跑的是 `git clone --depth 1 --branch <ref>` 并把**克隆根**
当 guest 根，所以 monorepo 的子目录当不了 guest；subtree 分支的根就是扩展本身（根目录有
`package.json`），两个条件同时满足。

**自更新到底是怎么成立的（源码级 + 本机实测）**：

- 装的时候把 `origin`（url + ref）记进安装记录；`checkGuestUpdate`
  （`server/lib/guests/updates.js`）在**已装的克隆里**跑 `git fetch --depth 1 -- origin <ref>`
  → `git show FETCH_HEAD:package.json` → 和本地版本比 semver。
- 本机用 openchamber 自己的安装代码实测（`parseGitInstallUrl` + `cloneGitRepository` +
  `checkGuestUpdate`，装到临时目录，不碰已装的扩展）：
  `#ocrc` → 解析出 `ref`；克隆根有 `package.json`（`ocrc-remote 0.8.2`）与
  `panel/index.html`、`service/main.js`、`status/*`；同版本 → `available:false`；
  装作旧版本 → `available:true, version 0.8.2, requested:["sessions","service"]`。
- 所以**扩展的版本号就是更新信号**：`extensions/<name>/package.json` 的 `version` 不提，
  git 装的副本就看不到更新（与"钉 tag 会被跳过"是同一条规矩）。
- zip 装法**没有**自更新，而且面板连"有新版本"都发现不了：`checkGuestUpdate` 的第一道判断是
  `if (!origin?.url) return { available: false, error: 'not-git' }`（`updates.js:85`）——zip 装的
  guest 没有 git origin，所以"检查更新"对它返回 **not-git**，不是"已是最新"。
  zip 装的升级方式 = **把同一个通道 URL 再粘一次**（弹冲突确认，确认后带 `replace:true` 覆盖安装；
  能力审批与启用状态都会保留）。
- **URL 是活的**：`-latest` 那个 tag 每次发布都用 `gh release upload --clobber` 覆盖
  （`.github/workflows/ocrc-extension.yml`），所以同一个 zip URL 永远指向最新那份。实测：同一 URL 从
  0.7.0（253,525 B）变成 0.8.0（273,291 B），sha256 也变了。

- 装完会有**一次 service 能力审批**（扩展要在宿主上跑 `ssh`）——批准；git 装法在应用更新后
  会**再问一次**（`requested` 里带着能力清单），这是上游行为，不是回归。
- 升级后想确认装的是哪一版：看面板的扩展卡片，或 Release 资产的 label（现在是 `ocrc-remote 0.8.2`）。

**面板与状态区（0.8.2 收缩：一个功能、一条动线）**

面板只剩一件事：**把 openchamber 装到远程机器上，然后把 app 连过去**。动线 =
添加服务器 → 检查并安装 → 启动 → 创建配对链接（在桌面 app 里确认后，机器出现在
「其他 OpenChamber 服务器」）。卡片按**固定字段顺序**画，缺的写「未知」：

1. `名称 · 状态`（在线 / 已停止 / 未检查 / 出错 …）
2. `用户@主机:端口 · 登录方式`
3. `OpenChamber <版本> · OpenCode <版本> · 直连/经本机转发`

主动作**随状态推进**（未安装 → 检查并安装；已停止 → 启动；在线 → 打开界面 + 停止），
其余动作收在「详情 ▾」（端口/路径/转发/探测/最近一次结果）与「更多 ▾」（配置 / 维护 /
开关）里；移除服务器要二次确认。**每条事实只出现一次**——地址不再既进标题又进第二行，
网络也不再同时进徽标、摘要与详情。

**右侧状态区只读**：每台一行 `名称 · 状态` + `OpenChamber <版本> · 直连/经本机转发`。
不注册控件（宿主那一栏只有一行宽，下拉+按钮会被挤成两行、落下一个没有主人的按钮，
而且与面板里的同一组按钮重复）、不挂 rail 徽标、不自写标题（manifest 的 title 已经有一行）。

**上一代三块已从面板撤下**（服务端端点保留，批次 2–5 的验收脚本还在用）：

| 块 | 它做的事 | 为什么不再露在面板上 |
| --- | --- | --- |
| 连接 | 控制端的 openchamber 用 `ssh -L` 去连远程机器上裸跑的 OpenCode | 前提是"远程机器没有自己的界面"；现在远程机器自己跑 openchamber、app 用配对链接连它 |
| 远程工作区 | 从控制端浏览/编辑远程机器的文件、跑 git | 每个请求要过档案的 `allowedRoots`，而面板的添加表单**从不发这个字段** → 403；打开远程 openchamber 自己的 Files/Git 得到的是真那一份 |
| 配置同步 | 把控制端面板写的 agents/MCP/providers 写进远程机器**项目目录**的 `opencode.jsonc`（外加 omo 编排面板） | 它要求"隧道已建立"（上一代通道）→ 永远停在空态；实例卡的「配置差异 → 同步配置/同步凭据」写的是用户级 `~/.config/opencode` + `auth.json` |

`/ocrc-host`、`/ocrc-plan` 两个斜杠命令一并撤下：它们的数据源是上一代档案+隧道，
面板撤掉入口后只会报「没有连接中的档案」。omo 编排面板也随「配置同步」一起撤下
（对端的 `oh-my-opencode-slim.json` 仍在配置同步白名单里，能整体同步，不能结构化编辑）。

**词表（上游 zh-CN）**：远程服务器 / 远程机器 / 配对链接 / 界面密码 / 端口转发 /
服务器名称 / 服务器地址。我们不再用：对端（→ 远程机器）、引擎（→ OpenCode）、
中继与出口（→ 经本机转发 / 直连 / 联网方式）、档案（→ 服务器）、预演（→ 检查 / 试运行）、
装机（→ 安装）、档位（→ 兼容档）、UI 密码（→ 界面密码）、停机（→ 停止）。
理由：上游自己的中文界面就是这套词，借用它的「中继」反而会撞它自己的 E2E relay 语义。

**自己先看再交（面板/状态区的视觉验收）**

```bash
node extensions/ocrc/scripts/preview.mjs        # 起本地预览，打印两个 URL
# 面板   http://127.0.0.1:5199/panel.html?scenario=mixed&theme=light
# 状态区 http://127.0.0.1:5199/status.html?scenario=two&theme=light
```

预览挂的是**真面板**（真 kit、真 `guest.css`），只把 `connectHost` 换成假宿主
（`preview/sdk-shim.ts`），场景见 `preview/scenarios.ts`（empty / one / two / mixed / fresh）。
CI 绿不等于能用：这一轮就是靠它看出 `guest.css` 没被 esbuild 注入（样式全丢）与
`.oc-row-between` 这个从批次 2 起就被用着、却一直没定义的类。

- 发布走 [`.github/workflows/ocrc-extension.yml`](../.github/workflows/ocrc-extension.yml)（**只有手动
  dispatch**）：钉 tag 只写一次、通道 tag 按设计覆盖。升级前先提
  `extensions/<name>/package.json` 的 `version`，否则钉 tag 会被跳过。
- 一个 zip 只装一个扩展：安装器的 `unwrapGuestRoot` 只在"恰好一个顶层目录且里面有
  `package.json`"时 unwrap，所以旧的 `ocrc-extensions-*.tar.gz`（顶层两个目录）**装不上**。
  两个扩展要分别粘两个 URL。
- 证据：用对端 openchamber 2.3.3 的**真实安装器**（`server/lib/guests/install.js` 的
  `installGuestFromUrl`）对上面两个 URL 各跑一次，均 `ok=true`，识别出 `ocrc-remote 0.7.0`，
  拷贝出 `package.json panel service status`，能力请求为 `sessions`+`service`（待审批）。
  omo-view 同理（只有 panel，能力请求 `conversation`）。

**omo（oh-my-opencode-slim）边界（D9）**

- `ocrc-omo-view` 只是**只读视图**：它读面板宿主上 omo 的编排配置（per-agent 链、fallback），
  自己不做任何安装或改写。**面板宿主没装 omo 时它显示空**——这是如实，不是 bug。
- 对端的 omo 由**同步**带过去：`oh-my-opencode-slim.json` 在配置同步白名单里（C1）。
  **面板上的 omo 编排区块已随「配置同步」撤下**（0.8.2）：那个区块只活在上一代通道里，
  服务端 `/omo/config` 保留但面板不再有入口——要结构化改它，先在对端把文件改好再同步。
- **对端 omo 生效的前提**是对端引擎真的加载了那个插件（`plugin` 键）——而 `plugin` 属于对端
  openchamber 自己的 managed 层，**我们的配置同步会丢弃它**（C2）。所以：装了 omo 的对端，
  它的 `plugin` 由对端自己的 openchamber/面板管，我们不越权；`ocrc-omo-view` 显示的是**面板宿主**的链，
  与对端当前生效的链可能不同——两者都如实标注，不合并成一个数。
- PRODUCT 的边界没变：**omo-slim 默认不装**（它是可选项，不是我们的 provisioning 义务）。

**出网判定（2.0.0-alpha.8 起）**

判据是 **models.dev**（`https://models.dev/api.json`）——openchamber 自己取 provider/模型目录的地址，
取不到它 = 面板没 provider = 从面板看就是"没网"。**不是** npm registry：能上 npm 但取不到目录的对端会被
（有意的）判为需要中继。

方法是一条**地址族感知**的链，因为"一个地址族不等于对端"：

1. `curl -4`（默认吃对端自己的 `http_proxy/HTTPS_PROXY`，所以"对端自己有代理"会被正确判成有网）；
2. 失败才试 `curl -6`；
3. 没有 curl 就用 `wget`（同样吃代理 env）；
4. 都没有才退回我们推过去的 Node（只能测 DNS+TCP，**看不到代理**，最弱的一档）。

每个尝试都套 `timeout 5`：curl 自己的 `--max-time` **打断不了阻塞的 `getaddrinfo`**，实测断网机上
一个卡住的解析器能让 curl 忙满 glibc 的重试周期（每个地址族约 10s）。被 cap 杀掉不算判定——它会落到
Node 兜底（自己给解析器设上限），所以"没有路由"和"没有解析器"还能分开。

判定词与动作：`direct` → 直连；`dns-only` / `none` → 经中继；`unknown` → 经中继（保守，且如实说"没测出来"，
**绝不谎报"没有出网"**）。退出码映射是纯函数 + 单测，其中两条**不猜**：代理错误(5)与 TLS(35) 一律 `unknown`。

代价：能出网的对端约 3-4s；出不了网的要两个族都失败才敢下结论，约 9-13s；结果按实例缓存 5 分钟。
**出口策略翻面后，实例要重启才会带上新 env**——`up` 会检测这个不一致并自动重启（实测：Ubuntu 从
"经我们中继"翻成"直连"后，`up` 重启实例，引擎 env 变回它自己的代理）。


**配置与凭据从本地同步（C1–C6，2.0.0-alpha.8）**

对端的引擎读的是**对端自己**的 `~/.config/opencode`——面板宿主的配置不会自己飞过去，而且上游的 provider UI
**没有删除入口**（只有新增/编辑/停用），所以同步是唯一能表达"对端该和我一样"的路径。

| 层 | 谁拥有 | 我们的同步碰不碰 |
|---|---|---|
| `~/.config/openchamber/opencode.managed.json` | 对端自己的 openchamber（源码：`server/lib/opencode/managed-config-file.js`，**只装 `plugins`**） | **不碰**；`plugin`/`plugins` 键在合并结果里被丢弃并写明原因 |
| `~/.config/opencode/opencode.json` / `.jsonc` | 用户（`.jsonc` 里常带注释当文档） | 深合并：只覆盖我们提供的叶子，**对端独有的键一律保留**；旧件留 `.ocrc-bak` |
| `~/.local/share/opencode/auth.json` | 用户凭据（provider 的 key） | C3：整份经 ssh stdin 写到对端 **0600**，不回显、不进日志 |

```bash
ocrc remote config-diff <id>        # 只读：两个方向的差异 + 一次同步会做什么（含将被压住的键）
ocrc remote sync-config <id>        # 推差异（opencode.json 深合并；只写差异文件）
ocrc remote sync-config <id> --delete-key provider:acc,mcp.servers:acc   # 显式删对端独有的配置项
ocrc remote sync-config <id> --delete agent/old.md                       # 显式删对端独有的文件
ocrc remote sync-auth <id>          # provider 凭据 → 对端 0600
```

三条必须知道的语义（都实测过，别按直觉猜）：

- **`.jsonc` 比 `.json` 优先**（源码：`shared.js` 的 `userPaths=[opencode.json, opencode.jsonc]` + `readConfigLayers` 让 jsonc 覆盖 json）。
  所以合并目标是**对端赢的那一层**；若那层带注释，我们**不重写它**（注释是用户的文档），改写到 `opencode.json`
  并列出"会被压住的键"。要让值真正生效：更新/删掉对端那个 jsonc，或加 `--prefer-commented-target` 明确接受丢注释。
- **删除永远是显式的**：对端独有的文件与配置项只在 `config-diff` 里**列出**，勾选/`--delete-key` 才删，且都留 `.ocrc-bak`。
- **密钥不落配置文件**：MCP `environment` 里的字面量密钥会写成 `{env:VAR}`（值本身不写）；provider 的 key 走 `auth.json`。
  `{env:VAR}` 的值由**对端自己的环境**提供——我们不替你发明它。

**变更与回滚**
- 换版本：`ocrc remote apply <id> --app-version 2.4.0 --engine-version 2.1.0`（旧树自动留 `<prefix>.ocrc-bak`）。
- 只换引擎：同上带 `--engine-version`；或先在对端放好再 `--engine-path <绝对路径>`（pin 会被断言，不满足 v2 门禁直接拒）。
- 关出网中继：`ocrc remote proxy <id> off` + `ocrc remote down/up`（serve 行的 env 只在下一次启动时摘掉）。
- 全撤：`ocrc remote down <id>` → `ssh <host> 'rm -rf ~/.ocrc/remote'` → `ocrc remote remove <id>` →
  删 `~/.ocrc/remote-instances.json` 记录与 `~/.ocrc/remote-relay.log`。对端既有 opencode 全程不动。

**排障**
- `plan` 说"不满足 v2 门禁"：对端只有 v1（或没有）——`apply` 会推我们 pin 的 v2 到 `~/.ocrc/remote/engine/opencode`。
- `up` 说"本地 <端口> 已被占用，但它没有 -R 出网中继"：多半是旧命令留下的隧道（没有 `-R`），先停掉它再 `up`。
- 终端不可用（EL7 常见）：实例的 `node-pty` prebuild 要 `GLIBC_2.28`（宿主 glibc 2.17）——**换 libstdc++ 解决不了**。
  `ocrc remote plan` 的预演里会如实标注。真修走 `scripts/remote-node-pty-glibc217.sh <ssh-target>`：
  在对端用 devtoolset 按宿主 glibc 重建 node-pty（`-static-libstdc++`），替换 prebuild 并留
  `.official-glibc228.bak`；`--verify` 断言符号上限并 spawn 真 PTY，`--rollback` 还原。
  思路与现成工具见 `BD7PIL/zcode-legacy-glibc`（ZCode 桌面版 remote 的同款问题）。**换 openchamber 版本后需重跑。**
- **听写**：EL7 的本地 sherpa 不可用（GLIBC 2.32，不重建）。在实例的 openchamber 设置里把 dictation
  provider 设为 `openai-compatible`（指向一个 OpenAI 兼容 STT 接口）；选了它就不会加载 sherpa。
- 对端引擎没出网：`relay-status <id>` 看端口与日志。`-R` 与 `-L` 是**同一条 ssh**，所以隧道掉 = 中继一起掉，
  受监督时（面板/`supervise`）会自动重连；CLI 的 `up` 起的是 detached 隧道，机器重启后不会自己回来（要 `up` 或跑 `supervise`）。
- 手机看不到：控制端要监听手机可达的地址（见「公网访问」段），注意手机上的 `127.0.0.1` 是手机自己。

## 企业内网场景（air-gapped / 中转）

三件事，两件配置一件免费：

**A. LLM 请求经企业代理出网**（向导「企业代理」字段组，存 remotes.json 0600）：
- `HTTP_PROXY` / `HTTPS_PROXY`：注入远端 serve 进程（大小写双份）。
- `NO_PROXY`：留空自动设为 `127.0.0.1,localhost`；自定义时也会**强制追加**
  这两项——隧道与 ocrc→serve 的回环流量绝不能被企业代理劫持。
- `CA 证书路径（远端）`：远端信任企业网关的 MITM 证书（`NODE_EXTRA_CA_CERTS`）。
- 模型网关：opencode provider 支持 `options.baseURL` 覆盖——把被控端
  `opencode.json` 的 provider 指向企业 LLM 网关，随 **同步配置** 推过去即可。

**B. 控制通道走跳板**：零开发。`~/.ssh/config` 配 ProxyJump，ocrc 用系统 ssh
自动继承：

```
Host airgapped-01
    HostName 10.20.0.11
    ProxyJump bastion.corp
```

**C. 离线安装**：远端无外网时 provision 自动回退为 **scp 本地二进制**
（同一官方 artifact、平台匹配、pin 本机版本；跨架构会被拒绝）。向量导的
「连接中」日志里看 `falling back to scp` 字样。

凭据同步（`sync-auth`）与配置同步（`sync-config`）都走 ssh 通道，不依赖
公网；代理 URL 含凭据时面板脱敏显示。

**凭据纪律（D8，贴日志/备份前自查）**

| 文件 | 里面可能有什么 | 权限 |
|---|---|---|
| `~/.ocrc/remote-instances.json` | **SSH 密码（明文，密码档）**、实例 UI 密码、provider 无关 | 0600（POSIX 生效；**Windows 上由 ACL 决定，不是 0600**） |
| `~/.ocrc/remote-instances.json` 的 `.tmp` | 同上（写盘中间态） | 0600 |
| `~/.config/openchamber/settings.json`（**桌面壳自己的**，我们不写） | 桌面壳存的 `auth.sshPassword`（明文） | 由桌面壳决定 |
| 对端 `~/.local/share/opencode/auth.json` | provider API key（我们同步过去的那份） | 我们写成 0600（同步前对端自己那份实测是 0777） |
| 对端 `~/.config/opencode/opencode.json(.jsonc)` | 配置；**MCP 的 `environment` 字面量会被写成 `{env:VAR}`**，值不落文件 | 对端自己的权限 |

- `ocrc remote list --json`、面板接口、`config-diff` 输出都**不回显**任何密码（只有 `hasSshPassword`/`hasUiPassword` 布尔）。
- `ocrc remote connect <id>` 与面板「查看 UI 密码」会**明文打印实例 UI 密码**——那是控制端本地的读出，别把输出贴进工单/截图。
- 密码档的密码只经环境变量喂给 ssh helper（`OPENCHAMBER_SSH_ASKPASS_VALUE`），**helper 脚本里没有秘密**；但 `ps` 能看到 ssh 子进程的环境（同用户可读），所以别在共享机器上用密码档。
- 备份 `~/.ocrc` 之前先确认目标位置同样是私有的；**永不进仓库**（2026-10-17 有过一次文档里写入口令字面量、提交前拦下）。

## 公网访问（手机 PWA 需 HTTPS）

Web 默认 `0.0.0.0:4099`（token 门禁）。PWA 安装需要安全上下文：

| 方式 | 命令 | 说明 |
|---|---|---|
| LAN 明文 HTTP | `http://<lan-ip>:4099` | 浏览器可用；装 PWA 需 HTTPS |
| Tailscale | `tailscale serve 4099` | 稳定 `*.ts.net`，设备级认证 |
| cloudflared | ingress `service: http://localhost:4099` | 稳定域名；改后 `kill -HUP <pid>` 热重载 |
| cloudflared 快速隧道 | `cloudflared tunnel --url http://localhost:4099` | 免费，URL 轮换；配 `OCRC_WEB_PUBLIC_URL` |

### 配对与远控会话（P-remote，对齐 ZCode v3.15.1 语义）

两层凭据，生命周期完全解耦：

| 层 | 凭据 | 进入方式 | 失效时机 |
|---|---|---|---|
| **锚设备**（桌面） | 永久 token（`~/.ocrc/token`） | `ocrc start` 末尾打印的 `#token=` 链接 | 仅 `ocrc pair --reset` / 撤销配对轮换 |
| **手机**（会话） | 会话凭证（内存态，主机重启即清） | 面板侧栏 ▸ 远程控制 扫码 / `ocrc pair` / TG `/pair` | 会话**刷新**（新 epoch 踢全部手机）或**停止** |

远控会话管理**仅限主机本机**（loopback 403 兜底）：面板远程控制弹层左栏
（开启/刷新二维码/停止/复制链接，刷新与停止有官方同款确认弹窗），或 CLI：

- `ocrc pair` — 开启/刷新会话并打印二维码（再跑一次 = 刷新 = 踢人）
- `ocrc pair --stop` — 停止会话（锚设备不受影响）
- `ocrc pair --reset` — 轮换锚 token（锚设备与手机全部失效；TG bot 通道不受影响）

会话存续期二维码可**多台手机**扫（每台各得一个会话凭证）；会话关闭后
onboarding 页显示「已关闭」而非二维码。`WEB_AUTH=cf-access` 模式无会话
（相关端点 409）。**隧道后严禁** `OCRC_WEB_CF_ACCESS_DEV_BYPASS=true`
（cloudflared 从 127.0.0.1 连入，等于对全网免认证——也会绕过会话管理的
loopback 门）。

## 环境变量（`~/.ocrc/config.env` 或 `.env`，0600）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` / `ALLOWED_USER_IDS` | — | TG 通道；两者必须成对，留空 = web-only |
| `OCRC_WEB_ENABLED` / `_HOST` / `_PORT` | `true` / `0.0.0.0` / `4099` | fork 默认 LAN-first（legacy `WEB_*` 名仍兼容） |
| `OCRC_WEB_AUTH` | `token` | 或 `cf-access`（需 TEAM+AUD） |
| `OCRC_WEB_PUBLIC_URL` | 自动探测 | cloudflared ingress → LAN IP → loopback |
| `OCRC_SERVER_PORT` / `OCRC_SERVER_BIN` | `4096` / `~/.local/bin/opencode` | `ocrc start` 用 |
| `OCRC_WATCH_DELAY` | `5`（秒） | 崩溃重启延迟 |
| `OPENCODE_SERVER_PASSWORD` | — | 服务端开了 Basic 认证时，所有裸 fetch 自动附带 |
| `CHAT_TIMEOUT_MS` | `600000` | 单轮超时 |
| `TG_CHUNK_SOFT_LIMIT` | `3500` | TG 分页软限 |
| `LOG_LEVEL` | `warn` | 只写文件（stdout 会污染 TUI） |
| `OCRC_LOCALE` | `zh` | TG i18n（en 兜底） |
| `OCRC_BACKENDS` / `OCRC_ACP_CMD` | — / `kimi acp` | 仅 standalone host |
| `OCRC_OFFPEAK_WINDOW` | `00:00-08:00` | 闲时工单派发窗口（`HH:MM-HH:MM`，start>end 表示跨午夜） |
| `OCRC_CSP` | `enforce` | web 面板 CSP 响应头模式：`enforce` / `report`（Report-Only 收集）/ `off`。由 host 下发（非 `<meta>`），脚本 nonce 每响应一枚；排障或新部署可先切 `report` 看违规 |

## 目标循环（N12 goal）——运维要点

- **状态在哪**：`~/.ocrc/state.json` 的 `goals` 槽位（按 sessionId）。删会话会连带清掉；
  `POST /api/goal {action:'clear'}` 或 TG `/goal clear` 单清。
- **重启行为**：host 启动时把**所有 active 目标落成 `paused`**（绝不自动拉起——上游同款
  冷恢复语义）。用户 `resume` 才续跑；状态、迭代计数、用量与验收历史都不丢。
- **验收器**：一次独立子会话调用（`promptOnce`：建子会话 → 带 `tools` 禁用写类工具发一次
  prompt → 读回复 → 删子会话）。**fail-closed**：坏 JSON / 调用失败 / 空回复一律停机并通知，
  不判"通过"。**残余风险**：工具名空间无法枚举，`tools` map 只能禁已知写类工具（write/edit/
  multiedit/patch/bash/task/todowrite），叠加提示词里的"不要调用工具"约束；证据窗口有界
  （~8k 字符），超长会话可能"证据不足"→ 同样停机通知（宁可停，不误判完成）。
- **三条硬闸**：token 预算（上游有）、迭代上限 12、无进展检测（连续 2 轮同 nextAction）
  ——后两条是本项目新增。撞闸 = `paused` + 一张 info 卡（TG 与 /z/ 都收得到）。
- **成本**：每回合末一次验收调用（一个子会话，约等于一次短问答）。不想要就 `/goal clear`。
- **关停**：host `dispose()` 会先 `goalManager.stop()` 再拆传输——停机时不会有续跑派发进已拆的
  relay。

## Dynamic workflows（P0–P4）——运维要点

- **开关**：`OCRC_WORKFLOW=off` 整面变暗（不读 journal、不注册路由）。host 日志里
  `workflow engine enabled — journal at <dir>` / `workflow engine disabled` 是判据。
- **状态在哪**：`~/.ocrc/workflows/`——
  `runs/<runId>.jsonl`（每 run 一个 journal，行种类见 ARCHITECTURE）、
  `artifacts/<runId>/<id>.v<version>`（产物字节 + `index.json` 记 contentType）、
  `saved.json`（具名可复用脚本）。删 run 就删它的 journal；产物目录可单独清。
- **崩溃恢复**：host 重启时把 `running` 的 run 落 `stopped(interrupted)`（**可 resume**），
  **绝不自动续跑**——actor 会话是用户的，重跑要花 token。`ocrc wf resume <runId>` 或
  `POST /api/workflow/runs/:id/resume`。`errored`（脚本自己的错）**不可 resume**，只能 amend。
- **取消**：`ocrc wf cancel <runId>` 只对**本进程**在飞的 run 生效（host 持有的那些）；
  落 `stopped(user)`。
- **并发**：run 级上限 = 提交时的 `maxConcurrency`（默认 4），进程天花板
  `max(1,min(16,availableParallelism()-2))`。引擎按上限排序派发，driver 另有一层 seat gate。
- **token 预算**：提交时给 `tokenBudget`，越线即停（`stopped`）。用量取引擎自己的
  per-session token 计数，与面板同源。
- **world.run 的人工门**（默认开）：`OCRC_WORKFLOW_RUN=off` 一律拒绝 /
  `=auto` 放行并每次 warn（无人值守）/ 缺省发审批卡等决策，**超时 5 分钟即拒绝**。
  只有从会话里起的 run 才有父会话可问；没有父会话的命令一律拒绝。`always` 按
  (run, 命令) 记忆。
- **world 读的 caps**：grep 2000 条 / 256KB、glob 2000、git diff 512KB、world.run
  stdout+stderr 各 256KB、默认超时 300s。**超限是拒绝不是截断**（脚本可以 catch）。
- **成本**：每个 actor 是一个独立子会话（与用户会话同列，可在面板里打开）；一个 3 actor
  fan-out 就是 3 份上下文。想省就在脚本里少扇出，或给 `tokenBudget`。
- **CLI**：`ocrc wf list|show|events|cancel|resume|amend|run|compile|saved`（读面不需要
  引擎在跑；`run`/`resume` 指向 host 用的同一个引擎，`OCRC_SERVER_URL` 决定是哪个）。

### 面板面（P4）——面板与命令

- **workflow 面在 `/z/` 里是否可见**，唯一总闸是 `codingPlanSubscriptionService
  .getDynamicWorkflowClientConfig()`（我们如实回 `alwaysOn/override`）。它 fail-closed：取数
  失败即 `enabled:false`，卡片/按钮/侧页/Saved Workflows 全部隐藏——面板里「什么都没有」时
  先查这一条。
- **读面**：`GET /api/workflow/projection[?sessionId=]` 是面板读的那一份（journal 现算）；
  另有七条 vendor 形状的只读查询（`/runs/:id/{events/v4,workspace,artifacts/v4,...}`），
  每条都要求 `sessionId` 等于该 run 的 parentSessionId。
- **`ocrc wf` 与面板读同一份 journal**，但路径不同：CLI 直接读文件，面板经 HTTP。所以 CLI 能
  看到而面板看不到时，先确认 host 在跑、token 有效。
- **amend 的缓存**（P4b）：日志里 `amend <id>: import cache {...}` 是命中；`no import cache
  (missing_boundaries)` 表示前驱的 ask 没有 `messageBoundary`（P4b 之前的 run 都是这样），
  修订照常进行、只是重跑——不是错误。`messageBoundary` 由 driver 补写（typed ask 在值被接受时
  写临时值，turn end 写权威值——权威那条常常在 run 结算**之后**才到，由 `settledDrivers` 接住），
  单位是 actor 会话的**卡片条数**，宿主另记一行 `ask-boundary`（含边界消息 id）。
- **转录种子**（P4b 第二轮）：日志里 `actor … seeded from <session>: N units` 是分歧 actor 拿到了
  前驱前缀；`no transcript seeding … (backend lacks forkSession)` / `no boundary at N units` /
  `fork failed` 都是**如实降级**——那条 actor 以空会话开场、修订照常跑。`transcript seeding … the
  copy will be one message short` 表示源转录读不出来、只能拿边界消息当切点（少一条）。
- **saved workflows**：`~/.ocrc/workflows/saved.json` 是**机器级**一个 store（不是按项目分
  目录的文件）。面板的 `dir`/`path` 报的就是这个文件；scope 是记录上的字段（默认 `project`）。
  `moveSavedWorkflow`（全局→项目）如实拒绝——没有可搬的文件。
- **门禁**（隔离栈 + 真实浏览器/CDP，全部在 `scripts/spikes/p4-*/`）：
  `p4-projection` 23/23、`p4-queries` 37/37、`p4-saved` 20/20、`p4b-amend` 18/18。
  每道都自起 host(:4199)+引擎(:4295)+stub 模型(:4300)，**生产引擎 :4096 零接触**，子进程 env
  显式清空 Telegram 凭据。记录见 `docs/workflow-p4-record.md`。

## 诊断速查

```bash
ocrc status                                          # 一眼看全
tail -f ~/.ocrc/ocrc.log                             # 应用日志（LOG_LEVEL=debug 更细）
curl -s -H "Authorization: Bearer $(cat ~/.ocrc/token)" \
  http://127.0.0.1:4099/api/logs | tail              # 应用内日志环（500 行）
curl http://localhost:4096/global/health             # opencode 健康
ss -ltnp | grep -E '4096|4099'                       # 端口占用
```

WS 上下文零帧/配对失败等前端问题：浏览器 DevTools → Application → Service
Workers → Unregister（别用 Clear site data，会连 localStorage 的 token 一起清）。

## 构建与测试（源码开发）

```bash
npm install && npm run build:all   # tsc + vendor dwf 引擎 + web-next（vite build）
npm test                           # 后端 vitest（853 例）
npm run typecheck
cd web-next && npm test            # /z/ 桥接 vitest（161 例）；npm run typecheck

# 隔离 dev 实例（4199）——AGENTS.md 有完整命令。scripts/spike-restart.sh
# （4598 遗留，误跑会抢 TG token 顶死隔离 host）已于 2.0.0-alpha.7 删除；
# scripts/v2-restart.sh 仅限 /tmp/ocrc-spike 沙盒，非沙盒环境会自我拒绝。
```

> 本地 vitest 不编译 web 的全部组件——CI 才是完整门禁（历史上两次构建错误只有
> CI 抓到）。
