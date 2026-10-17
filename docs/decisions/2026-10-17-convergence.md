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

### 后续：可复现性修到底（同日，含两次真因定位）

改完闸门和 lock 之后，跑了两轮"同版本各构建两次"，结果是 modern 两次一致、**legacy 两次不同**。
两轮追因都是靠测量而不是猜：

1. **临时探针**（已撤）在 legacy job 里打印未压缩 tar 的 sha256、`pty.node` 的 sha256 与文件数。
   结果：未压缩 tar 两次完全相同（`217aa79b…`），`pty.node` 也完全相同（`0d9f9fe9…`），
   但 tar.gz 的 sha512 不同 → **差异在 gzip 层**。原因是 centos:7 的 tar 1.26 用 `-z` 时把当前时间
   写进 gzip 头；换成显式 `gzip -n` 后消除（modern 侧字节不变，说明 tar 1.35 本来就是零头）。
2. **编译产物本身**：更早一版还差在 `build-pty-legacy-local.sh` 用 `mktemp -d` 做编译目录，
   编译器会把构建路径写进二进制，于是每次构建的 `pty.node` 都不同。加了 `--work <dir>`，
   由打包脚本传固定的 `<work>/pty-build`。

**改 `npm ci` 的连带代价（同一个 commit 修掉）**：`-g` 全局安装的树是**嵌套**的
（`@openchamber/web/node_modules/node-pty`），`npm ci` 是**提升**的（`lib/node_modules/node-pty`）。
Node 两种都能解析（实测在真机上 `require.resolve` 命中提升路径），但冒烟检查和 pty 替换写死了嵌套路径，
于是 legacy/modern 两个 job 都在 Linux 上失败——本地 Windows 跑不出来，因为 win32 会跳过 pty 加载。
三个脚本（`build-app-pack.mjs`、`build-pty-legacy-local.sh`、`remote-node-pty-glibc217.sh`）改成两处都探测。

**真机验证**（EL7 / glibc 2.17，`demo@192.168.26.101`）：把 legacy 包传到目标机 `/tmp` 解包，
用目标机自带的 glibc-217 运行时跑：`cli.js --version` → 2.4.0；`pty.node` 的 GLIBC 上限 2.14、
GLIBCXX/CXXABI 引用 0；`node-pty` 从应用目录内解析到提升路径并 spawn 成功（`PTY_OK | /dev/pts/0`）；
解包 0 警告。**没有动被管实例**（`~/.ocrc/remote` 仍是 2.3.3，`/api/version` 200），探针目录事后清理。

**终态证据**：同一版本连跑两次 CI —— modern `0PBpyTNFD3Nwdupd…` 两次相同，legacy
`YWHHK4OllFJhsilj…` 两次相同。因此"清理旧 release 后再 dispatch 重建"得到的是同一份字节。

**顺带修的红灯**：`CI` 在 coverage 那一步偶发失败（`tests/unit/cli-port-owner.test.ts` 押注"刚释放的
临时端口没被别人抢走"），改成换候选重试；与本次改动无关，属既有 flake。

---

## 追加：工件命名收敛与扩展 URL 安装（2026-10-17）

**问题**：`ocrc-remote` 同时指两样东西——控制端的扩展，和推给对端的 openchamber 应用包
（`ocrc-remote-pack-<ver>-...`）。同一份词汇表里一个词两个所指，迟早有人读错。另外扩展一直没有分发
通道：只能 clone 整个仓库再 folder 安装，文档里写的 Release 附件 `ocrc-extensions-*.tar.gz` 停在
0.4.0（当前扩展是 0.7.0），而且那个 tar 顶层是两个目录，**URL 安装根本装不上**。

**先查清平台认什么**（读对端 openchamber 2.3.3 的真实代码，不是猜文档）：
`server/lib/guests/install.js` 的 `installGuestFromUrl` 只认两条路——`isHttpsZipUrl`（URL 路径以
`.zip` 结尾、https、公网主机，可跟最多 5 跳重定向，所以 Release 资产 URL 可用）或
`parseGitInstallUrl`（`git clone --branch <#ref>`）。**它不读 Release 对象**；git 路拿的是仓库树，
所以扩展必须在那个 ref 的仓库根上。自更新（`updates.js` 的 `checkGuestUpdate`）只在来源是 git
（有 `origin.url`）时生效，zip 安装直接返回不可用。解包规则 `unwrapGuestRoot`：只有"恰好一个顶层目录
且里面有 `package.json`"才 unwrap——这就是两合一 tar 装不上的原因。

**命名规则**（写进 AGENTS.md 与 OPS）：

1. 名字从**机器标识**派生（`panel.id`、包名），不从显示名派生。
2. 第二段是**件类**（`pack` / 无——件类已由容器类型承载：`.zip` = 扩展，`.tar.gz` = 解包推送的载荷）。
3. **版本放哪一侧看"怎么被寻址"**：平铺目录寻址的必须带版本（应用包，因为 `OCRC_PACK_DIR` 是平铺
   镜像目录，tag 不是唯一版本轴）；tag 寻址的靠 tag（扩展，只有一个入口 URL，文件名恒定）。
4. 不可变性由 tag 保证，不由文件名保证。

**落地**：应用包改名 `ocrc-openchamber-pack-*`（代码 `appPackName`/`appPackManifestUrl`、构建脚本、
工作流、测试）；扩展出 `ocrc-remote.zip` / `ocrc-omo-view.zip`，tag `ocrc-<ext>-<ver>` 钉、
`ocrc-<ext>-latest` 通道，发布走新工作流 `ocrc-ext.yml`（**仅手动 dispatch**；钉 tag 只写一次、
通道 tag 按设计覆盖；发布前断言安装形状，坏包到不了 Release；zip 用固定 mtime + 排序条目可复现）。

**兼容处理**：2.3.3 包按新名**原样重挂**——tar 字节不变（sha512 与旧 tag 下完全相同，只重写了资产名与
manifest 里的 `asset` 字段）。旧 tag `ocrc-remote-pack-2.3.3` 保留：2026-10-17 之前构建的扩展内嵌的是
旧包名，删了它们会静默降级成控制端跨装。修剪任务只匹配新前缀，所以旧 tag 不会被自动清掉。

**证据**

- 控制端取件：用构建后的 `ensureAppPack` 对新 tag 取两档，均 `OK`（legacy 57.3MB `6NVDwbTEDq+zzdh5…`、
  modern 57.2MB `Et/F+TA2kiEhCe89…`，与旧 tag 下逐字节相同）。
- 工作流闸门：dispatch 2.3.3 → `detect` 认出新 tag 的 7 件资产齐全，pack/publish 全跳过；
  dispatch 2.4.0（publish=false）→ 两档真构建通过。
- 扩展发布：`ocrc-ext` 跑通，zip 内容 `ocrc-remote/{package.json,panel,status,service}`（mtime 全为
  1980-01-01、单一顶层目录、manifest 在根）。
- **真安装器验收**：用对端 2.3.3 的 `installGuestFromUrl` 对通道 URL 与钉版本 URL 各跑一次，均
  `ok=true`、识别 `ocrc-remote 0.7.0`、拷贝 `package.json panel service status`、能力请求
  `sessions`+`service` 待审批；omo-view 同理（只有 panel，请求 `conversation`）。全程写临时 store，
  没碰任何真实扩展目录。

**遗留**：zip 安装无自更新，升级靠覆盖安装（面板的"覆盖/重装"按钮行为未实测；若无该入口则先卸载再装）。
扩展版本升级前必须提 `extensions/<name>/package.json` 的 `version`，否则钉 tag 被跳过、通道也不会动。

---

## 追加：允许明文 SSH 密码（2026-10-17，用户裁决）

**决定**：接受在桌面壳里明文存 SSH 密码（原生 UI 的 `auth.sshPassword`，`store: "settings"`，
落在 `~/.config/openchamber/settings.json`）。原先"只走 key"的规则解除——它当初的约束是
Windows 没有 sshpass 且不想让密钥落盘；现在实测原生壳用 `SSH_ASKPASS` + `OPENCHAMBER_SSH_ASKPASS_VALUE`
（`SSH_ASKPASS_REQUIRE=force`）实现，不需要 sshpass，Windows 可用，且**免掉了人工把公钥放进
`authorized_keys` 这一步**（原先被我列为上生产的阻塞项之一）。

**边界（有意收窄，不跟着一起放宽）**

- 我们自己的路径 `plan/apply/up/probe` **仍只走 key**：推送与探测不需要交互式密码，也不引入 askpass helper。
- 对端 openchamber 的 **UI 密码**（`auth.openchamberPassword`）**保持 `store: "never"`**。它是另一个密钥，
  与 SSH 无关；混为一谈会把两个都放宽。`--desktop-add` 依旧不写它。
- `--desktop-add` 依旧**不写** SSH 密码（值从命令行传会进 shell 历史与 `ps`）。

**同时修掉一个真 bug**：`mergeDesktopEntry` 原先按 id **整体替换**条目，而 `desktopEntryFor` 造的形状里
没有 `auth.sshPassword`——所以在"允许明文密码"之后，跑一次 `--desktop-add` 会**静默删掉**用户刚存的密码，
让那条实例连不上。改为按 id 合并：保留 `auth`（含 `sshPassword`）与 `sshParsed` 等我们不管的字段，
我们只管 `remoteOpenchamber.mode/preferredPort`、`sshCommand`、`portForwards`。新增两个单测
（保留密码；没有就不凭空造）。`tests/unit/desktop-settings.test.ts` 11 项。

**顺带对齐的形状差异**：原生 UI 写 `sshCommand: "demo@192.168.26.101"` + `sshParsed` 缓存，
我们写 `"ssh demo@192.168.26.101"`。读壳的 `parseSshCommand` 确认两种都收（`tokens[0] === "ssh"` 时 shift），
所以不必改；`sshParsed` 现在会被保留。另记：壳的连接参数用 `StrictHostKeyChecking=accept-new`，
首连不需要人工确认 host key。

**红线复述**（本次实测撞上）：原生 **managed** 模式会在对端跑 `bun add -g` / `npm install -g --prefix
$HOME/.openchamber/npm-global @openchamber/web@<ver>`，前提是对端有 bun/npm 且有公网 registry。
2026-10-17 在对端刻意断网实测：DNS 三次 `ENOTFOUND` → 重试约 106s → **回落到五个月前的 HTTP 缓存**
（`~/.npm/_cacache`，May 13）→ `ETARGET No matching version found for @openchamber/web@2.4.0`。
报错文本误导（像是"版本不存在"，实际是"够不着 registry 用了过期缓存"）。managed 与我们的实例
**同机不得混用**；OPS 已把 Mode 必须选 `external` 写成硬性步骤。
