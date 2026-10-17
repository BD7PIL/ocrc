# 2026-10-17 — OCRC 收敛：一个 openchamber 扩展 + 一套 CI 兼容包

## 决定

1. **产品面 = 一个 openchamber 扩展**：`ocrc-remote`（显示名 `OCRC Remote`），它的 **service 进程**内
   直接跑探测/取件/装机/起实例/出网中继。不再有常驻的 `ocrc host :4099`；`ocrc` CLI 保留为同一套
   库的 headless 入口。核心库边界在 `src/remote-instance/index.ts`。
2. **实例级是唯一形态**：openchamber 跑在**被控端**，控制端只建转发并打开它。引擎级（面板在控制端、
   隧道连对端引擎）不是产品路径。
3. **控制端只有 Win/Mac 桌面版**，不是 web/PWA。装好实例后，入口是桌面版原生 **Remote Instances**；
   `ocrc remote connect <id> --desktop-add` 可替用户写这条记录。
4. **传输分工**：桌面壳持有 UI 的 `-L`（本地端口由它自选）；扩展 service 持有 `-R` 出网中继与本地
   中继监听，并在 external 模式下每 20s 自检远端、实例掉了自动重拉。
5. **CI 兼容包两档**：`.github/workflows/ocrc-pack.yml` 按 openchamber 版本产出
   `modern` 与 `legacy-glibc217`（后者含按 glibc 2.17 重建的 node-pty）。控制端取件推送，
   对端**不装 devtoolset、不联网**；没有包时回退控制端跨装。
6. **不做页面内嵌**：扩展不能 iframe 对端 UI（guest CSP + 对端 `frame-ancestors` 双重阻断）。
7. **`web-next/`（ZCode 壳）从 main 删除**，快照在 tag `web-next-final`。
8. **品牌写作 OCRC**；CLI 命令仍是 `ocrc`、npm 包仍是 `@bd7pil/ocrc`（技术标识保持小写）。

## 为什么

- **R11 的字面要求**是"Add project 里看到对端、中栏直接与对端引擎交互"。上游源码证据：openchamber 的
  目录校验/文件/git 面全在**服务进程内**解析（`project-directory-runtime` 的 `fs.stat`、`lib/fs/routes.js`），
  所以"看见对端"等价于"实例跑在对端"。把服务端放到对端，这些面一次到位，零补丁。
- **核心游离在 openchamber 之外**：扩展 service 本来就是 openchamber 架构里的宿主机进程
  （manifest `service.runtime: "host"`、`permissions.exec: ["ssh"]`），能承担全部重活；另起一个
  4099 只是多一跳、多一处漂移。
- **老旧系统**：RHEL7/glibc 2.17 是遗留生产下限。官方 prebuild（node-pty 要 GLIBC_2.28）在那边
  加载不了；把重建放进 CI 的 centos:7 容器后，对端不需要 devtoolset。
- **内嵌不可行**：guest 文档 CSP 是 `frame-src 'self' data: blob:`（`origins` 能力从不放宽 frame-src），
  对端 `frame-ancestors 'self' openchamber-ui://app …` 与 guest 的 opaque origin 不匹配；sandbox 也没有
  `allow-popups`，`window.open` 同样被拦。

## 代价

- **`panel.id` 改名**（`ocrc-connect` → `ocrc-remote`）：已装扩展必须卸载重装；`ocrc-connect-profiles.json`
  文件名保持不变以免丢档案。
- **service 懒启动**：出网中继要等扩展 service 起来（第一次打开「OCRC Remote」面板/触发 service 请求）。
- **CI 容器步骤未在 GitHub Actions 跑过**（本地无 Docker）；首次运行前靠"无包回退跨装"。
- **web-next 删除**：ZCode 壳的 CDP 门禁脚本随之退役；取回用 tag。

## 现状与证据

| 项 | 证据 |
|---|---|
| 扩展 service 直接管理实例 | 扩展 326/326；`ocrc-remote` 由桌面壳拉起，远端 `-R` 在听、状态 `online（实测）` |
| 实例级链路 | `scripts/accept-remote-instance.sh --target demo@192.168.26.101` → ACCEPTANCE OK（含终端 create=running、fs 90、sessions 50） |
| 兼容包 | `tests/unit/remote-app-pack.test.ts`（8）；modern 53MB / legacy 54MB 本机构建；RHEL7 `apply` 推送后 pty GLIBC 2.14；Ubuntu 26.04/glibc 2.43 全新主机走 modern 档 `ACCEPTANCE OK` |
| 桌面入口 | `tests/unit/desktop-settings.test.ts`（9）；`--desktop-add` 实测写入且无明文密码 |
| 内嵌否决 | [../research/embedding-experiment.md](../research/embedding-experiment.md) |
| 后端门禁 | `npm run typecheck` 干净；`npx vitest run` 1162 passed / 1 skipped |

## 与批准计划的偏差（有意，均已在 OPS/本页写明）

- **传输**：计划写"主隧道与 `-R` 都归桌面壳"，落地改为**桌面壳 `-L`、service `-R`**。原因：service 是
  常驻控制端进程，本地中继监听（4711）在它进程里；桌面壳的本地端口是自选的、且两条 `-R` 会撞同一
  远端端口。service 会**复用**已存在的 `-R`，两种拓扑不会互杀。
- **文档归档**：`docs/research/` 与 `docs/handoff/` 没有搬进 `docs/archive/`。两者已按目录分区、
  交叉引用密集；搬 28 个文件只会制造断链，不减小实际体积。新增 `docs/decisions/` 作为往前写的日志。
- **听写**：决定走远端 STT，但**没有自动改**实例的 dictation 配置（那是用户偏好，在 openchamber 设置里
  选 `openai-compatible`）；EL7 的本地 sherpa 仍不可用（GLIBC 2.32），不重建。
- **CI legacy 容器**：`ocrc-pack.yml` 的 centos:7 步骤未实际运行（本地无 Docker）；控制端
  "无包回退跨装"路径仍然可用，不阻塞。
