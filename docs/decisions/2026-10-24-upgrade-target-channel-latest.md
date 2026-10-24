# 裁决：升级目标 = 渠道最新已发布的 pack（2026-10-24）

## 背景

「检查并更新」按钮自 0.8.2 面板收缩以来只是只读预演（`op:plan`），真正改 pin 的
`op:upgrade` 从未接线；且升级目标硬编码在扩展构建期常量 `DEFAULT_APP_VERSION`（当时
'2.3.3'）——pack 渠道里 2.4.0/2.5.0 已发布，按钮永远升不动。宿主 app 升到 2.5.1 后，
面板读数与升级能力双双「烂在常量里」。

## 裁决（用户拍板，三选一里的「渠道最新」）

**升级目标 = 我们自己的供给渠道里最新已发布的 pack**：

- 「已发布」= GitHub release `ocrc-openchamber-pack-<semver>` 七项核心资产齐全
  （`ocrc-pack.yml` detect 门禁的同款判据）；不完整的 release 不是可安装版本。
- `ocrc remote upgrade <id> [--to <ver>]`；面板「检查更新」发现 pin ≠ 渠道最新时给
  「可升级 X」徽章 + 主按钮 + 写盘确认（PRODUCT 零点四的一次显式确认不变）。
- 新增服务器的缺省 pin 在面板路径也取渠道最新（add 表单默认）；CLI 脚本路径保持
  `DEFAULT_APP_VERSION` 兜底（脚本要确定性，不做网络发现）。
- `DEFAULT_APP_VERSION` 降位为**离线/发现失败时的兜底**，不再决定升级能到哪一版。

## 备选与落选理由

- **仅升级取最新、新增仍用常量**：常量继续腐烂，新增的机器第一天就落后。
- **纯手动指定（--to/表单）**：用户得自己知道渠道里有什么——把供给面的知识转嫁给
  使用者，且「检查并更新」按钮语义仍然是空的。

## 诚实闸（任何一道不过都不写远程机器）

1. 渠道查不到（网络/限流/空）→ 原样报错，不猜版本；
2. 目标版本没包 → 「X 的包还没发布」；
3. 已是目标版 → no-op（不许「重装同一版」制造噪音）。

## 附带语义

- 升级前在线的实例，升级后自动 down+up 装载新版（「在线但跑旧版」是谎言）。
- 远端旧版本目录不删（`~/.ocrc/remote/openchamber/<old>` 留着，回滚 = 把 pin 改回去）。
- 实测到的运行版本写回 `store.observed`，与 pin 并排显示（`实测 2.5.1（pin 2.3.3）`）。
- 镜像/企业代理：`OCRC_PACK_API_BASE`（API）与 `OCRC_PACK_BASE`（下载）分别可覆盖。

## 裁决之二（同日稍后，用户拍板）：引擎同样跟随渠道

「openchamber 你能探测更新，opencode 自然也应该探测更新，**不可能每次升级我们都手动改
pin**」——app 走渠道发现之后，引擎（opencode）也走渠道发现。openchamber 2.5.1 的
`MINIMUM_OPENCODE_VERSION='2.1.0'` 把我们钉的 2.0.32 判 incompatible，暴露了这条：手改
pin 不可持续。

- **渠道源**：npm registry 的 `@opencode/cli-<target>` dist-tags.latest（与 bin-cache 取件
  同一个包）；`OCRC_NPM_REGISTRY` 可换镜像。失败诚实返回 error，不猜版本。
- **决策**：`decideEngineTarget` = max(已装/生效 pin, 渠道最新)，**只升不降**——渠道出问题
  保持现状，永不自动降级。
- **编排骨架**：`planUpgradeRun` 把 app 决策与引擎跟随合并。关键约束：**app no-op 不许短路
  引擎跟随**（真机踩过：app 已 2.5.1、引擎 2.0.32 被门禁拦下，upgrade 却先答"已经是这一版"）。
  app 已最新但引擎落后 → engine-only（apply force:false 对同版本 app 是"已在位"，只补引擎）。
- **终审**：装上后由实例自己的 `/api/opencode/compatibility`（up 的 R12 门禁）把关这版引擎
  配这版 app 行不行——**我们不复制上游版本表**。
- **pin 链降为兜底（三层）**：**渠道发现（upgrade 时）> manifest/OCRC_V2_PIN > 常量**。
  兜底值（`DEFAULT_ENGINE_PIN` 与 `ops/v2-pin-manifest.json`，现为 2.1.4）今后由 follow CI
  的 bump-pin job 自动更新，**人不再手改**。
- **apply 纪律**：普通 apply 延续 store 里已装的引擎 pin（`applyOpts.engineVersion ??
  instance.engineVersion`），不许悄悄换版本；引擎前进只发生在 upgrade 的渠道跟随里。
- **附带修复（compat 竞态）**：up 的 compat 探测带 ~10s 退避重试（`withCompatRetry`）——
  同版本组合两台机器一门禁过一个门禁不过的根因是实例刚起、引擎子进程握手未稳时接口给暂态
  答案；明确 `incompatible` 与版本/路径类确定性失败仍当场终判。
- 真机实证（2026-10-24，EL7 legacy 档 + Ubuntu modern 档）：升级前两台 state=incompatible
  快速终判；`ocrc remote upgrade` app no-op + 引擎 2.0.32→2.1.4（bin-cache 首次从 npm 拉包）+
  自动重启后两台 compat=compatible 在线（openchamber 2.5.1 / OpenCode 2.1.4）。
