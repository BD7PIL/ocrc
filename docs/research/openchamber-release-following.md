# openchamber「不 fork、跟随上游发版」可行性调研

- **调研日期**：2026-10-14
- **对象**：https://github.com/openchamber/openchamber（MIT，main @ 2026-10-13）
- **部署拓扑前提（2026-10-14 裁决）**：openchamber 面板只跑在 **Windows/Mac**（Node 24.14+ 无障碍）；**EL7/glibc 2.17 永远是被控端**，只跑 opencode v2（已实测 v2.0.27 原生可跑；Node 24 起不来，需 GLIBC_2.28）。
- **网络形态**：(A) 被控机有公网直连 LLM；(B) 被控机完全离线，仅控制端 SSH 通道，LLM API 流量与一切下载经控制端代理出口。

---

## 1. 分发渠道全清单

结论先行：**发行主渠道 = npm `@openchamber/web`（CLI/Web 模式）+ GitHub Releases（桌面版二进制）。没有 Docker Hub / GHCR 公开镜像发布；仓库里的 Dockerfile 只支持源码自建。**

### 1.1 npm

- `openchamber` 裸名 **不存在**（`npm view openchamber` → 404）。确切包名：
  - **`@openchamber/web`**（v2.3.1，2026-10-13 发布，latest）——CLI/Web 模式本体，`bin: { openchamber: bin/cli.js }`，`engines: { node: ">=24.14.0" }`，157 个历史版本。来源：registry.npmjs.org `npm view @openchamber/web --json`。
  - **`@openchamber/sdk`**（v2.3.1 同步发版）——guest/扩展契约包（manifest 解析 + iframe host bridge），`bin: openchamber-guest-bundle`，仅依赖 zod。来源：npm registry。
- 依赖面（`@openchamber/web` 2.3.1）：`@opencode/client 2.0.27` + `@opencode/schema 2.0.27` 精确 pin；含 `node-pty`、`bun-pty`、`sherpa-onnx-node` 等**原生模块**（pnpm 安装需 `--allow-build=msgpackr-extract --allow-build=node-pty`，见 install.sh 与 `packages/web/server/lib/package-manager.js` 同步的清单）。
- 注意 npm 上另有第三方镜像/马甲包（`@vantran-se/openchamber-web`、`openchamber-sogawugu` 等），**不是上游**。

### 1.2 桌面版（Electron，GitHub Releases）

发布流水线 `.github/workflows/release.yml`（742 行）产物矩阵：

| 平台 | 产物 | 备注 |
|---|---|---|
| macOS | `OpenChamber-<v>-mac-<arch>.dmg` + `.zip` + `.blockmap` | x64/arm64，Apple 签名 + 公证 |
| Windows | `OpenChamber-<v>-win-<arch>.exe`（NSIS）+ `.blockmap` | x64/arm64 |
| Linux | `OpenChamber-<v>-linux-{x86_64,arm64}.AppImage`、`-amd64.deb`、`-x86_64.rpm`（arm64 对应 arm64.deb / aarch64.rpm） | electron-builder targets：`AppImage/deb/rpm` |
| npm tarball | 上传到 Release 附带 | SDK 单独发 npm |

来源：release.yml 的 `build-desktop-electron-macos/windows/linux` job 与 `Upload Linux packages and manifests to release` 步骤；桌面版构建内嵌 **opencode CLI 2.0.27**（`packages/electron/package.json` 的 `opencodeCli.version`，从 `https://registry.npmjs.org/@opencode/cli-<target>/-/cli-<target>-<v>.tgz` 下载，见 `packages/electron/scripts/prepare-opencode-cli.mjs`）。

### 1.3 Docker

- **无任何镜像发布渠道**：
  - `.github/workflows/` 19 个 workflow 中只有 `release.yml` 是发布流水线，grep `ghcr|docker|buildx|registry` 仅命中 npmjs 的 `registry-url`；GHCR 代码搜索零命中。
  - Docker Hub `hub.docker.com/v2/repositories/openchamber/` 返回 `{"count":0}`，命名空间为空。
- 仓库根有 `Dockerfile`（`oven/bun:1.4.2` 多阶段，runtime 阶段 apt 装 nodejs + `npm install -g @opencode/cli@2.0.27`，COPY `packages/web/{bin,server,dist}` + sdk dist，EXPOSE 3000）和 `docker-compose.yml`（挂载 `~/.config/openchamber`、opencode 的 share/state/config、`.ssh`、workspaces；必须设 `OPENCHAMBER_UI_PASSWORD`；支持 `OPENCODE_HOST`/`OPENCODE_SKIP_START` 外接引擎）。入口 `scripts/docker-entrypoint.sh` 默认 `bun packages/web/bin/cli.js`。
- **用途判定**：这是开发者自建镜像，不是官方分发渠道。若 EL7 需要「openchamber-lite 被控端」兜底，只能自建镜像（bun 基础镜像自带 glibc 较新，绕开 EL7 的 2.17 问题），且**要自己维护构建跟随**——镜像内 pin 的 `@opencode/cli@2.0.27` 写死在 Dockerfile 里，随上游发版不会自动更新。

### 1.4 install.sh

`scripts/install.sh`（307 行，`curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash`）：

1. 校验 Node ≥ 24.14（不满足则给 nvm/brew/fnm 指引后退出）；
2. 已装则**直接移交 `openchamber update`**（避免跨包管理器孤儿文件）；
3. 未装则探测包管理器（pnpm > bun > yarn > npm）并执行 `pnpm add -g @openchamber/web` / `npm install -g @openchamber/web` 等。

**下载源就是 npm registry**，没有独立二进制分发。

## 2. CLI/Web 模式与桌面版的依赖差异

- **入口**：`packages/web`（不存在 packages/cli）。CLI 入口 `packages/web/bin/cli.js`（471 行）→ `bin/lib/commands-serve.js` 起 `packages/web/server/index.js`（Express 5）；子命令 serve/update/stop/restart/tunnel/startup/connect-url/status/logs/schedule/session/models/projects/control。
- **生产形态 = Node 服务 + 静态前端**，不是纯静态资产：`vite build` 产出 `packages/web/dist`（前端），但运行必须挂着 `packages/web/server`（Express + ws + node-pty + 内置扩展 runtime）。npm 包装的就是「服务 + 静态资产 + bin」。
- **与桌面版共享同一 server 代码**：`packages/electron` 只是原生壳（窗口/菜单/autoUpdater/SSH/tunnel），electron-builder 的 `files` 明示打包 `node_modules/@openchamber/web/server`——桌面版 = Electron 壳 + npm 包同款 server + 内嵌 opencode CLI。差异仅在：桌面版**自带** opencode（`resources/opencode-cli`），CLI/Web 模式**用宿主上已装的** opencode（或走 `packages/web/server/lib/opencode/v2-install.js` 托管安装）。
- 引擎兼容门：`packages/web/server/lib/opencode/compatibility.js` 定义 `MINIMUM_OPENCODE_VERSION = '2.0.20'`（注释：2.0.15 提供 `PATCH /api/session`，2.0.20 新增 `GET /api/credential` 是 quota/voice/routing 的唯一取数途径），**只接受 2.x**；`UnsupportedOpenCodeVersionError` 硬拒 1.x 和 <2.0.20。

## 3. 自动更新机制

- **桌面版**：`electron-updater ^6.8.3`，provider = **GitHub Releases**（`packages/electron/updater-feed.mjs`：`{provider:'github', owner:'openchamber', repo:'openchamber'}`；唯一 override 是 E2E 测试用 loopback generic feed）。通道：默认 `latest.yml`/`latest-mac.yml`/`latest-linux.yml`，Win arm64 走 `latest-arm64` 特殊通道（`updater-channel.mjs`）。Linux 上 AppImage 原地替换；.deb/.rpm 由 `linux-package-install.mjs` 经 pkexec 装系统包。默认用户确认制，「nothing installs without your say-so」（docs/updates.mdx）。
- **CLI 自更新：有**。`openchamber update`（`bin/lib/commands-update.js` + `server/lib/package-manager.js`）：
  - 检查源双路：① POST `https://api.openchamber.dev/v1/update/check`（可用 `OPENCHAMBER_UPDATE_API_URL` 改指向自建镜像；**指空不是切断**，空串回落默认值——见 6.4 修正）拿 latestVersion + release notes；② 回退直接查 npm registry `dist-tags.latest`（`server/lib/opencode/npm-registry-config.js`，"Server: version checks use your npm registry"，v2.1.1 changelog）。
  - 执行：探测当初安装所用的包管理器，重跑 `npm install -g @openchamber/web@<精确版>` 等，然后**自动重启正在运行的实例**。
- **opencode pin 的联动**：
  - 桌面版 pin 在 `packages/electron/package.json` 的 `opencodeCli.version`（当前 2.0.27），`prepare-opencode-cli.mjs` 支持 `OPENCHAMBER_OPENCODE_CLI_VERSION` 环境覆盖。commit 搜索显示 bump 频率≈**每 1-3 天一个**（2.0.16→2.0.27 十一个版本，2026-09-24→10-12），消息格式 `chore(opencode): bump OpenCode to x.y.z`。
  - CLI/Web 模式不 pin 引擎版本，只有 `MINIMUM_OPENCODE_VERSION` 下限 + 「检测到新版 opencode 时提示升级并重启」（docs/updates.mdx "The OpenCode server"节）；`cli-upgrade.js` 只代理 `opencode upgrade`；托管安装 `v2-install.js` 永远装 npm latest（非 pin）。
  - 企业模式：策略文件可 pin OpenCode CLI（v2.1.1 release notes "Enterprise: the policy file can pin the OpenCode CLI to use"）。

## 4. 上游破兼容的历史风险

- **CHANGELOG 无 "Breaking" 标签制度**：全 3855 行 CHANGELOG.md（1.x→2.3.1）零处 "breaking" 字样；破坏性变更混在 Misc/Improvements 里叙述（如 v2.0.0 "system prompt optimization option is removed"）。issue 搜索 "breaking change" 命中多为 renovate 依赖 PR 噪音，无 API 面破坏告示。
- **最大一次断裂 = OpenCode 2 迁移**，commit `654705f7`（PR #3837，2026-09-22）："OpenCode v2 replaced the v1 HTTP API, event stream, message shape and config layout. OpenChamber now talks to v2 only" —— **单 commit 300 文件、+37964/−33201 行**。v2.0.0（09-23）发版即要求 OpenCode ≥2.0.15，v1.x→v2.0.0 相隔仅 5 天（v1.23.2 是 09-14）。
- 之后一个月内兼容下限又动了两次：`461f9145`（session metadata 迁到 2.0.15）→ `eb8e276c`（credential 读取改走 2.0.20 的 `GET /api/credential`，下限升至 2.0.20）。即：**面板对新引擎的功能依赖可以让「最低引擎版本」在两周内涨两次**，尽管对旧引擎的运行时硬拒只有版本门一处。
- 对外部消费方的暴露面：
  - openchamber 的 HTTP API `/api/*` 无 OpenAPI/公开 API 契约文档（repo 内搜 openapi 无果）；对外「稳定面」实际是：① web UI 本身，② `@openchamber/sdk` 扩展契约（manifest `apiVersion: 1` + `engines.openchamber` 语义化声明，iframe bridge），③ connect-url/pairing 链接协议（`remote-host-update.mjs` 注释称 update 路由 "Every OpenChamber server since 1.9" 都兼容——上游有意识地保持这类面稳定）。
  - 2.0.0→2.3.1 五个版本的 release notes 全部是增量和 UI 层修改，**无二次断裂**；但发版节奏 ~5 版/13 天且改动密度高（v2.3.0 changelog 一条 Improvements 段就 100+ 行），意味着回归测试面必须自动化，不能靠人工巡检。

**风险评估**：外部消费方只吃「web UI + HTTP API + sdk 扩展」的稳定面，被 break 的概率**低但非零**——低，因为上游自己就是最大消费方（桌面/CLI/VSCode/mobile 四端共用同一 server），HTTP 面即产品面；非零，因为它没有 API 版本化承诺，v1→v2 那次证明它愿意一次性换掉整个 API/事件流/存储布局。

## 5. 关键判定：ocrc 三件事各自被 break 的概率

前提拓扑：openchamber 跑在 Win/Mac 面板宿主；EL7 是被控机，只跑 opencode v2.0.27（ocrc 通道插件写进被控机 opencode 配置）。

| ocrc 的事 | 依托面 | 被 break 概率 | 说明 |
|---|---|---|---|
| (a) Node24 宿主跑 openchamber | 安装/更新通道（npm + `openchamber update`） | **极低** | 上游自己的 install.sh/update 就是这条通道，且能自迁移包管理器 |
| (b) web UI + HTTP API 消费 | `/api/*` + UI | **低**（唯一实质风险点） | 无契约承诺；靠「升级前跑回归测试」兜底。watch 点：`compatibility.js` 的 MINIMUM bump、`/api/*` 路由文件（`server/lib/opencode/core-routes.js` 等）、SDK `apiVersion` |
| (c) 往被控机 opencode 配置写插件 | **不经过 openchamber**，是 opencode 的 `opencode.json`/plugin 面 | **不受 openchamber 发版影响** | openchamber 对被控配置的触碰仅限 managed plugin（`managed-plugin-config.js` 的 `OPENCODE_CONFIG_CONTENT` 合并），与 ocrc 写的通道插件共存但有重叠风险（同名 plugin 键、`AGENTS.md` vs `CLAUDE.md` 语义已变） |

注意一个真实交互面：openchamber 的 managed OpenCode 会把自己启用的插件物化进被控/本机 opencode 配置（`packages/web/server/lib/opencode/managed-plugin-config.js`、`managed-config-file.js`），ocrc 往同一份配置写东西时存在**写冲突/被合并覆盖**的边角，这是共生拓扑里真正要回归测试的点，而不是 HTTP API。

**与 octg（只跟随 opencode 发版）的风险差**：

1. octg 跟随的 opencode 有半正式的 server API 约定且发版慢；openchamber 发版 ~5 版/13 天、无 breaking 标注、曾单 commit 换血 7 万行——**跟随频率和回归成本高一档**。
2. octg 时代 ocrc 是消费者；现在 ocrc 与 openchamber 在被控机 opencode 配置上**共写同一文件**，出现了一个 octg 没有的「双写者」风险面。
3. openchamber 把「引擎兼容下限」内置成 `MINIMUM_OPENCODE_VERSION` 硬门——面板升级有时**要求**被控端引擎同步升级（见 §3），版本联动比 octg 时代（引擎升级与否不影响面板）更紧。
4. 好的一面：openchamber 的更新通道（npm + GitHub Releases）全部公开、可镜像、可用环境变量改指向，**离线跟随的基础设施比 opencode 官方还齐全**（自带 `--version` 精确安装、`OPENCHAMBER_UPDATE_API_URL`/`OPENCHAMBER_OPENCODE_CLI_VERSION` 覆盖、企业模式 pin）。

## 6. 追加判定（2026-10-14 协调人补充）

### 6.1 被控端视角：EL7 只装 opencode v2 是否成立

**成立，且这正是上游文档的标准拓扑之一。**

- desktop 的「Remote Instances」是把 **openchamber 本体**经 SSH 装到远端（docs/remote-instances.mdx：managed = "OpenChamber installs and starts itself on the remote machine"）——**这条对 EL7 不可用**（远端要跑 openchamber 即要 Node 24）。
- 但 openchamber 的引擎发现顺序（docs/opencode-server.mdx）支持 `OPENCODE_HOST=http://<el7>:4096 OPENCODE_SKIP_START=true` 直连**已在被控机上跑着的 opencode server**，即「external 引擎」模式——EL7 只跑 opencode serve，面板零安装。`compatibility.js` 的 `readExternalOpenCodeVersion` 专门探测外部引擎版本（v1 用 `/global/health`，v2 用 `/api/info`），支持外部 2.x ≥2.0.20。
- docker-compose.yml 注释同样示范了 `OPENCODE_HOST: http://172.17.0.1:4096` + `OPENCODE_SKIP_START: true` 的外接引擎姿势。
- **managed 安装对目标机的要求**：`v2-install.js` 在 Linux 上下载 `https://opencode.ai/v2/install` 脚本执行、装到 `~/.opencode/bin`——它**只装 opencode 二进制，不装 Node**（opencode 是编译好的原生二进制，EL7 已实测可跑）；但它服务于「openchamber 在哪台机、opencode 就装哪台机」的场景，EL7 上没有 openchamber 就不会触发它。结论：EL7 作为「external opencode 引擎」完全成立；作为「managed remote instance（openchamber 被装上去）」不成立。

### 6.2 Docker 兜底「EL7 跑 openchamber-lite」

**没有官方镜像可白嫖。** 要走这条路必须：CI 自建（clone 上游 → `docker build` → 推私有 registry），镜像内 opencode pin（Dockerfile 写死 `@opencode/cli@2.0.27`）要跟随上游手动/自动同步。「只当被控 agent 不出 UI」没有专门开关，只能用 `--api-only`（`openchamber startup enable --api-only` / `connect-url --api-only`，headless 无 UI）+ `OPENCODE_SKIP_START` 外接或不外接引擎，UI 面不强暴露端口即可。判定：**兜底可行但成本高于「EL7 裸跑 opencode + 面板 external 引擎」**，仅当需要把 openchamber 的终端/文件面板能力下沉到被控机时才值得。

### 6.3 面板旧版 vs 引擎新版的兼容矩阵由谁管

**由 openchamber 单方面管，方向是「面板定下限，不设上限」。**

- `compatibility.js`：`isSupportedOpenCodeVersion = v2 && ≥ MINIMUM_OPENCODE_VERSION`——面板对新引擎**永远视为兼容**（"A future major is a contract OpenChamber has not met yet" 是唯一例外：v3 出来会被拒）。
- 桌面版每次发版 bump 内嵌 CLI pin（~每 1-3 天），CLI/Web 模式提示升级外部引擎；`upgrade-capability.js` 规定只有 managed 非内嵌运行时才能代升，external 引擎由用户自己升。
- **没有双向检测**：新引擎 + 旧面板时，openchamber 不做服务端能力探测降级，直接按新 API 说话（它假设自己最新）。因此兼容责任在 ocrc：**面板滞后可以，但别让被控端引擎领先面板的 MINIMUM 之外的语义**（例如引擎新增字段面板不认识通常无害，引擎 breaking 语义变更才有事——而 opencode 2.x 内小版本迄今未见 API 面断裂，断裂集中在 1→2）。

### 6.4 离线推送（形态 B）可行性

**上游 provisioning 全部假设在线**：install.sh（npm registry）、v2-install.js（fetch opencode.ai/install 脚本 + npm tarball）、prepare-opencode-cli.mjs（npm tarball）、electron-updater（GitHub Releases）、`openchamber update`（api.openchamber.dev + npm）——**没有一条离线/推送安装路径**。形态 B 下这些通道全部不可用。

但好消息是**替换点全部可编程**：

- 桌面版（Win/Mac 面板宿主通常在线，形态 B 约束不到它；若也离线，electron-updater 的 private repo + token 模式可指到自建 GitHub 兼容源）。
- 被控端只需要 opencode 二进制（无 Node 依赖），工件 = `@opencode/cli-linux-x64-baseline@x.y.z` 的 npm tgz（内含 `package/bin/opencode`，sha512 integrity 在 registry metadata 里）——ocrc 自持 `~/.ocrc/bin-cache` 多平台 pin 工件模式**可以直接套用**，甚至校验算法都对齐（sha512-base64）。
- openchamber 面板宿主若要自持工件缓存（例如给内网 Mac 用）：`@openchamber/web` 的 npm tgz + `OPENCHAMBER_UPDATE_API_URL` 指向自建即可切断它对 api.openchamber.dev 的外呼。
  **修正（2026-10-17）**：这个开关**指空不等于关闭**——上游是 `process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check'`（`packages/web/server/lib/package-manager.js:26`），空串回落到默认地址。真要切断得指到一个连不通的本地地址（如 `http://127.0.0.1:1/`）；失败路径是安全的：`checkForUpdatesFromApi` 吞异常返回 `null`（同文件 188-190），调用方接着走 npm registry 那条回退。

### 6.5 三条版本线在形态 B 下的联动顺序

```
[Win/Mac 在线]  openchamber 面板        → 官方通道自更（openchamber update / electron-updater）
     │ CI 跟随：监听 GitHub Releases + npm dist-tags
     ▼
[CI 离线 bundle] opencode-cli tgz(EL7) + ocrc 通道插件 tgz + manifest(版本/ integrit/ 依赖下限)
     │ 控制端经既有 SSH 传输会话推送
     ▼
[EL7 离线]  opencode v2 pin 工件解包 → ~/.ocrc/bin-cache → 写 opencode 配置(通道插件)
```

顺序约束：**面板先升、确认 MINIMUM_OPENCODE_VERSION 未越过 EL7 现役 pin、再推被控端**；反向（引擎先升）会撞「新引擎语义 + 旧面板」未测矩阵。octg 时代是单机在线 npm、一条版本线、无 bundle 环节；现在是双机、双线、bundle + SSH 推送 + manifest 校验三段式。

## 7. 跟随发版工作流建议（CI 步骤级）

**跟随对象 = 两条独立版本线**：
- 线 1：Win/Mac 面板宿主的 `@openchamber/web`（或 desktop release tag）；
- 线 2：EL7 被控端的 opencode v2 pin（现 2.0.27）。
两条线**解耦升级、由 manifest 声明联动约束**。

```
① 监听（每日 cron）
   gh api repos/openchamber/openchamber/releases/latest  → 线 1 新版本
   npm view @openchamber/web version + dist-tags         → 交叉确认
   npm view @opencode/cli version                        → 线 2 候选（openchamber 桌面 pin 是官方选用信号：
                                                            读 release.yml/commit "bump OpenCode to x" 作为推荐 pin）

② 兼容预检（不部署）
   - 拉新 openchamber 源码，diff packages/web/server/lib/opencode/compatibility.js 的
     MINIMUM_OPENCODE_VERSION —— 若 > EL7 现役 pin，先排线 2 升级，再升线 1
   - diff server/lib/opencode/ 路由文件树 + @openchamber/sdk 的 apiVersion/engines
   - 检查 managed-plugin-config.js / managed-config-file.js 是否改写 ocrc 插件所在配置键（双写者面）

③ 回归测试（沙箱 Node24 容器）
   - npm i -g @openchamber/web@<new>；OPENCODE_HOST 指向 opencode@<pinned> 沙箱实例
   - 跑 ocrc 消费面冒烟：web UI 加载、(b) 用的每个 HTTP 端点、connect-url 生成、
     ocrc 插件在 managed opencode 下被识别、配置不被 openchamber 改写
   - 通过 → 产出签名 manifest：{openchamberVer, opencodePin, sha512, minEngine}

④ 发布（形态 A / B 分叉）
   A（被控机在线）：面板宿主跑 `openchamber update`（或 npm i -g @精确版）；
                    被控端按 manifest 用 npm 官方源升 opencode pin
   B（被控机离线）：CI 产离线 bundle（@opencode/cli-linux-x64-baseline tgz +
                    插件 tgz + manifest）→ 控制端经 SSH 会话推送 →
                    EL7 解包校验 sha512 → ~/.ocrc/bin-cache/<pin> → 写 opencode 配置 →
                    重启 opencode serve → 面板侧 external 引擎健康探测
   （面板侧离线时：bundle 附 @openchamber/web tgz，OPENCHAMBER_UPDATE_API_URL 指到连不通的本地地址——指空无效，见 6.4 修正）

⑤ 固定锚点
   - openchamber 只升不降；每次升级记录 compatibility.js 快照进 ocrc 仓库
   - 任何一步 MINIMUM 越线或路由 diff 命中消费面 → 人工闸门，不自动推
   - Docker 兜底镜像（若启用）：同一 CI 追加 docker build + 推私有 registry，
     并替换 Dockerfile 内写死的 @opencode/cli@2.0.27 为 manifest pin
```

**结论**：不 fork、CI 跟随升级可行。代价是一次性建好 §7 的双线流水线；持续代价是每个新版的回归冒烟（~5 版/13 天 → 预计每周 2-3 次 ③）。最大残留风险 = 上游无契约的 `/api/*` 面 + 双写配置的合并冲突，均在 ②③ 的 diff + 冒烟覆盖范围内。

---

## 引用来源

**仓库路径**（https://github.com/openchamber/openchamber，main）：
- `scripts/install.sh`；`.github/workflows/release.yml`；`Dockerfile`；`docker-compose.yml`；`scripts/docker-entrypoint.sh`
- `packages/web/bin/cli.js`；`packages/web/bin/lib/commands-update.js`；`packages/web/server/lib/package-manager.js`
- `packages/web/server/lib/opencode/compatibility.js`；同目录 `cli-upgrade.js`、`v2-install.js`、`upgrade-capability.js`、`managed-plugin-config.js`、`DOCUMENTATION.md`
- `packages/electron/package.json`（`opencodeCli.version: 2.0.27`）；`packages/electron/scripts/prepare-opencode-cli.mjs`、`opencode-cli-version.mjs`、`updater-feed.mjs`、`updater-channel.mjs`、`remote-host-update.mjs`、`README.md`
- `packages/ui/src/components/onboarding/ChooserScreen.tsx`、`LocalSetupScreen.tsx`
- `packages/docs/content/docs/install.mdx`、`updates.mdx`、`opencode-server.mdx`、`remote-instances.mdx`、`sdk.mdx`
- `CHANGELOG.md`

**commit/PR**：
- `654705f7` / PR #3837 "feat: move OpenChamber to OpenCode 2.x"（2026-09-22，300 文件 +37964/−33201）
- `461f9145` "move session metadata onto OpenCode 2.0.15"；`eb8e276c` "read provider credentials from OpenCode's API"（MINIMUM → 2.0.20）
- bump 序列 `619c32fa`/`dde86638`/`123a07c6`/`b598295d`/`0f60f54b`/`21939fa9`/`3a100f5a`（OpenCode 2.0.16→2.0.27，2026-09-24→10-12）

**外部 URL**：
- npm registry：`npm view openchamber`（404）、`npm view @openchamber/web --json`、`npm view @openchamber/sdk --json`
- https://github.com/openchamber/openchamber/releases（v1.23.2→v2.3.1 release notes，含 v2.0.0 "Requires OpenCode 2.0.15 or newer"）
- https://hub.docker.com/v2/repositories/openchamber/ （count: 0，无镜像）
- https://opencode.ai/v2/install（官方安装脚本，v2-install.js 与 ChooserScreen 引用）
- https://registry.npmjs.org/@opencode/cli-<target>/-/cli-<target>-<v>.tgz（桌面/托管安装的工件源）
