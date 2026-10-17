# 远程实例路线裁决（2026-10-16）

> 问题：**怎么让 openchamber 直接具备"对端能力"**——① Add project 的目录浏览器列出的是
> **被控机**的目录；② 中栏主页面的会话**直接跑在对端引擎上**。
> 本文是 Phase 0 的取证结论（主路可行性），以及主路/退路的判据。

## 一、机制裁决

**主路 = 服务端跑在被控端**（openchamber 的"远程实例"形态），控制端只做"装 + 连 + 转发"。

依据（代码级）：openchamber 的**目录校验与文件/git 面都在服务进程里**——
`server/lib/opencode/project-directory-runtime.js:40` 的 `validateDirectoryPath` 是
`fsPromises.stat` + `realpath`，`server/lib/fs/routes.js` 直接 `fsPromises.readdir/stat`，
`server/lib/git/routes.js` spawn 本地 `git`。把服务端放到对端，这些面**一次到位都是真的对端**，
零补丁；在控制端改它们，等于把它的每个本地面重造一遍（退路 B，见末节）。

**与上游一致性**：openchamber 文档 `remote-instances.mdx` 把 `managed`/`external` 两种模式写死为
"**remote instances are a desktop-only feature**"；opencode 官方客户端的 SSH 流（公开源码
`anomalyco/opencode` `packages/gui-extensions/src/ssh/*`）也是同一形状：远端装服务 →
`ssh -L 127.0.0.1:<port>:<host>:<port>` + `ExitOnForwardFailure=yes` → 健康探测 `/api/info` →
把 `{url,password}` 交给界面，界面里的目录选择器就是打**那台 server** 的 `/api/fs/list`。

## 二、Phase 0 取证结论（全部实测/源码取证）

| 项 | 结论 | 依据 |
|---|---|---|
| **glibc 2.17 上的运行时** | **可行**：Node unofficial 构建 `linux-x64-glibc-217`，24.x 线**从 v24.18.1 起**才有，最新 **v24.22.0**（满足 `engines.node >= 24.14.0`）；24.14.0 没有 glibc-217 构建 | `unofficial-builds.nodejs.org/download/release/v24.22.0/` 目录清单 |
| 备选运行时 | Bun 1.4.3 只要 glibc ≥ 2.17（`bun-linux-x64-baseline.zip` 可取）；Bun 路径另有 `bun-pty` 的 `librust_pty.so`，可绕开 node-pty | bun.sh 文档 + GitHub release 资产 |
| 被控机现状 | RHEL 7.9 / glibc 2.17；node 20.20.2 **本来就是 unofficial glibc-217 构建**（`NVM_NODEJS_ORG_MIRROR` 指向 unofficial-builds）；curl/wget/tar/xz 齐全；/home 余 61 GB；尚无 `~/.openchamber` | ssh 只读实测 |
| **真阻塞（不致命）** | `node-pty@1.2.0-beta.15` 的 `prebuilds/linux-x64/pty.node` 需要 `GLIBCXX_3.4.21/22`，该机 libstdc++ 最高 `GLIBCXX_3.4.19` → **终端**在首次使用时加载失败。**不挡服务启动**（懒加载：`server/lib/terminal/runtime.js:208 await import('node-pty')`） | `readelf`/`strings` + 本机 `libstdc++.so.6.0.19` |
| 阻塞的解法 | ① 随包带较新的 `libstdc++.so.6`（LD_LIBRARY_PATH）② 用本机 devtoolset-12（已装，g++ 12.1.1，但**没有共享库**，只能静态重编）重建 node-pty ③ 走 Bun 路径（`bun-pty`） | devtoolset 目录实测 |
| **离线可跑** | 启动期**零外联**：更新检查在 `/api/openchamber/update-check` 路由里按需调用、失败返回 `{available:false,error}`；models.dev 按需且失败即日志；relay 默认 `enabled:false`，`OPENCHAMBER_RELAY_HOST=off` 显式关被动托管；无 telemetry | 安装包源码 grep + 路由定位 |
| 无单文件产物 | 服务端只能以 npm 包形态跑（`bin/cli.js serve` → `server/index.js`）；仓库里没有 SEA/pkg/bun-compile 目标 | 源码检索 |
| `external` 模式要求 | **要一个钉死的远端端口**（`preferredPort`，否则报 `External mode requires a preferred remote OpenChamber port`）+ 可选 UI 密码（远端 curl 探测 `POST /auth/session`、`GET /api/system/info`、`/health`）；**不要求与桌面版版本相等**——只有 major<2 或缺能力 `api.runtime-url.v1` 判 `incompatible`，`update-recommended` 仍可连。它**照常建转发**并把 `http://127.0.0.1:<localPort>` 交给界面 | `packages/electron/ssh-manager.mjs`（v2.3.3） |
| 引擎门禁 | openchamber 要求 opencode v2 且 ≥ `2.0.20`（`server/lib/opencode/compatibility.js`）；被控机在跑 v2.0.27 ✓。**实施要求（R12）**：二进制显式 pin 绝对路径、启动前断言 `major=2 && ≥2.0.20`、面板显示版本与来源路径；目标机只有 v1 时先走"部署引擎"，**绝不回落 v1**（控制端本机的 1.18.31 已被拒一次，见 §三注） | 源码 |
| **前提纠正** | 被控机**当前能出网**（实测 registry.npmjs.org 与 github.com 均 200）。离线路线照做，首次打通可直接装；Phase 1 补"离线推包"并**断网复验** | 实测 |

## 三、v1 实现形态（在批准计划范围内的一处简化）

计划原文写"控制端用 openchamber 桌面版连 external"；取证后简化为：**不依赖它的桌面壳**。
它的桌面壳对远程实例只做三件事——建转发、健康探测、开窗；而 **转发与探测我们自己就会**
（`core/remote-host.ts` 已有 `ssh -N -L`），"开窗"在浏览器里就是打开一个标签。
于是 v1 的控制端 = **我们自己的装机 + 转发 + 状态**，界面 = 对端实例自己的 UI（与你要的那套同版本同外观）。
将来若需要它的主机切换器/多窗口，再补桌面版，不阻塞 v1。

安装落点（我们的命名空间，绝不碰对端既有目录）：

```
~/.ocrc/remote/runtime/node-v24.22.0/          # 随包推的运行时
~/.ocrc/remote/openchamber/2.3.3/              # npm --prefix 装的应用
```

启动：`<runtime>/bin/node <prefix>/bin/openchamber serve --hostname 127.0.0.1 --port <p>`
（带 `OPENCODE_BINARY` 指向对端引擎；`OPENCHAMBER_UI_PASSWORD` 可选）。
停止：`<prefix>/bin/openchamber stop --port <p>`。

## 四、退路 B（仅当主路技术不可行时启用）

控制端跑 openchamber + 我们给它打"引擎优先"补丁：`project-directory-runtime`（目录校验）、
`lib/fs/routes.js`、`lib/git/routes.js`、终端面——每处从"本地 fs"改成"引擎是远端时走引擎 API"。
代价：补丁会从几十行长成一片，且每次上游发版都要合并；因此只在主路验证失败时启用。

## 五、不做（v1）

不 fork openchamber、不改它的源码；不做 WSL/Docker（结构留位）；不做云端 relay（v1 只保 LAN）；
不做手机端新增连接/装机（手机只需打开控制端的转发 URL）。
