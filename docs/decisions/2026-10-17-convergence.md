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
| CI（2026-10-17 实际跑通） | `CI` 两条腿（Node 20/22）绿；`ocrc-follow` 绿（51s，含引擎 pin 冒烟）；`ocrc-pack` 绿（resolve → modern 27s → legacy 1m2s → publish 15s），Release [`ocrc-remote-pack-2.3.3`](https://github.com/BD7PIL/ocrc/releases/tag/ocrc-remote-pack-2.3.3) 六件资产齐；控制端从 Release 取件两档 sha512 校验通过 |
| 后端门禁 | `npm run typecheck` 干净；`npx vitest run` 1162 passed / 1 skipped |

## 与批准计划的偏差（有意，均已在 OPS/本页写明）

- **传输**：计划写"主隧道与 `-R` 都归桌面壳"，落地为**桌面壳持有 `-L` 与 `-R`**（`--desktop-add` 把
  `-R` 写进它的 `portForwards`，并由 CLI 起控制端中继监听），扩展 service 发现既有 `-R` 时**复用**；
  两条 `-R` 不会互杀。service 只负责"对端实例还在不在"（20s 自检 + 自动重拉）。
- **文档归档**：`docs/research/` 与 `docs/handoff/` 没有搬进 `docs/archive/`。两者已按目录分区、
  交叉引用密集（28 个文件互为相对链接）；搬动只会制造断链，不减小实际体积。沿用已有的
  `docs/decisions/`（里面本来就有 2026-06-12 那条）作为往前写的日志，补了索引与写法。
- **听写**：不自动改实例配置。实测 **Ubuntu/glibc 2.43 上本地 sherpa 正常加载**（本地听写可用）；
  EL7/glibc 2.17 不可用（GLIBC 2.32），要在实例设置里选 `openai-compatible`（远端 STT）。

---

## 追加：pack 发布闸门（2026-10-17，octg 式）

**问题**：`ocrc-pack.yml` 的 `publish` 条件写的是 `github.event_name == 'schedule' || inputs.publish`，
定时触发恒真；发布段又无条件 `gh release upload ... --clobber`。而 `resolve` 取的是上游 latest，
不是我们钉的版本。两个后果：① 上游一发新版，第二天凌晨就自动对外发一份没人验收过的包；
② 上游 latest 停在我们正用的版本（2.3.3）时，每天凌晨重建并覆盖同一个 tag 的资产。

**为什么这是错的**：参照 `BD7PIL/octg-legacy-glibc` 的 `build.yml`——它同样是"定时发现上游 + 自动发布"，
但 tag 是上游两个版本的组合，`detect` 阶段先 `gh release view`，命中就 `skip=true` **门掉整条链**
（构建、打包、发布全部挂 `if: skip != 'true'`）。于是每小时 cron 里有 23 次只跑几秒，发布幂等、只发生一次。
我把这个形抄了过来，却把闸门装在了错位置（只管"建不建 release 对象"，不管"要不要重建资产"），
又用裸 `npm install` 让"同 tag"不再等于"同字节"。

**改法**

1. **门提到链首**：`ocrc-remote-pack-<ver>` 已带齐 7 件核心资产 → `skip=true`，两个 pack job 与 publish
   全部跳过；Release 存在但缺资产 → 放行并补建，那是唯一会 `--clobber` 的路径。
2. **冻结依赖图**：`npm install --package-lock-only` + `npm ci`；`.lock.json` 随包发布，tier manifest 记
   `lockSha512Hex`。
3. **确定性打包**：排序后的文件表 + `--mtime=@0 --owner=0 --group=0 --numeric-owner`
   （centos:7 的 tar 1.26 没有 `--sort`，所以显式排序文件表）。
4. **三层保留策略**：中间 artifact 3 天；本工作流的 run 留最近 30；pack Release 超 90 天清理，
   但**永不清理 `DEFAULT_APP_VERSION` 钉住的版本**（清掉也能 dispatch 重建，且字节一致）。

**证据**

- 同版本不同字节（修改前）：已发布 2.3.3 modern 包的 sha512 前缀 `Et/F+TA2kiEhCe89…`，今天同一版本重建得到
  `CxKonm2uU7HNzBO9…`（本机是 Windows 构建，平台差异也计入其中；关键是依赖图当时完全没固定）。
- 修改后可复现：本机连续两次全量重建，modern 包 sha512 完全一致（`HgO/5gP1eH3yqdrj…`）。
- 清理逻辑 dry-run：pinned 版本保留、非 pack tag 跳过、超 90 天的 pack release 命中（dry-run 未真删）。

**遗留**：2026-10-17 之前发布的包（含当前钉住的 2.3.3）没有 `.lock.json`，不可复现；门刻意不要求 lock
资产，正是为了避免把已验收的 2.3.3 判成"不完整"而被重建覆盖。
