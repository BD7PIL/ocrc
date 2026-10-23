# Changelog

## 2.0.0-alpha.14 — 组件 pin / 开源发布清理（2026-10-23）

- `ops/components.json`：reeve `0.1.15`、opencode-deep-memory `0.16.5`（均由各自 CI 带 provenance 发布）。
- `LICENSE` 改为 canonical MIT（Telegram 归属移到 `NOTICE`，与“该层已删除、不再分发”的表述一致）；
  `NOTICE` 进入 npm tarball，publish 断言存在。
- README 更新版本/徽章/组件 pin/安装说明，链接 CHANGELOG/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT；
  修 bug 模板的 opencode v1/Telegram 残留；新增 issue-template config。
- CI/publish：`contents: write`、concurrency/timeout、npm ci、网络步骤重试、GitHub Release notes、
  extension/pack release 不再抢 Latest。
- 扩展 `0.9.4`：service 产物重建（symlink dereference + GATE 配置目录同步），zip 内附 LICENSE + sha256，与 src 一致。
- 无运行时行为变化。
## 2.0.0-alpha.13 — 组件 pin 跟到已发布版本（2026-10-20）

- `ops/components.json`：reeve `0.1.3`、opencode-deep-memory `0.16.4`（两个包都已由各自 CI 带 provenance 发布）。`--with-components` 的默认取件版本随之更新。
- 无代码变化；alpha.12 的 bootstrap / 配置去重 / OSS 内容不变。

## 2.0.0-alpha.12 — 一条命令接管（bootstrap）+ 组件插件去重（2026-10-20）

- **`ocrc remote bootstrap`**：把 `记录 → plan → apply → sync-auth → sync-config → up → pairlink` 串成一条。核心在 `src/core/remote-instance-bootstrap.ts`，CLI 只负责参数、一次确认和汇总。
  - 记录合并只覆盖**显式传入**的字段：二次运行保留 `uiPassword`、`enginePath`、端口与既有 `sshPassword`（不再经过会重置缺省字段的 `add`）。
  - 失败语义：`plan`/`apply`/`up` 致命（停止，退出 1）；`sync-auth`/`sync-config`/`pairlink` 告警（继续，退出 0）。`--dry-run` 只登记 + 预演；非 TTY 没有 `--yes` 退出 2。
  - 不碰对端已 adopt 的引擎；组件按目录条目登记。
- **配置并集修复**：`planConfigSync` 新增 `componentNames`，合并前从本地 `plugins` 剔除 `@bd7pil/<name>` / `@bd7pil/<name>@<ver>` / `/.ocrc/components/<name>/` 条目——对端装的是目录，包名条目在 air-gap 机器上注定加载失败。`syncConfig`/`configDiff` 会把组件清单的 manifest name 传下去。
- 测试：205 项（+14 bootstrap 序列，+1 组件插件去重）。

## 2.0.0-alpha.11 — 环境变量透传（2026-10-20）

- **`OCRC_INSTANCE_ENV=NAME[,NAME]`**：把控制端进程环境里的这些变量透传进对端实例的 serve 行。对端配置里的 `{env:NAME}` 因此能解析，而密钥仍然只存在于控制端的进程环境（或系统用户环境），不写进任何配置文件。`buildInstanceServeCommand` 新增 `extraEnv`；显式的 serve 变量（`OPENCODE_BINARY` 等）优先于同名透传。
- 实测：控制端 `TAVILY_API_KEY` + `OCRC_INSTANCE_ENV=TAVILY_API_KEY` → 对端引擎 `/api/mcp` 返回 `tavily: connected`。
- 单元测试 +1（透传与同名冲突）。

## 2.0.0-alpha.10 — 通用组件装配（reeve / deep-memory），Bifrost 交还 reeve（2026-10-20）

- **组件契约**：新增 `provision.json` 读取与执行（`src/core/components.ts`）。`remote apply --component <dir|tgz|spec>` / `--with-components` 读组件清单，推 tarball、解包到 `~/.ocrc/components/<name>/package`、按 sha256 落工件、登记 v2 `plugins`（目录条目，air-gap 可用）、装 openchamber 扩展（失败不阻断）、逐项验证。`ops/components.json` 钉版本；`OCRC_<NAME>_PIN` 覆盖。
- **配置并集**：`planConfigSync` 不再丢弃 `plugins`；它是 peer + local + 组件条目的并集（真实 v2.0.32 引擎实测：两份文档各贡献一个插件，都加载）。v1 `plugin` 键原样保留（openchamber 所有）。
- **Bifrost 交还 reeve**：撤销未提交的 `src/core/bifrost.ts` 与 bridge 注入；ocrc 只按清单预置二进制（reeve 的 `ensureBinary` 对校验通过的文件短路，实测 `~/.reeve/proxy/bifrost-http` sha256 命中后不再下载）。
- **引擎 pin 2.0.27 → 2.0.32**：deep-memory 的 v2 适配器以 2.0.32 为准（其 README 明确 2.0.27 结论已被取代）。
- **发布卫生**：`declaration: true`（`exports.types` 不再指向不存在的文件）；build 先清 `dist`；publish 校验 tag↔版本、已发布版本、tarball 入口，prerelease 发 `next`；`ocrc-follow` 去掉已删的 `build:dwf` 与旧插件冒烟；`SECURITY.md` 改成 ocrc 自己的边界；公开树清掉内网地址/个人路径/`.omo` 运行态。
- **测试**：190 项（+10 组件/配置并集），preflight 全绿。T1（Windows 隔离栈）与 T2（EL7 真机）证据见 `docs/research/` 与 `docs/PROGRESS.md`。

## Unreleased — 清理到只剩一条路（2026-10-19）

- **扩展 0.9.2：上一代三块的服务端也删了。** `extensions/ocrc/src/service/` 只剩 `main.ts`（`/health` + `/remote-instance` 两条路由）与 `remote-instance-ops.ts`：`tunnel`/`tunnels`/`remote-fs`/`config-bridge`/`config-project`/`provision`/`runtime`/`capabilities`/`auth-sync`/`detect`/`artifact`/`install`/`omo-config`/`omo-schema`/`ocrc-host` + 它们的测试 + `shared/protocol.ts` + `shared/provision.ts` 全部删除（服务从 773 行降到 ~100 行，扩展测试 295 → 39 项）。manifest 不再申请 `sessions` 能力（少一次审批）。
- **配对链接不再有「在 app 里打开」**：宿主对 `open-url` 只放行 http(s)，`openchamber://` 深链必然被拒（实测报 `URL must be http or https.`）。改成「复制链接」（带 toast + 宿主自带的 Copy）并说清去 app 的**服务器列表 →「导入链接」**粘贴。
- **仓库级清理**：删 `web/.svelte-kit/**`（81 个被误提交的构建缓存）、`desktop/` + 其单测（基座换位后前提消失的壳 scaffold，PRODUCT 第三条已标注作废）、`deploy/com.ocrc.host.plist`（无文档引用的 launchd 模板，内含 fork 期个人路径与域名）、`scripts/cdp/guest-ui.mjs`（由 `preview/audit.mjs` 取代）、`accept-provision.sh` / `accept-workspace.sh` / `spike-multi-forward.sh` / `vendor-omo-schema.mjs`。
- **README 重写**：从"Telegram/Web PWA 产品介绍"改成当前形态（面板扩展 + 被控端实例 + 配对），补两种安装 URL、`npm run preflight`、评审流水线；去掉已不存在的 `cd web && npm test` 与 `scripts/spike-restart.sh`。
- 文档：AGENTS/PRODUCT/OPS 标注批次 2–5.1 的功能面已删；四份过时 handoff/计划加了 banner；decision 记录同步。

## Unreleased — 名字收敛到 `ocrc`（2026-10-18）

- 扩展改名 `ocrc-remote` → **`ocrc`**（目录 `extensions/ocrc`、`panel.id`、显示名、资产 `ocrc.zip`、tag `ocrc-<ver>` / `ocrc-latest`、镜像分支 `ocrc`；发布工作流改名 `ocrc-extension.yml`）。**旧安装（id `ocrc-remote`）要卸载重装**；裁决与代价见 `docs/decisions/2026-10-18-rename-to-ocrc.md`。
- 删掉改名留下的空目录 `extensions/ocrc-connect/`；档案文件 `ocrc-connect-profiles.json` → `ocrc-profiles.json`（env `OCRC_PROFILES`）。
- 扩展 0.9.0：面板收缩成一个功能（服务器列表），卡片固定三行、主动作随状态推进；状态区改每台一行只读读数；用户可见文案换成上游 zh-CN 词。
- 扩展可以自更新了：发布时把扩展子树推到 `ocrc` 分支，用 `https://github.com/BD7PIL/ocrc#ocrc` 装即走上游的更新链路（zip 装法仍无自更新）。

## Unreleased — OCRC 收敛（2026-10-17）

- 扩展 `ocrc-connect` 改名为 **`ocrc-remote`**（`panel.id` 同步；旧安装需卸载重装）。品牌写作 OCRC；CLI 命令与 npm 包名保持小写。
- 远程实例核心折进扩展 service：不再需要 `:4099` 常驻，长操作改为 job + 轮询；UI 隧道归桌面壳，service 持有反向出网腿。
- 内嵌试验结论：扩展不能 iframe 对端（guest CSP `frame-src` + 对端 `frame-ancestors`），入口回退桌面版原生 Remote Instances。
- EL7 终端：node-pty 按 glibc 2.17 重建（`scripts/remote-node-pty-glibc217.sh`），面板终端可用。

## 2.0.0-alpha.7 — 批次 6：全项目痛点清理 + 测试完善 + Windows 移交（2026-10-16）

目标终态：全部开发测试在 EL7 闭环，产出 `docs/handoff/batch6-windows-testing.md`
移交包（PowerShell 前置检查 + 9 步验收 + 回传诊断），2.0 拓扑首次交 Windows 真机。

### Fixed — 本轮揪出的 6 个真实 bug

1. **install.ts managed 对象键 TypeError**：`migrateLegacyConfig` 假设 V1
   `plugin` 键必为数组；openchamber managed 物化写的是**对象**——在 managed
   宿主上跑 install 直接崩。回归测试锁进 plugin-key.test.ts（E1-4 承诺）。
2. **renderer deleteMessage 同步 throw**：无 deleteMessage 的 bot（测试 fake、
   精简客户端）让 `clearThinkingPlaceholder` 的 `.catch` 形同虚设（同步 throw
   照样 reject），finalize 整体跌进兜底路径 → 长回答被截成 3800 字符。
   integration 测试此前从未被执行，一接进来就暴露。
3. **omo 配置远端写入路径冻结**（批次 5.1 全链真机从未写对过）：`$HOME` 被
   单引号包进远端脚本 → 远端 shell 不展开 → 写进字面 `~/$HOME/.config/opencode/`
   目录。单测全 mock 了 sshExec 所以从未暴露——accept 脚本真机跑出来的。
4. **tunnel.stop() 不清 activeProfile**：断开后 fs/git/omo/config 面仍拿着旧
   profile 工作，不再 409。
5. **ocrc-follow.yml fail-open**：上游 compatibility.js 解析失败（crossed=unknown）
   时 bundle 照样产出。改 fail-closed（仅 crossed=false 产 bundle）。
6. **config-bridge 面板宿主路径**：Windows 无 XDG，`~/.config` fallback 让
   配置同步 tab 在真实 Windows 面板上空白。加 `%APPDATA%\opencode`（win32）分支。

### Added

- **accept-workspace.sh 全端点覆盖**：10 → 25 步，覆盖全部 21 个端点 + 401/409/
  422/400/`..` 守卫（原只测 11 个端点）。**service/main.ts 7 个单测**（鉴权/路由
  分发/CRUD/错误映射/profiles 重启持久化）。
- **tests/ 树类型检查**：`typecheck:tests`（tsconfig.tests.json）+ 90 处既有
  类型错清零，进 CI 门禁。
- **coverage 基线**：`@vitest/coverage-v8`，src/ 口径 statements 72.6%，CI 出报告。
- **v2 pin 声明式 manifest**：`ops/v2-pin-manifest.json`（manifest > env > 动态
  跟随的第一层真正落位）；install 时物化到 `<OCRC_HOME>/bin-cache/manifest.json`；
  CI bump-pin 同步重写 manifest + repo variable；bundle 附带 pin-manifest.json。
- **CI 冒烟增强**（兑现 e1/e2/release-following 三份裁决的承诺）：E1-4 双写
  不变量断言、注册面 smoke（四远程工具在 dist 可见）、消费面冒烟（插件 tarball
  解包 + dist 加载面）。
- **测试补全**：i18n en/zh 键一致性 + 占位符插槽一致（656 键双向零差异）；6 个
  无测试路由（settings-project/offpeak/share/policy/catalog/version）19 用例；
  新增 managed 共存 / E1-4 回归用例。453→**1071** 后端测试全绿。
- **Windows 移交包**：`docs/handoff/batch6-windows-testing.md`——全仓第一份
  PowerShell 诊断材料（ssh -V / ssh-agent 启用 / 手动隧道 / 日志路径）；批次 5
  「配置同步」与 5.1「omo 编排」两个 tab 的验收（此前无 handoff 增补）。
- **CI 扩展 tar.gz artifact**（兑现 batch2 handoff §2 方式 B）：免 clone 的
  Windows 安装包；扩展 dist 一致性校验（`git diff --exit-code`）进 CI。

### Changed

- ocrc-remote **0.5.0**：win32 配置路径、keyPath 档案输入、工作区根目录
  Windows 盘符路径显式报错（原静默忽略）。
- 删 `scripts/spike-restart.sh`（4598 遗留，误跑抢 TG token 顶死 4199——OPS.md
  曾两次警告）；`v2-restart.sh` 加沙盒自拒护栏。
- 仓库根 ~48 个调试垃圾文件清理；`/tmp/e1-lab` token 核查（无命中）；OPS.md/
  PRODUCT.md 对齐 2.0 现实（V2 插件已交付、离线 bundle、spike 脚本删除）。
- package.json 卫生：typescript → devDependencies；@types/diff 7→8 对齐 diff@9。
- extension dist 三份并存的不一致碎屑（3 个误跟踪的 dist 文件）随 dist 校验
  步骤澄清。

### 不做（本轮明确）

npm publish（冻结待裁决）；扩展独立仓库与自更新（需建仓）；web-next 解冻；
被控端 Windows 原生化；@opencode-ai/sdk 升 2.x；签名 bundle 与 SSH 自动推送。

## 2.0.0-alpha.6 — 批次 5.1：omo-slim 配置的 UI 控制（2026-10-15）

> 批次 5 收尾时的用户追问「能不能在 UI 中控制 omo slim 的配置」——openchamber
> 原生不能，本批次用既有 ssh 面补上。调研 + E4 spike 实证归档：
> `docs/research/omo-config-surface.md`。

### feat(extensions/ocrc-remote 0.4.0): /omo/config 端点 + 「omo 编排」区块
- **E4 spike（e2-lab 隔离栈）**：omo-slim 3.0.4 离线接入被控端——installer
  `--no-tui` 生成 `.json` 基准配置（2 250 B）+ V1 `plugin` 键注册（v2.0.27 接受，
  与 ocrc 的 V2 `plugins` 分键而治再证）；agents 面 6 omo 代理就位，prompt 走
  stub LLM 由 orchestrator 接管。**热重载铁证**：外部改文件 → `[plugin] runtime
  profiles refreshed from disk`（两次）；坏 JSON → `refresh failed`，
  last-known-good 保留；agents 注册面不热变（只热生效推理字段，对新编排子会话
  生效）。
- `GET /omo/config?scope=user`：远端路径**服务端拼装**（仅
  `$HOME/.config/opencode/oh-my-opencode-slim.json[c]`，不接受任意路径），
  base64 读回 `{exists, format, activePreset, presetNames, fallback, agentChains,
  parsed, schema, commentsWillBeLost}`。
- `POST /omo/config`：原始 JSON 逃生门与结构化编辑（preset/fallback）二选一；
  服务端校验（坏 JSON/负数重试/未知 fallback 字段/不存在预设名 → 422/409
  **不落盘**），mktemp + `*.ocrc-bak` + mv 原子写；`.jsonc` 保留扩展名写入并
  如实标记注释丢失。
- **vendor schema**：`oh-my-opencode-slim.schema.json`（3.0.4 包根，MIT，~68KB）
  内嵌为 TS 模块（`scripts/vendor-omo-schema.mjs` 可重生成），air-gap 零网络。
- 面板「配置同步」tab 顶部新增「omo 编排」：活跃预设下拉（预设名集合来自当前
  parsed，不硬编码）+ fallback 四控件（官方默认 placeholder、空值=不动）+
  per-agent 模型链只读树 + 「编辑原始 JSON」逃生门。

### 测试与验收
- ocrc-remote 23 新单测（jsonc 剥注释、双格式探测、fallback 白名单校验、
  原子写脚本、结构化编辑保键），47/47 全绿。
- E4 栈集成闭环：GET 读回基准配置（schema 内嵌）；POST 结构化编辑
  （preset→opencode-go + fallback 五字段）→ 写入 + `.ocrc-bak` →
  **引擎热重载日志实证**；坏 JSON/负数字段 422 路径实测拒绝。

## 2.0.0-alpha.5 — 批次 5：配置与凭据桥（2026-10-15）

> 调研（`docs/research/llm-config-fallback-survey.md`）实锤的唯一产品缺口：
> openchamber 面板写的 agents/MCP/providers 配置落在**面板宿主磁盘**，external
> 引擎收不到（key 例外——走引擎 credential API 已通）。本批次把这条通道补齐。

### feat(extensions/ocrc-remote 0.3.0): 配置桥
- **E3 实测**：`OPENCODE_CONFIG` 附加层与全局配置合并（bridge 层 `agent` 段可覆盖
  内置 agent）——桥选型定为**分键合并写回被控端主 opencode.json**（不依赖 env、
  adopt 场景同样生效）。
- `POST /config/source|preview|apply`：读面板宿主 openchamber 配置产物（user 层
  opencode.json 的 agent/mcp.servers/providers 段 + 平铺 `agents/*.md`，路径解析
  与上游 shared.js 逐条对齐）→ 深合并预览（面板段逐叶覆盖、被控端独有键全保留、
  ocrc 自有键不碰）→ 原子应用（mktemp+mv，`*.ocrc-bak` 兜底，明确"需引擎重启"
  提示，不自动重启）。密钥不在桥接范围。
- 面板第三 tab「配置同步」：源清单 → 预览 → 应用。

### feat(plugin): 凭据通道增强
- **第五工具 `ocrc_remote_sync_auth`**：既有 syncAuth（auth.json → 被控端 0600）
  工具化——五工具同注册面（V1 hooks.tool / ATTACHED 代理 / V2 transform，
  namespace ocrc 契约）。
- **`remotes.json` per-host `env` 字段**：`buildExtraEnvExports` 注入远端 serve
  进程（排序稳定、单引号转义、非法变量名丢弃）——env-only provider（AWS_*/AZURE_*
  类）的 KEY 通道；API 响应脱敏为 `envKeys`（值不出 remotes.json）。

### feat(core): 白名单修订（syncConfig）
- 新增 `agents`、`skills`（复数目录——openchamber Agents UI 与 v2 的首选形状）
  与 `oh-my-opencode-slim.json`（omo per-agent 模型链 + `fallback.*`，被控端
  编排与面板宿主同配置）。`plugin/` 仍刻意缺席。

### 调研归档
- `docs/research/llm-config-fallback-survey.md`：六问带来源答案（引擎无跨
  provider fallback 仅同模型重试；openchamber 是分类路由非故障转移；omo-slim
  有完整链但 v2 宿主为 steering 语义；KEY 五路通道；skills.urls 是唯一官方
  skills 远端原语）。

### 测试与验收
- 主包 1037+ 新增：第五工具 handler×4、env 导出×3、白名单×2（全绿）。
- 扩展 24+8：config-bridge 路径解析/段清单/合并策略/apply 脚本（全绿）。
- 活体验收（隔离目录、显式路径）：preview 正确保留远端独有 provider/MCP、
  apply 后面板段合入 + reviewer.md 推送 + `.ocrc-bak` 落盘。
- 事故记录：E3 期间 loopback ssh 的远端 `$HOME` 是真实家目录，syncConfig 实验
  误写真实 `~/.config/opencode/`——已全量恢复原状（现役配置 opencode.jsonc 未
  受影响），教训入记忆（ssh 写入实验必须显式 HOME/路径）。

## 2.0.0-alpha.4 — 批次 4：远程工作区面板桥（A 路线）（2026-10-15）

> 上游 openchamber 的 Files/Git 面板硬绑面板宿主磁盘（#3113 拒绝代理远端）——
> 「远程工作区」以 **ocrc-remote 扩展自己的端点 + UI** 补齐，不碰上游路由。

### feat(extensions/ocrc-remote 0.2.0)

- **A1 service fs/git-over-ssh**：`/fs/list|read|write|stat|mkdir` +
  `/git/status|diff|log|stage|commit` + `/git-branch` 徽标端点——service 在面板
  宿主直接 `ssh <profile> <script>`，keyed 输出（无刮取）、base64 文件往返、
  原子写（mktemp→`*.bak` 备份→mv）、diff 截断 200KB。manifest 声明
  `permissions.exec: ["ssh"]`。被控端**零新增守护**（ssh exec 即远端）。
- **路径白名单**：档案新增 `allowedRoots`（远端绝对路径数组）；空 = 全部 403；
  路径必须绝对且段前缀落在根内，`..` 段在 ssh 之前拒绝。
- **A2 面板 UI**：扩展内「连接 / 远程工作区」双 tab——文件树（逐目录懒加载，
  >512KB 拒开）、编辑器（保存走原子写 + `.bak`）、git 面板
  （status/diff/暂存全部/提交）；工作区根存 host.storage（service 每请求复核，
  面板滞后也扩不了权）；statusSection 徽标升级为 隧道+引擎+当前分支。

### A3 验收与交付
- `scripts/accept-workspace.sh`：EL7 loopback SSH 活体全链
  （browse→read→atomic write(.bak)→diff→stage→commit→clean + 403/400 守卫），
  10/10 绿。期间实修一处 EL7 git 兼容 bug（`git add -- -A` 把 -A 当 pathspec）。
- handoff 增补批次 4 验收段（Win/Mac 只验 UI 呈现，端点已活体验证）。

## 2.0.0-alpha.3 — 批次 3：远程通道 agent 工具化（四工具全套）（2026-10-15）

> 用户原话痛点：「跨设备共享工作目录共享工作空间——OCRC 的远程通道能不能让 agent
> 直接使用？」本版把远程通道从「面板/IM 专属」升级为**引擎 agent 的一等工具面**，
> 通道无关：Telegram、web 面板、任何 transport 里的会话都能直接用。

### feat(plugin): ocrc_remote_* 四工具（E2 裁决路径）

E2 spike（`docs/research/e2-verdict.md`，2.0.27 隔离栈实测）：v2 promise 插件的
`context.tool.transform(add/update/remove)` 是**引擎真实的运行时工具注册面**——
`@opencode-ai/plugin` 2.0.18 的类型没写它，但引擎传了。关键契约：自定义工具必须带
`options:{namespace:'ocrc'}` 才能到达模型面（否则进 registry 但被 agent 工具集过滤）；
`execute` 返回 `{output}` 且 `output` 声明 `{output:{type:'string'}}`。

- `remote_list`：remotes.json 的 enabled 主机 + 状态机状态 + 版本/平台。
- `remote_sync_workspace`：参数化 tar 管道（`manager.syncDirectory`：本地根/条目/
  远端目标三元组），`*.ocrc-bak` 备份语义与 syncConfig 同族；条目 `..` 越界与
  非 `~,/,$HOME` 目标直接拒绝（远端 target 单引号转义防注入）。
- `remote_provision`：provision/漂移检测/pin 推升级（bin-cache 路径复用）。
- `remote_create_session`：经 registry 在 `remote:<id>` 的远端目录开会话
  （web create-session 同机制）；工具描述声明防递归契约。

### 三种装配（一套 handler 层 `src/plugin/remote-tools.ts`）
- **V1 PRIMARY**：hooks.tool 并入（与 rc-status/notify 同面）。
- **V1 ATTACHED**：同 handler，全部薄代理到宿主 token API
  （新增 `POST /api/remotes/:id/sync-workspace` 路由）。
- **V2 setup**：`ctx.tool.transform` 批量注册（PRIMARY 在 startCore 后晚绑定；
  ATTACHED 在 standdown 前挂上——V2 宿主 attach 不再退化为摆烂）。

### 集成实测（e2-lab 隔离栈，零生产流量）
真 v2.0.27 引擎加载 ocrc PRIMARY 插件：四工具全部出现在 LLM 工具面；
stub LLM 发起 `ocrc_remote_list` 调用 → 引擎执行 → `status:completed` +
「No enabled ocrc remotes」正确落地。加载工程注意：本地路径插件 = **目录**
（引擎找 `<dir>/index.js`，package.json main 不参与——工程以 index.js 重导出
dist 入口解决，vendor/ 必须随包分发）。

### 测试
- 新增 `tests/unit/plugin-remote-tools.test.ts`（18 项：参数化 sync、四 handler
  mock manager、V2 注册契约、ATTACHED 代理、v1 面完整性）。
- `tests/unit/remote-host.test.ts` 增补 syncDirectory 守卫 3 项
  （越界拒绝/相对目标拒绝/未知 remote）。
- 全量 1037 项后端测试 + typecheck 绿。

## 2.0.0-alpha.2 — 批次 2：两个 openchamber iframe 扩展（2026-10-14）

> 面板侧能力以 openchamber 扩展形态回归；本机开发与测试完成，
> Win/Mac 侧动作清单见 `docs/handoff/batch2-panel-testing.md`（唯一 handoff）。

### extensions/ocrc-remote 0.1.0 — 连接/隧道扩展
- panel：SSH 档案管理（存 host.storage）+ 隧道/引擎双状态卡 + 连接断开；
  statusSection「ocrc 隧道」健康徽标。
- service（面板宿主本机进程，openchamber 代拉）：spawn `ssh -N -L
  127.0.0.1:4096:…` + 指数退避重连；`/health`（15s 契约）+ Bearer token 门 +
  `/status|/connect|/disconnect|/profiles`；档案镜像落盘，单档案自动重连。
- 引擎接入零环境变量：隧道落地 openchamber 自动探测端口 4096。
- 7 项单测 + 本机活体验证（真实 SSH 隧道转发 /global/health 200、disconnect 断链）。

### extensions/ocrc-omo-view 0.1.0 — omo 编排视图扩展
- 只读编排树：E1 实证的 v2 `parentId` 会话树 → orchestrator/专家分支；
  节点带 agent 名/活动态/结果，点击跳转会话；dangling parent 降级为根不丢节点。
- capabilities 最小面（sessions）；5 项单测（树构建/降级/计数/展平）。
- 两包 panel 产物均 classic-IIFE（openchamber 沙箱无 ESM），构建产物提交进仓库。

### ci
- ci.yml 追加两扩展的 install/typecheck/test/build 步骤。

## 2.0.0-alpha.1 — 转型批次 1：openchamber 基座 + opencode v2 被控端（2026-10-14）

> 口径：产品基座换位裁决落地（`docs/research/openchamber-base-swap-verdict.md`）——
> 面板让位给 openchamber（Win/Mac，不 fork），ocrc 收缩为**引擎侧 agent + 通道 +
> provisioning + CI 跟随**。E1 四项实验全绿（`docs/research/e1-verdict.md`）。

### feat(cli): 插件键代际契约（E1-4 分键而治）
- `install`：V1 `plugin` 数组存在（1.18.x 宿主）才写 `plugin`，否则写 V2
  `plugins` 数组——绝不双写（v2 引擎两键都解析，双键=双实例化）。
  V1 键让渡给 openchamber managed 物化（实测其对象形态会整体覆盖数组）。
- `uninstall`：同时清理两键的 ocrc 项；**不触碰** openchamber 持有的对象形态
  `plugin` 键。7 项契约单测（`tests/unit/cli/plugin-key.test.ts`）。

### feat(core): bin-cache —— V2 工件自持缓存与离线推送（PRODUCT 第零点六条 v2 化）
- 新 `core/bin-cache.ts`：registry metadata `dist.integrity`（sha512-base64）→
  下载 `@opencode/cli-<target>@<pin>` tgz → 校验 → 缓存
  `~/.ocrc/bin-cache/<pin>/` → 解包取二进制。E1 实验已端到端走通。
- `remote-host.provision` 新增 **V2 pin 推送路径**：缓存 → scp → 远端
  `--version` 验证，失败回落本机二进制 scp（1.x 动态跟随路径原样保留）。
- **pin 机制双轨**：`manifest.json`（声明式，CI 产出）> `OCRC_V2_PIN` env >
  本机动态跟随（legacy）。漂移检测：远端版本 ≠ pin 时 provision 返回
  `drift: remote x != pin y`，供面板「推送升级」动作消费。
- 9 项单测（`tests/unit/bincache.test.ts`）。

### ci: ocrc-follow 双线跟随流水线
- 新 `.github/workflows/ocrc-follow.yml`：每日 cron 监听 openchamber 最新版 →
  diff 上游 `compatibility.js` 的 `MINIMUM_OPENCODE_VERSION` → **未越线**才产
  离线 bundle（opencode tgz×2 平台 + ocrc 插件 tgz + manifest）；**越线**自动
  开 bump-pin PR 并 gate bundle。冒烟挂 GitHub runner（EL7 开发机不跑 Node 24）。
- 顺序铁律落地：面板先升 → CI 确认 MINIMUM 未越线 → bundle → SSH 推送被控端。

### 实验记录（E1，docs/research/e1-verdict.md）
- opencode 2.0.27 在 EL7/glibc 2.17 原生可跑；omo-slim 3.0.4 同框加载成功
  （ast-grep 原生件需 GLIBC_2.29 → 懒加载降级，编排主链不受影响）。
- V2 编排语义原生暴露：`parentID` 会话树 + `subagent` 工具 part
  （`state.metadata.sessionID`）+ `/api/event` 单流——批次 2 的 omo 视图
  扩展可全语义化，无需解析 omo 私有格式。
- ocrc V2 插件在 2.0.27 全指标健康（dual-export/PRIMARY/web transport/
  TG polling/卡片流）。

### 不变/退役边界
- 1.18.x 兼容零回退：V1 键写入路径、动态跟随、旧 provision 全保留。
- web-next 冻结不删（CI 剔除其步骤另行提交）；npm 发布维持冻结。
- 批次 2（本版不含）：openchamber 连接扩展、omo 编排视图扩展。

## 1.0.0-rc.7 — 远控会话（P-remote：对齐 ZCode v3.15.1 配对语义，无中继，桌面锚不受控）(2026-10-10)

> 口径：官方 v3.15.1 加了手机扫码连接的半个远控弹层；ocrc 把这半补齐成
> **LAN 直连的远控会话**——无中继（隧道用户自理），两层凭据生命周期完全解耦。
> 用户裁决记录在 PRODUCT 第零点八条。

### feat(connectivity): 会话模型（锚/会话两层）
- `connectivity/pairing.ts` 重写：单用 60 秒 pending → **远控会话 store**——
  `start()`（幂等，二次开启不踢已连手机）/`refresh()`（**新 epoch**：旧 pending
  与已发会话凭证全废——官方「刷新二维码」语义）/`stop()`/`status()`。会话存续
  期 pending **多台手机可扫**，exchange 每台发独立会话凭证（随机 32B base64url、
  内存态、主机重启即清），**永久锚 token 不再过 exchange**（每 epoch 设备上限 64）。
- `auth/token.ts`：`createTokenAuth` 加可选 `sessions`（结构化类型防循环依赖）——
  middleware 与 WS 升级接受「锚 token **或** 存活会话凭证」；`rotate()` 语义不变
  （锚轮换）。`isLoopbackAddr` 导出给会话管理端点复用。
- 组合根（`cli/host.ts` + `plugin/entry.ts`）：同一 store 接进 web 路由**和**
  auth 策略；`selectAuthStrategy` 透传。`AuthStrategy.sessionsAccepted` 能力位
  = CF Access 模式会话端点 409 的判据。

### feat(transport/web): 会话路由
- **loopback 限定** `POST /api/pair/session/start|refresh|stop`（非 loopback 403，
  fail-closed：拿不到 socket peer 也 403）；`/status` 任何已认证设备可读
  （面板「已连接 N 台」与远端置灰兜底）。免认证路由顺序不变（exchange/onboarding
  仍在 auth 门之前）。
- onboarding：会话开 → 出码（`status:'on'`），关 → `{status:'off'}`（关门不
  出码）；`paired` = **本会话已连接设备数**（原 paired-count 文件退役）。
- `GET /api/pair/qr` 会话关时 409（不再静默发锚 token 链接）；无 store 的遗留
  回退（`#token=` 静态链接）保留。`POST /api/pair/reset` 轮换锚 token 并顺带
  停会话（手机随锚轮换一起失效）。

### feat(cli): 锚链接与会话 CLI
- **`ocrc start`**：web 就绪后打印**锚链接**两条（localhost + LAN，`#token=`
  fragment，LAN 变体在显式 loopback bind 时不打）+ 手机/重置提示。
- **`ocrc pair`**：无参 = 经 loopback 端点 start/refresh 会话（再跑一次 = 刷新
  = 踢人）并打印 onboarding 二维码；`--stop` 停会话；`--reset` 保持锚轮换语义
  （WEB_TOKEN 配置拒绝不变），并打印新锚卡。非本机/CF Access 分别 403/409 文案。
- TG `/pair`：进会话语义（发 `#pair=` 链接 + 会话凭证说明）；订阅快捷按钮
  （锚 token 消费方）不动。Bot 通道生命周期全程零改动。

### feat(web-next): 远程控制弹层双栏化（vendor 零字节改动）
- `src/zcode/remoteControl/WebRemoteControlDialog.tsx`（ocrc 层新组件）经
  **alias 覆盖**（vite + tsconfig 把 `@/WebRemoteControlDialog.js` 指过来）
  替换对话框内容——不进 PATCHES.md（登记制只管 vendor 文件字节改动）：
  左栏**扫码连接**会话卡（状态 · 已连接 N 台 / 刷新二维码（官方同款确认弹窗）/
  复制链接 / 停止；403/409 时按钮置灰并显示服务端原因）；右栏 Bot Channel
  原样。入口触发器与 `webRemoteControlAvailable` 能力位不动；vendor 快照
  升级（3.14.3→3.15.1）单独立项。

### tests + docs
- 测试重写/新增：pairing-store 12（会话生命周期/多兑/epoch 踢人/stop/重启即
  stop/URL 双 scheme 不撞）；pairing-route 13（生命周期链路/onboarding off 态/
  loopback 403（含 IPv4-mapped、会话凭证也不能改）/CF 409/reset 联动/exchange
  形状不变/无 store 回退）；token-auth +4（会话凭证收/踢/未接线拒/?token= 仍
  WS-only）；CLI start 打链单测随 service。旧「单用 60 秒」断言按计划退役。
  后端 **965/965**、web-next **173/173** 全绿。
- 文档：OPS 配对段重写（两层凭据表 + 命令表）、PRODUCT 第零点八条（对齐
  v3.15.1、无中继、LAN 信任边界）、ARCHITECTURE Web surface 配对段 +
  `~/.ocrc/` 表（token = 锚；会话凭证纯内存）。

## 1.0.0-rc.6 — workflow 面板面（P4 + P4b：/z/ 里看得见 + amend 的导入缓存）(2026-10-10)

> 口径：**ZCode 有而我们没有的 workflow 体验面归零**。P4 把引擎/工具面（P0–P3）接进面板：
> 时间线 run 卡、状态面板 Workflows 分区、run/workspace/artifact 侧页、saved workflows 面板、
> 侧栏轨道、冷快照不丢 run、4 条命令可用。四道门禁实测：P4-1 **22/22**、P4-2 **31/31**、
> P4-3 **20/20**、P4b **14/14**（记录：`docs/workflow-p4-record.md`）。

### feat(web-next): 动态工作流的总闸（P4-0）
- 新增 `codingPlanSubscriptionService`：vendor 的 workflow 入口**全部**挂在
  `getDynamicWorkflowClientConfig()` 上且取数失败 fail-closed，而我们的 accessor 原先没有这个
  服务（落到 ghost Proxy → 方法 reject → 快照恒 `enabled:false` → 卡片/按钮/侧页/Saved
  Workflows 全隐藏）。ocrc 没有账号体系、workflow 是本地引擎能力，如实回 `alwaysOn/override`。

### feat(core): run 投影与相位表（P4-1a）
- `projection.ts`：journal → vendor 的 `WorkflowRunState`（`usage.nodesUsed`、`nodes[].phase`、
  `phases/phaseNames/currentPhase`、`reports[]`、`pendingQuestions[]`、`artifacts[]`、
  `resumable`、`resultPreview`），每张表按 vendor 线上界裁剪并置 `truncated`（超界会让整帧
  解析失败，不是丢一个键）。
- `phases.ts`：`phaseNames/phaseAlongside` 从分析器的因果图读出，由宿主在 `run-started` 之后
  补写 `run-launched`——上游只在「run 行还不存在」时转录这条事件，而 ocrc 刻意先建行再启动
  （实测：声明阶段表与 per-run 子模型从来没进过 journal）。
- `escalations.ts`：问题登记表搬出路由，引擎的 `escalation-raised` 与 actor 侧 `escalate`
  合成同一份 `pendingQuestions`；journal 新增 `run-join` 行（run→工具卡的 join 键输入）。

### feat(web-next): /z/ 里的 run 面（P4-1b/P4-1c）
- 快照加 `workflowRuns`；键级增量用 vendor 自己的 `diffWorkflowRunsState`（容器 revision 归
  消费侧；无变化不抬 revision，否则 vendor 的 diff 会退回整键重发）；ws `workflow` 帧只是提示，
  面板回读投影（单一时钟）；capability bit `workflowRunDeltas: true`；sessions-index 的
  `workflowActivity`（vendor 的派生函数此前全仓无调用者）；`backgroundWorks` 的
  `kind:'workflow'`（workId ≡ runId）。
- 4 条命令接真：`cancelBackgroundWork` / `resumeWorkflowRun` / `amendWorkflowRunSettings`
  （就地改并发上限；活体换模型如实拒 `model_unavailable`）/ `startSavedWorkflow`。拒绝一律回
  vendor 自己的 fault 前缀 + reason 词（UI 拿 reasonCode 反查文案）。
- **修一个真 bug**：首次快照时卡片 join 键永远解不出来（行缓存是快照构建**之后**才写入的），
  时间线上一张卡都没有。

### feat(core): 七条读面与侧页（P4-2）
- `queries.ts` + `display.ts`：`workflowRunEvents` / `workflowRuns` / `workflowRunArtifacts` /
  `workflowRunArtifactData` / `workflowRunArtifactRead` / `workflowRunWorkspace` /
  `workflowRunNodeResult` 七条只读查询，形状逐字照 vendor、授权按 vendor 契约（sessionId 必须
  是 parentSessionId，不符与「无此 run」同一个 404）。`display.ts` 用同一份 vendored 分析器产出
  工具卡的因果图——run 侧页画的就是它（此前写着「没有这张工作流程图」）。

### feat(core): saved workflows 面板（P4-3）
- saved store 加 `scope`（默认 project，与面板默认档一致）与 `whenToUse`，新增
  `setMeta/getByName/listScoped/filePath`；路由按 vendor 形状回（`{workflows, invalid, dir}`、
  meta、scope 两档）并加 name-keyed 一族与运行历史（按 run 自己的名字从 journal 查，带产物 chips）。
  `moveSavedWorkflow` 如实拒绝（501 + 原因）。
- **修一个真 bug**：vendor 的列表视图用**不带 name** 的 `listSavedWorkflowRuns` 拉该作用域全部
  历史；拼成 `/by-name/undefined/runs` 后回的是失败信封而非 `{runs: []}`，面板拿 `undefined`
  去遍历，整段设置页被错误边界接走（「e is not iterable」）。

### feat(core): amend 的导入缓存（P4b）
- 硬前置：driver 从不写 `NodeRecord.messageBoundary`，而 vendored 的缓存构建对缺边界的条目
  **整体拒绝**。现在 driver 在 ask 交换结束时补写（typed 在 `respondToSubmit` 的 accept、
  untyped 在 `notifyTurnEnd`，都写在引擎结算之后）。
- `imported-cache.ts` 从前驱 journal 构建 `ImportedRunCache`（具名 actor 的最长全 completed
  ask 前缀 + 按 inputHash 排队的世界读）。amend 先 preflight 再 supersede（缓存缺席不阻塞修订）；
  resume 在有 `resumedFrom` 时从直接前驱重建。
- **三处如实降级**（写进代码注释与文档）：只做结果级复用（分歧 actor 空会话开场）、不带
  in-flight 条目、resume 只回看一代前驱。

### fix(workflow): 收口两处「没做到」+ 一个自己留下的假数字（rc.6 补，2026-10-10 晚）
- **directory 侧页**（第一轮记成「打不开」的第五张侧页）：门禁补上真实路径——先把状态面板
  从 `auto` 展开成 `panel`，再开 Workflows 分区，点目录入口，断言侧页里列出这个 run。
  **原记录的理由是错的**：面板正文的可见性是 CSS 容器查询（`auto` → `min-width:1280px`
  才 `flex`），而门禁的展开分支写在 `data-state === 'collapsed'` 上、那个值只在字面 `mini`
  出现，于是分支从未执行——能点开的路径一直存在，是门禁不会点。P4-2 门禁 **37/37**。
- **修一个真 bug（门禁抓出来的）**：`/api/workflow/runs/summaries` 的每行缺 `toolCallId`
  锚点，而 vendored 的目录模型会把无锚点的行**整行丢掉**——目录页读的只有这一面，所以行不
  存在；状态面板的 Workflows 分区又挂在同一个计数上，于是入口和面板本身都不渲染。
  ocrc 的 run 记录放不下这个 id（引擎在工具调用返回**之后**才铸），改为宿主按
  `(messageId, toolName)` 在父会话的工具卡片里解析；解析不到就不给锚点，绝不猜。
- **`messageBoundary` 不再有假数字**：它原先读 `getHistory(sessionId)`，页面默认 50——超过
  50 条之后**恒为 50**。现在读 1000 条的窗口（读满时记 warn），并新增宿主记账行
  `ask-boundary`（count + 边界消息 id），导入缓存从该行取数（旧 run 回落到节点字段）。
- **边界的时机也修了**：vendored 契约把它定义在「完整交换（含 repair/nudge 与 submit 之后的
  收尾消息）结束之后」，而 typed ask 在值被接受那刻就结算。现在 accept 写临时值、turn end
  写权威值；权威值所属的 turn end 常常在 run 结算**之后**才到，而引擎在 `run-settled` 后立刻
  `dispose()`（会清空在飞表）——边界义务因此存在一张不随 dispose 清空的队列里，由 manager 的
  `settledDrivers` 接住，且按**每会话 FIFO** 归属（到达的 turn end 属于最老的在飞交换）。
- **amend 的降级项 ① 实现**（不再是「空会话开场」）：分歧 actor 的会话由
  `forkSession(sourceSessionId, …)` 从**前驱转录**复制而来，按后端能力降级——没有
  `forkSession`（v2/ACP）就铸空会话并记一行日志，**不拒绝 amend**。门禁实测钉死引擎语义：
  fork 的切点是**不含**被指消息（6 条消息在 `message[3]` 上 fork 回来 3 条），所以 driver 读
  一次源转录、把 fork 指向边界**之后**那条消息；源会话正好停在边界时用尾拷。P4b 门禁
  **18/18**（按**内容**比对前缀——复制会重铸所有 message id，那正是 count offset 存在的理由）。
  降级项 ②（无 in-flight 条目）与 ③（只回看一代）保持不变。

## 1.0.0-rc.5 — workflow 全量落地 P0–P3（vendored dwf 引擎 + 官方钩子工具面 + host journal）(2026-10-10)

> 口径：**ZCode 的 workflow 整套用上，但不重造编排逻辑**——引擎 vendor 上游 dwf，
> 模型经官方 `tool` 钩子作者化，状态/调度/审批/预算全在 host。P4（/z/ 投影）与
> P4b（amend 导入缓存）未完成，见文末。

### feat(core): 插件与 host 共存（P0，唯一的架构改动）
- 锁文件记**所有者角色**：`tryBecomePrimary(lock, {role, url})` 写 `{pid,startedAt,role,url}`，
  新增 `currentPrimary()`（只认活着的 pid）。host 启动即取 `role:'host'` 并写自己的 web URL。
- **ATTACHED 模式**（`src/plugin/attached.ts`）：插件读到活着的 host 就只注册工具、**零
  transport、零端口、连 Telegram token 都不需要**；host 不在时逐字维持旧行为（FULL / PASSIVE）。
- host 侧通道：`/api/attach/{status,notify,echo}`（token 闸之后）。host 关停加了 10s 硬上限 +
  `process.on('exit')` 兜底释放锁（TG long-poll 卡住时曾把锁留在原地）。
- 门禁 `scripts/spikes/p0-tool-registration/gate.mjs`：**14/14**（工具可调用并取回 host 分配的
  runId、插件零端口、无第二个 TG poller、host 不在时逐字回归）。
- P0-1 实测结论（`docs/workflow-p0-tool-registration.md`）：opencode 对重名工具**列表层并存、
  模型面 last-wins 静默覆盖**，所以工具必须幂等、无实例状态、id 由 host 分配。

### feat(workflow): vendored 上游 dwf 引擎（P1）
- `vendor/zcode-dwf/`：`dynamic-workflow`（94 文件 / 20,530 行）+ `dynamic-workflow-runtime`
  （5 文件 / 1,322 行），Apache-2.0，登记制（PATCHES.md 只有两行相对 import 改写）。
- `scripts/build-dwf.mjs` + `build:all` 接入；`typescript` 从 devDeps 提到 **deps**（引擎运行时
  要 TS 编译器 API）；`vendor/zcode-dwf/dist` 进 `files`。
- 冒烟测试 8 例：照上游 run service 的流水线编译 → typed schema 合成 → 真沙箱（子进程 vm）跑
  双 actor 脚本 → 断言诊断带作者行号、typed submit 经引擎 accept、脚本抛错结算 errored、
  `process`/`require` 在编译期就被拒。

### feat(workflow): driver + host manager（P2）
- `src/core/workflow/`：`journal.ts`（JSONL，一 run 一文件，同步追加 + 内存索引）、
  `driver.ts`（引擎 ↔ ocrc 会话；actor 会话 journal 化、turn 结束由 relay 送进来、
  run 级 seat gate）、`world.ts`（8 个读原语，超限**拒绝不截断**，无 shell）、
  `artifacts.ts`（内容成员落盘 + per-run index.json）、`saved.ts`、`manager.ts`
  （submit/list/get/events/cancel/resume/amend/冷恢复/预算闸）。
- HTTP：`/api/workflow/runs*`、`/api/workflow/saved*`、artifact 字节端点（不可变缓存）。
- CLI：`ocrc wf list|show|events|cancel|resume|amend|run|compile|saved`。
- 门禁 `scripts/spikes/p2-workflow/gate.mjs`：**30/30**（3 actor 并行、并发上限、typed ask
  一次通过 + repair 后通过、world.read、artifact、report、cancel、resume、重启后 resume、预算）。
- 门禁修出三处真缺陷：driver 没绑进 live 表（所有 ask 永停 running）、事件被写两遍、world/
  artifact 的根目录用了 host 的 cwd。

### feat(workflow): 工具面 + 技能 + 人工门（P3）
- 16 个工具挂在 ATTACHED 插件上（作者侧 9 + actor 侧 3 + 基础 4），全部是打回 host 的薄 HTTP
  调用、无状态。**技能门**：创建类工具在本会话未加载 `dynamic-workflows` 技能前直接拒绝；
  开门走 `GetWorkflowSkill` 或 opencode 官方 `skill` 工具的 `tool.execute.before` 钩子。
  技能正文 vendor 自上游 bundled-skills（2,781 行），由 `GET /api/workflow/skill` 供出。
- `EvalWorkflowSnippet`：只编译不建 run，回带行列的诊断——模型最依赖的便宜迭代路径。
- **world.run 人工门**（`src/core/workflow/approval.ts`）：审批卡 + `POST /api/workflow/approval`，
  **一律 fail-closed**（无父会话 / 超时 5 分钟 / 未知 requestId / host 关停都拒绝），
  `always` 按 (run, 命令) 记忆，`OCRC_WORKFLOW_RUN=off|auto` 两档旁路。
- 门禁 `scripts/spikes/p3-tools/gate.mjs`：**14/14**（模型读到技能 → 故意写错拿 TS2322 带 L3:C7
  的诊断 → 改对起 run → 跟进度 → actor typed submit 被接受 → escalate 被回答）。

### docs
- 新增 `docs/workflow-p0-tool-registration.md` / `workflow-p2-record.md` / `workflow-p3-record.md`
  （三份实测记录，含各自修出的真缺陷）；ARCHITECTURE 新增 workflow 域；OPS 新增运维要点；
  PRODUCT 的 workflow 条文改判；next-phase §4 指向本计划。

### 未完成（下一批）
- **P4**：`/z/` 的完整投影（`snapshot.workflowRuns` + `workflowRunDeltas` + 7 个 v4 查询 +
  4 条命令 + saved 家族 + `getDynamicWorkflowClientConfig` + sessions-index `workflowActivity`）。
  当前模型侧与 CLI/HTTP 侧已可用，面板里还没有 workflow 卡与侧页。
- **P4b**：amend 的导入缓存（上游 `dynamic-workflow-import.ts` 移植）。当前 amend 是**重跑**
  （正确但更贵），已在 `manager.amend` 的注释里写明。

## 1.0.0-rc.4 — N12: the goal loop, off-peak completion, rc.3 console closeout (2026-10-10)

> 口径：**本批完成后，「ZCode 有而我们没有」的体验面归零**（剩余非 ✅ 三类：产品裁决不做 /
> workflow 单独立项 / 不在前端复刻口径内的桌面壳与 ACP——见 CHECKLIST §0 与对账）。

### feat(goal): goal 全链（引擎零改动，全在 host）
- **循环**（`src/core/goal.ts`）：回合末采样记账 → 预算闸 → 独立验收子会话 → 通过 complete /
  未达成带 nextAction 续跑 / 撞闸停机通知。提示词逐句对齐上游 `contracts/src/tools/target.ts`。
- **四处有意偏离上游**（各自注释在案）：**fail-closed**（上游坏 JSON 判通过，我们停机）；
  **两条上游没有的硬闸**（迭代上限 12、无进展检测）；**续跑可见**（origin `goalContinuation`）；
  **权威状态在 host state.json**（上游在会话存储）。
- **四处接口**：`GET /api/session/:id/goal` + `POST /api/goal`；TG `/goal set|pause|resume|
  clear|status` + 内联按钮 + BotFather 菜单；ws `goal` 帧 → `state.updated` → /z/ 面板；
  隐式：`goalVerify` 时间线 marker（lane `turnTailBoundary`，running→终态同 rowId upsert）。
- 冷恢复把 active 目标落 paused（绝不自动拉起）；plan 模式与 goal 互斥；续跑轮在 /z/ 是
  `goalContinuation`（不算真实用户输入、无幽灵气泡），TG 侧抑制合成气泡。
- 新增后端一次性子会话原语 `promptOnce`（建→发→读→删）。

### feat(offpeak): 闲时补尾 + 补债
- `queuePosition`（读出时按 FIFO 派生，不落盘）、`boundSessionId`（会话内创建首跑 resume，
  会话没了回落新建）、失败/取消可 `continue` 重取号（严格排到队尾）、任务可携带 goal
  （派发后挂目标，kickoff 由工单自己的 prompt 承担）。
- `tests/unit/offpeak.test.ts` 补上 N5 欠下的 24 条单测。

### feat(git): 提交信息生成
- Git 面板最后一处"如实拒绝"接真：host `POST /api/git/commit-message` 取工作区 diff
  （24KB 有界截断，复用路径白名单）→ 一次性子会话（`tools:{}` 禁写）→ 剥围栏/引号。

### perf: 分包审查 + mermaid 按需加载
- 实测首屏 ≈ **2.6 MB gzip**（入口 441.8 kB + 唯一静态 chunk 8,688.4 kB / gzip 2,434 kB
  + CSS 385.9 kB）。mermaid 静态残留仅 **622 kB**；重件（pdf/pptx/xlsx/prism/wasm）上游
  本就各自懒分包。vendor 补丁 #7：MermaidBlock 渲染器改按需加载（结构摆正，为后续把
  streamdown plugins 也延后铺路——那一步动核心消息渲染器，须配渲染实测，独立批次）。

### feat(web-next): /z/ goal 面
- 桥接把 host 四态记录投影成 vendor 六态（`goalProjection.ts`，含 availability 两门的
  上游门控），续跑轮 origin + epilogue 披露，每轮验收一条 timeline marker。
- `sendGoalCommand`/`pauseGoal`/`resumeGoal` 接真（此前落 `ocrc_unwired_*`）。

### fix: spike 修出的三处缺陷（隔离栈实测）
- **证据窗口从头部截断**：多轮后最新一轮整段被切掉，验收器两轮看到同一状态 → 无进展闸
  第 4 轮误停健康目标（实测 4 轮时证据 10.2k > 8k 上限）。改为**保尾**。
- **resume 不续跑**：上游 resumeGoal 会 continueGoalAfterChange；我们只翻状态，
  且撞过迭代上限的目标 resume 后下一轮立刻又停。改为 resume 派发续跑 + 上限按整档延展。
- **续跑可落进 plan 模式**：循环自身没查 plan（set/resume 查了）。改为拒绝续跑并停机通知。
- 实测记录：[docs/n12-spike-record.md](docs/n12-spike-record.md)。

### docs: 收口对账
- CHECKLIST：§0 收口口径 + 全量对账（陈旧条目改正：Git 写操作其实 N7-3 已接、Header 全要素、
  任务行状态点；剩余 🔶/⬜ 逐条注明归属）。PRODUCT.md：「不做目标/goal」改判（机制在引擎钩子、
  状态在 host；host 原生 workflow runner 仍不做）。ARCHITECTURE/OPS：goal 循环、state 槽位、
  offpeak 文件、运维要点（验收器残余风险 / 三条硬闸 / 关停次序）。

## 1.0.0-rc.3 — the ZCode shell IS the product; goal/workflow groundwork (2026-10-09)

> rc.1 → rc.2 是 fork 搭设期（N1–N8：ZCode 前端挂上 ocrc 服务、逐组件对表，见
> `web-next/vendor/CHECKLIST.md` 与 `docs/ARCHITECTURE.md`）。本条目从 rc.3 起记。

### refactor(web)!: 旧控制台退役——`/` 即 ZCode 壳
- `/`、`/z/*`、`/next/*` 同一落点（ZCodeApp）；rc.2 控制台（Home/Session/Automations/
  Settings/TokenGallery + 命令面板等浮层）删源码退役（55 文件，按引用闭包）。保留：
  ShareLanding（公开分享页）、PairGate（共享鉴权门）、cards/markdown 闭包。
- 柿橙配色封存 `web-next/src/styles/persimmon-theme.css`（不参与构建，回肤取用）。

### perf: N9 性能批（详见 docs/perf-remediation-brief.md）
- 行身份内容寻址（rowId 从位置序号改为 messageId 哈希）——**回复重复渲染根除**，
  216 卡会话流式 11 次采样零重复行；首屏 1.84s（<2s 线）、refetch 次数减半。
- 热路径减负（工具消息缓存 60s + 单窗回取上限 3 + 去抖 250ms）、sdelta 侧信道复活
  （host 接线，流式回合 9+ 帧/250ms 批次）。残余：全量 rebuild 的 137ms longtask
  （窗口化按计划不做，留观察）。

### feat: N9-4 消息动作 / N10 任务组 / N11 白板与插件面
- fork 直通（`POST /api/session/:id/fork`）、editUserQuery（revert 截断 + 重发；文件
  rewind 如实拒绝）、feedback 本地持久；getHistory 补 revert 截断（引擎自己不过滤）。
- 任务组：host state 三槽位 + `/api/task-groups` + 桥接 5 方法接真（分组视图实测出组）。
- 白板入口启用（vendor PATCHES #6；「添加到对话区」走既有附件通道）；插件面读侧映射
  opencode.json 的 plugin 数组（市场类操作如实拒绝）。

### feat: 计划详情页（plan projection）
- 核实 opencode plan agent 无 ExitPlanMode 工具；plan 回合产出投影为该形状（前缀
  `plan-` 标明投影）→ 时间线计划卡 + 状态面板计划目录 + 详情侧页全链路实测。
- 新增 per-message agent 通道（`/api/message` 带 `agent`），/z/ 计划模式 → 引擎原生
  plan agent。

### fix: 发布门修复 + 文档对账
- ci.yml/publish.yml/pre-release.sh 三处对已退役 `web/`（Svelte）的 install/build/test
  改指 web-next——此前任何 push 都会红、任何 `v*` tag 都会在 publish 前失败。
- AGENTS.md：`/` 即壳、4199 隔离配方、spike-restart.sh 警告（4598 遗留，误跑顶死 4199）；
  CHECKLIST §12 逐步勾账。

## 0.26.12 — ADOPT your own engine; the control-plane positioning lands (2026-10-06)

### feat(host): ADOPT an already-running opencode server (`OCRC_SERVER_URL`)
- **流式断开的真正根因**：用户自跑的 opencode（:4096）与 ocrc spawn 的引擎
  （:4097）**共享 session 存储（列表可见）但事件流隔离**——用户引擎里跑的
  会话在面板上永远静默，手动刷新只能靠 REST 拉历史。
- `OCRC_SERVER_URL=http://127.0.0.1:4096` → host 不 spawn，驾驶用户的引擎
  （事件 SSE / 会话 / 审批全指向它，Basic 凭证共用 config.env）。已部署生产
  实测：用户引擎的 streaming 事件恢复流入（TG 卡片与 WS 同步收到）。
- **PRODUCT.md 第零条**（定位落案）：ocrc = 以 opencode 为引擎的远程驾驶
  控制面；双拓扑（独立=第一公民 / 共生=轻量接入）= 同一功能矩阵；引擎关系
  二元性；**Windows 约束**（opencode desktop 版 → 壳走 adopt）；UI 原则
  「右栏显示能力 ≥ 中栏」+ E2E 门禁强制。

### feat(host): SSH remote 驱动补齐（功能矩阵对齐）
- remote:`<id>` 后端注册从插件入口**移植进 host**——第一拓扑此前只能配置
  远程主机却不能驾驶（面板在、引擎盲）。端口预留/Basic 凭证/降级语义与
  插件版一致。

### fix(web): token 回种死循环（流式/401 反复发作的第二根因）
- 长开 tab 的 URL 里挂着配对时代的 `#token=<旧>`：`captureToken` 每次 boot
  回种、401 处理器盲信 hash——撤销配对轮换后，旧凭证被反复复活。现在 hash
  仅在本地无 token 时采用；hash≠stored 时先向服务器验证再采信；WS 连续
  4 次升级失败自动探测并引导重新配对。

### feat(web): 对话中创建定时任务（ZCode 机制）+ 管理增强
- 注册 `schedule_create` / `schedule_list` agent 工具（ZCode 源码实证：
  创建的正解是模型调工具，不是 UI 按钮）——对话里说「每天 9 点做 X」即建。
- SchedulesPanel：每行 ▶ 立即运行（后端 `POST /api/schedules/:id/run`，
  暂停态拒绝）、空态引导文案。
- 右栏 homeId 正名：`config` 拆为 **定时任务** + **MCP** 两个 tab（含本地
  迁移）；auto 主题图标 = 半月+A（两处切换入口）。

### chore: E2E 发布门禁 + 运维脚本
- `scripts/release-smoke.mjs`（对生产跑真实断言：**发 prompt 断言流式
  到达**、WS live、右栏滚动、凭证间距、配对按钮）+ `scripts/pre-release.sh`
  （typecheck→全量测试→0/0→双 build→部署→smoke，全绿才允许打 tag）。
- `~/bin/restart-ocrc.sh`：幂等生产重启（杀净→等端口→起→等 web 200）。
- web：idle 自动展开右栏（60s 无输入；手动收起 10 分钟豁免）、tool 输出
  **MD 渲染切换**、凭证双框间距、构建版本悬停自查、SW 更新提示条。

## 0.26.11 — hotfixes: token rotate hardening, UI regression fixes, schedule tools (2026-10-05/06)
> 条目补记（发版时遗漏）。内容散于 0.26.10→0.26.12 之间的 main 提交：
> token 回种加固的第一版（mtime+size）、右栏 ZCode register 试验、homeId
> 正名、schedule 工具与 ⏰ 快速浮层、MD 切换、SW 更新提示、dependabot
> 实验合入（ACP SDK 1.6.1/zod4/diff9）。最终形态以 0.26.12 条目为准。

## 0.26.10 — proxy goes UI, repo diet (2026-10-05)

### feat(channels): Bot API 代理进面板
- 机器人管理面板的 Telegram 凭证区新增「Bot API 代理」输入框：与 token 同框
  保存（留空 = 不改），凭证来源行实时显示代理来源（面板凭证 / 环境变量 /
  直连）。生效优先级与 token 一致：**面板凭证 > TELEGRAM_PROXY >
  HTTPS_PROXY/https_proxy > 直连**，重启实例生效。
- 面板/插件两种形态同权：host 与 plugin 入口都从 channels.json 读取
  `credentials.proxy`。

### chore(repo): 结构瘦身
- 删除 pact 协议残留：`CLAUDE.md`（seat claude）、空壳 `.mcp.json`、仓库
  `opencode.json`（仅剩指向不存在二进制的 pact MCP——serve 每次启动的
  死配置噪音）。
- 7 份历史调研/审计报告归档至 `docs/research/`；6 个 ACP 探针/回滚脚本归档
  至 `scripts/spikes/`。正式文档（PRODUCT/ARCHITECTURE/OPS）与活跃脚本
  （spike-restart/v2-smoke/v2-restart）留在原位。

## 0.26.9 — every loose end closed: TG proxy egress, full i18n, zero warnings (2026-10-05)

### feat(telegram): proxy egress for blocked/corporate networks
- `TELEGRAM_PROXY`（回退 `HTTPS_PROXY`/`https_proxy`）→ undici ProxyAgent 挂进
  grammy baseFetchConfig：getMe/轮询/发消息全部走代理。api.telegram.org 不可达
  的受限网络从此是**配置问题**而不是等天气——config.env 写一行即通。
- 已知外部条件收口：此前「TG 真机 spike 等网络」由本项关闭。

### feat(i18n): Telegram 用户可见文案全量双语化
- 新增 103 个 key（en/zh 对齐，类型强制），接线 handlers/index/menus/
  main-keyboard 共 6 文件；发往用户的消息中文字面量归零（保留 2 处匹配
  锚点与注释）。主键盘「会话」按钮显示与路由共用同一 key，任意 locale
  不脱钩。

### fix(web): svelte-check 13 条 warning 清零
- a11y 三处按编译器豁免规则补语义（role="presentation" / listitem 包裹），
  死 CSS 8 处经全仓 grep 验证后删除，`tick` 改 `export const`——
  0 errors / **0 warnings**，140/140 web 测试过，视觉零变化。

### chore(deps): ACP SDK 1.6.1 + zod 4 + diff 9 合入；vitest 5 拒绝
- 全部经独立 worktree 实验裁决（typecheck + 594/594 + build）；
  vitest 5 因 mock 语义差异（1 测试需重写时序假设）+ 需手动补 vite peer，
  收益为零，拒绝并说明。dependabot 配置：去除上游残留 reviewer、
  minor/patch 分组降噪、覆盖 /web。

## 0.26.8 — exorcism: every bridge is gone (2026-10-05)

### removed(install): directory bridges, everywhere, permanently
- 「桥」时代终结：0.2x 的 install 曾把 `ocrc.js` 桥散布到各配置家
  （`~/.config/opencode/plugins/`、1.18 迁移目标的 `~/.opencode/plugin(s)/`）。
  实验与生产双重确认其加载时机**不可预测**：opencode 实例会在任意时刻加载
  桥，派生出幽灵 ocrc 实例（1 PRIMARY + 4 PASSIVE 同屏），与真正的 host 抢
  PRIMARY 锁与 web 端口——日志里成对的 starting、幽灵 primary.lock pid、
  EADDRINUSE 重试都源于此。
- **install** 不再写任何桥：只写 .env + npm 数组条目（1.18.x 唯一可靠路径，
  0.26.7 已修复其对象 default 导出），并顺手清理环境中的一切旧桥。
- **uninstall** 清理所有历史布局的桥 + npm 数组条目 + 遗留配置项。
- 本机环境已手工清空（三桥 + /tmp 实验残留全部移除），生产 host 独占
  web 4099，无第二实例。

### docs: README 桥的最终结论同步

## 0.26.7 — the npm-plugin path actually works on opencode 1.18.3x; pairing revoke; mode visibility (2026-10-05)

### fix(plugin): default export must be an object (this is the serve-mode unlock)
- 实验闭环（opencode 1.18.34 源码 + 真机）：V1 加载器（readV1Plugin, strict）
  要求 default export 为 `{server()}` **对象**；裸函数 default 报
  "Plugin export is not a function"。此前 npm 数组路径装包成功、加载必败。
  现为 `{ id, server, setup }`：V1 调 `.server(ctx, options)`、V2 读 `.setup`，
  桥文件本就优先 `.server`（1.17 兼容不受影响）。
- 端到端验证：1.18.34 + plugin 数组 → 插件加载、赢得 PRIMARY、双路径启动。
- 同轮实验确认：**目录扫描（`~/.config/opencode/plugins/` 等任何布局）在
  1.18.32/1.18.34 serve 下均不生效**——npm 数组是唯一插件路径（README/OPS
  已同步）；npm 插件由 opencode 在 serve 时自动安装（无需人工装包）。

### feat(pair): 撤销所有配对设备
- `POST /api/pair/reset`：轮换 web token（auth 中间件按 mtime 每请求感知，
  跨进程生效）+ 配对计数清零；旧设备下一次请求即 401 回到配对页。
- CLI：`ocrc pair --reset`；面板：机器人管理弹窗新增配对计数 + 两段确认
  撤销按钮（含「当前设备也会被登出」的诚实提示）。
- 设计边界：设备共享单一令牌是刻意的单用户信任模型——按设备撤销需要
  per-device 凭证体系，v1 不做。

### feat: 运行模式可见
- `/api/version` 增 `mode: plugin|host`（入口自报）；`ocrc status` 直接显示
  `ocrc x.y.z (plugin|host mode, <commit>)`；README 写明三种判断方法。

### fix(web): 频道卡片一致性
- 钉钉换官方品牌矢量（源转录的 Google 蓝修正为官方 #0089FF，替代 16px ico）；
  微信/飞书/钉钉三张卡的「待接入（配置面板已预埋）」文案统一。

### chore(deps): hono 4.13.12、@opencode-ai/plugin 1.18.34、dotenv 18（全部实验验证后合入，dependabot PR #6/#7/#8/#9/#10 已裁决关闭）

## 0.26.6 — Telegram blackhole resilience, install writes the npm plugin entry, README as an independent project (2026-10-05)

### fix(telegram): status() survives a failed bot init
- grammy 的 `botInfo` getter 在 `bot.init()` 未成功（api.telegram.org 不可达）
  时是**抛异常**而非返回 undefined：TG 被墙时 `telegramStatus` 回调把
  `/api/pair/onboarding`（配对二维码！）与 `GET /api/channels` 一起炸成 500。
  现在降级为 `connected:false`，面板与二维码永远可用。
- host 模式接线 `telegramStatus`（此前缺失，面板看不到 bot 在线状态）——
  与插件入口 parity。

### feat(install): npm plugin array entry (1.18.x verified)
- 1.18.x 实测：serve 模式下 `plugin` **npm 数组是唯一可靠的插件加载路径**，
  目录扫描（`~/.config/opencode/plugins/` 等）不可靠——桥单独存在时 serve
  不加载。`ocrc install` 现在把 `"@bd7pil/ocrc"` upsert 进 opencode 配置
  （纯 opencode.json 自动写入；jsonc 永不改写，打印精确的手工编辑行）。
- 目录桥保留（1.17 兼容），但 npm 数组才是受支持的安装路径。

### docs: README 重写 — 独立项目定位
- ocrc 不再以 fork 自居：双运行形态（plugin / host）对照表、npm 安装与
  升级路径、EL7 兼容基线（glibc 2.17 / OpenSSH 7.4）、企业代理远程、
  release 流（tag → CI OIDC publish）全部落在 README。上游来源移入
  Credits（NOTICE 法律声明不变）。

## Unreleased — PRODUCT constitution, rail v2, remote wizard + enterprise relay (2026-10-05)

### docs: 产品宪法 + 架构分层定稿
- **docs/PRODUCT.md（新）**：一句话定义（远程驾驶自己/管辖的 opencode，企业
  内网受控环境延伸）、四层归属判据（核心/壳/宿主/分发）、组件分发模型、
  壳技术倾向 Electron（opencode 2026-05 Tauri→Electron 迁移 + ZCode desktop
  双先例）、兼容基线（pin 1.18.x、EL7 下限）、明确不做清单。
- ARCHITECTURE.md 增分层原则 + 路线图（Windows 被控三处 POSIX 补丁范围、
  V2 独立立项、薄壳蓝图出处）。
- **pact 死配置移除**：AGENTS.md 的 pact 协议块与 .mcp.json 的 pactify 条目
  （工具从未存在于本机，上游遗留）；AGENTS.md 改为指向真实文档的导读。

### feat(web): 左栏 v2（ZCode WorkspaceSidebar register）
- 三桶模型：置顶 → 常规（项目/时间两种视图，persist）→ 归档区（平铺 +
  取消归档 + 20 条分页）；归档为 UI 语义（localStorage 集合，opencode v1
  无 archive API，不动服务端数据）。
- 项目视图按 workspace 分组：组头 **云朵（remote: backend）/ 文件夹（本地）**
  图标 + 主机名 + 会话数，可折叠（persist）。
- 顶部动作区（新建会话 + 搜索）+ 底部快捷区（定时任务 → 配置面板、远程主机
  → Remotes，带计数）+ 行内搜索（标题/项目/主机/短 id）。
- 纯函数抽到 nav/railModel.ts（8 测试）；stores/archive.ts 归档集合。

### feat(remote): 四步添加向导 + 企业中转
- RemotesPanel 内联表单 → **向导弹窗**（选择方式[SSH 可选，WSL/Docker 待接入]
  → 填写配置 → 连接中[实时日志控制台+阶段文案+失败重试] → 完成），≤820px 全屏。
- **企业代理**：remotes.json 增 per-remote httpProxy/httpsProxy/noProxy/caPath
  （0600；含凭据的 URL 面板脱敏）；`buildProxyExports` 注入远端 serve
  （大小写双份、NO_PROXY 强制含 127.0.0.1,localhost 防隧道劫持、CA 映射
  NODE_EXTRA_CA_CERTS）——ZCode「消毒+受控回注」的 ocrc 版。
- OPS.md 增企业内网场景章（A 代理注入 / B ProxyJump 零开发 / C 离线 scp 安装
  / provider `options.baseURL` 网关模式）。

### test
+14（railModel 8、proxy exports 5、redactProxyUrl 1）；后端 558 绿、web 140
绿、svelte-check 0 errors。

## source-review fixes, TG experience trio, remote config sync (2026-10-05)

A complete re-read of src/, tests/ and web/ (docs re-synced in the same pass,
see the docs/ commits) produced a debt list — then this series cleared it:

### fix(tg): the grinev experience trio
- **Signature dedup actually works now**: `deliveredSignature` returns the
  signature of what was REALLY delivered (`getTelegramRenderedPartSignature`);
  the old `fallbackText.slice(0,128)` never matched the streamer's rich
  signatures, so unchanged flushes re-edited every part.
- **Rich rendering on-line**: native parts go out via `sendRichMessage
  ({blocks})` — the ported render pipeline's output was computed and then
  thrown away at send time (plain `parse_mode: undefined` only). Native
  failure throws into the streamer's `plainOnly` degradation, which now
  genuinely engages. Finalize fallback delivers ALL parts (long finals no
  longer lose everything past the first chunk).
- **Live tool cards wired**: the orphaned `ToolCallStreamer` +
  `RunningToolTracker` render streaming-card tool blocks as one progressively
  edited message with elapsed-time ticks; `standard` granularity hides it.
- Hygiene: dead throttle-reset branch removed; duplicate `/workspaces`
  `/projects` registration dropped; permission-flow/question-flow copy moved
  into i18n (`question.flow.*` / `permission.flow.*` keys added to en+zh —
  the i18n module is wired for the first time); confirmed-dead orphans
  deleted (markdown-to-telegram-v2, question-manager, rename-manager,
  external-input/abort-suppression, finalize-assistant-response).

### fix(web)
- `+layout.svelte` stacked one `ocrc:resubscribe` window listener per
  navigation — registered once in onMount now, removed on destroy.
- `ansi.ts`: 38;5;n maps through the xterm 256-color palette; 48;2/48;5 emit
  background-color (both were swallowed before).
- Dead `stores/activeSession.ts` removed; `#token` fragment semantics
  cross-referenced (boot keeps it for iOS PWAs, auth failure strips it —
  complementary by design, now documented as such).
- svelte-check: all 7 pre-existing errors fixed (Inspector side-chat typing,
  visual-audit.mjs strictness) — 0 errors.
- stability-14.12 `expect(true)` placeholder replaced by a pointer to the
  real index-gating coverage.

### feat(remote): sync-config — bring the opencode environment along
- `RemoteHostManager.syncConfig(id)`: tar the local `~/.config/opencode`
  whitelist (`opencode.json` incl. its mcp section, `AGENTS.md`, `CLAUDE.md`,
  `command/`, `agent/`, `skill/` — never `plugin/`) and apply it on the
  remote in one ssh round-trip; collisions back up to `*.ocrc-bak`
  (ZCode's no-silent-overwrite semantics). Design + ZCode mechanism
  comparison: docs/remote-provisioning-design.md.
- `POST /api/remotes/:id/sync-config` + RemotesPanel「同步配置」button.

### test
- 34 new tests: streaming-render (5), tool-stream-bridge (5), scheduler (5),
  channels (4), previously-uncovered web routes (8), v2-backend (5),
  control-plane (3), config-sync helpers + remotes routes (4+).
- Backend 544 green; web 132 green; svelte-check 0 errors.

### Still open (recorded deliberately)
- The i18n dictionary (~620 keys) is wired only for the two flows; the rest
  of the TG surface (handlers/menus/renderer) still has hardcoded copy.
- cli/host.ts + cli/install.ts remain untested (interactive entry points).

## v0.26.0 — v0.26.5 — 2026-10-04

Headline: **SSH remote hosts** — drive opencode on other machines from the
same panel (deploy-on-connect adapted from ZCode, system ssh only):

- `~/.ocrc/remotes.json` store (0600, secrets generated per host, redacted in
  API responses); state machine unknown→detecting→provisioning→launching→
  online (+needs-auth/error/offline/disabled).
- Provision = official installer pinned to the LOCAL opencode version; no-
  internet fallback scp's the local binary. Never a musl/compat build.
- One ssh process does tunnel + remote serve — ssh death kills everything it
  started; respawn 2s→60s backoff with fresh detect each cycle.
- Per-remote `/global/event` SSE into the same dispatchEvent — remote turns
  mirror exactly like local ones; `sync-auth` copies auth.json (0600).
- Remote backends derate honestly: no liveMirror/tuiSelect/local-git.
- Web: /api/remotes CRUD + inspect/provision/sync-auth; RemotesPanel.
- Patch train: EL7 OpenSSH 7.4 compat (no accept-new), port-detect without
  `ss` on non-interactive PATH, SDK fetch wrapper → explicit Request →
  client-level headers (the custom-fetch Authorization header was silently
  dropped inside opencode's embedded runtime).

## v0.25.0 — v0.25.2 — 2026-10-03

Headline: **sdelta incremental streaming** — WS bytes off the O(n²) path:

- `sdelta` frames carry raw text increments to the WS hub (bypassing CardBus);
  snapshots become sparse checkpoints: 1s floor, 2s past 50k chars, 3s past
  150k (relay streamGap).
- 0.25.1: deltas coalesce per part on a 250ms timer; 0.25.2: flush only where
  a snapshot actually publishes. Wire order "deltas, then the snapshot
  containing them" keeps client replace append-safe.

## v0.22.0 — v0.24.4 — 2026-10-03

- **Session revert/unrevert** (POST /session/:id/revert with {messageID});
  history cards carry the opencode message id; post-cutoff cards hidden.
- Web: side chat pane (SelectionSideChatPane), ZCode pane summon, busy = any
  live thinking/streaming card, right pane as a separated surface, perf audit
  (hot-read caches, single WS serialization, hidden-tab gating), mobile
  popover/textarea fixes, context ring semantics + wheel fix.

## v0.18.0 — v0.21.0 — 2026-10-01/02

- Web: right pane becomes a dynamic tab system (workspaceSidePane register);
  zero pinned tabs; ZCode three-pane register with multi-subscribe WS (live
  subagent tabs); bottom-left identity rail + context category breakdown;
  composer send⇄STOP; mobile ⋯ menus; theme auto tier.
- VCS: the server's /vcs is unusable on big worktrees (279s) — spawn
  read-only git locally instead (16ms), 120s server-side cache, per-file lazy
  patches with a 400k cap (whole-tree diff hit 47MB here).

## v0.16.0 — v0.16.3 — 2026-09-30

Tabbed inspector (opencode-web pattern); plan HUD recoverable dismiss + ghost
chip + storage-key resets; tool-arg summarizer hardening (never String()
inputs — edit batches render as 'N edits').

## v0.15.0 — v0.15.2 — 2026-09-30

Desktop pass: two-tone canvas, ZCode plan window, resizable panes, foldable
inspector; surface unification; visual repair after the two-tone pass.

## v0.14.0 — v0.14.3 — 2026-09-29/30

Headline: **octg-simple lifecycle** — supervision always on (adopt-or-spawn,
crash auto-restart incl. SIGKILL/OOM, stop-file graceful stop, `ocrc restore`
for @reboot); `--watch` accepted and ignored. Streaming stops echoing user
messages; plan HUD overlap + tool-arg fixes; mobile/desktop overflow; desktop
goes neutral (ZCode register), orange stays accent-only.

## v0.13.0 — v0.13.6 — 2026-09-29

First-run onboarding landing (unauthenticated, ZCode-style; pending QR +
channel status only); real channel logos + ink-ring mark; supervisor/
restore/restart argv fixes; SIGKILL/SIGSEGV treated as crashes (OOM heals);
paired-state transition; onboarding lock hints.

## v0.12.0 — v0.12.4 — 2026-09-29

`ocrc start --watch` supervisor + `restore` (run-N.sh semantics); service
argv contract fix; README rewrite.

## v0.11.0 — 2026-09-29

HTTP Basic support for password-protected opencode servers
(`OPENCODE_SERVER_PASSWORD`) — octg cutover prerequisite.

## v0.10.0 — 2026-09-29

**Pending-token pairing (M11)**: /pair surfaces issue 1-minute single-use
tokens (`#pair=`); devices exchange at POST /api/pair/exchange; the permanent
token never travels in a URL again. ZCode-style QR block.

## v0.9.0 — v0.9.1 — 2026-09-28

Headline: parity + surfaces batch over the grinev UX port (P2b/P2c):

- **M8**: skills/files/worktree surfaces (backend + web panels + TG /skills
  /ls /open /worktree). **M9**: bot-channels management (channels store, web
  机器人 panel, TG consumption). **M10**: interactive question tool on
  Telegram + web — incl. the discovery that `question.*` never rides the V1
  event hook (dedicated SSE filter).
- Parity batch: TG subs/mode/cleanup/regenerate/suggestion chips, background
  notify, web zh UI, motion layer (seven-rule spec), plan orb (enso mark) +
  subagent jumps, windowed long-session rendering + offset pagination,
  replay completeness flag + REST resync (heals torn feeds).
- npm/GitHub publish (CI Trusted Publisher), grammY migration leftovers
  removed, photo intake + prompt-queue ack, reply keyboard 2x2.

## ocrc fork — 0.8.1-ocrc.1 (2026-09-25)

Forked from agentjoey/opencode-remote-control at `9b89b79` (v0.8.1).
Fork identity: `@bd7pil/ocrc`, config home `~/.ocrc/`, CLI `ocrc`.
See docs/development-plan.md for the full fork plan. Deltas so far:

- **Naming**: config home `~/.ocrc/` (token `token`, lock `primary.lock`,
  state `state.json`, log `ocrc.log`, env file `config.env`); CLI/bin `ocrc`;
  npm scope `@bd7pil/ocrc`; bridge file `~/.config/opencode/plugins/ocrc.js`.
- **Web network defaults** (LAN-first decision, token gate unchanged):
  `OCRC_WEB_HOST` default `0.0.0.0` (upstream 127.0.0.1), `OCRC_WEB_PORT`
  default `4099` (upstream 17081). Legacy upstream variable names still work.
- **web: bind errors surfaced** — listen errors (EADDRINUSE/EACCES) are now
  re-thrown asynchronously so the transport retry loop sees them, instead of
  being absorbed as unhandledRejections leaving the server silently unbound.
- **web: first-visit pairing token race fixed** — fragment token captured at
  module init (before any component mounts) and the fragment is stripped when
  a rejected token is cleared; kills the flashing reload loop seen on phones.
- **branding**: pactify linx → ocrc (PairGate, Titlebar, manifest, PWA title).

## v0.8.1 — 2026-07-24


Headline: **big review pass — core correctness, transport hardening, and
frontend accessibility / motion hygiene.**

### Core & transport fixes
- **Session routing hardening**
  - `SessionState.normalizeSessionId()` now guards `undefined`/`""` input,
    requires a `>=6` char suffix, and refuses ambiguous suffix matches so a
    short display id can no longer silently resolve to the wrong session.
  - All ingress points now normalize short ids: relay fallbacks, Telegram
    approval/pin, web routes (`/session`, `/abort`, `/diff`, `/todo`, `/context`,
    `/controls`, `/files`, `/rename`, `/commands`, `/approval`), and WebSocket
    subscribe.
- **Relay correctness**
  - Fixed an `AbortController` leak that kept `hasActiveGeneration()` stuck
    `true` forever, blocking Telegram input.
  - Per-session serialization so two messages targeting the same session can't
    clobber each other's timers, abort registration, or stream accumulator.
  - External/TUI-adopted turns now get a real timeout and register in the abort
    map.
  - `hasSession()` no longer swallows network errors; transient backend failures
    surface an error card instead of rerouting the prompt to a different session.
- **ACP lifecycle**
  - Canceled/rejected ACP connection promises are cleared so the backend can
    reconnect.
  - Spawned ACP children are killed on initialize failure and on host shutdown.
- **Telegram hardening**
  - HTML output is escaped everywhere (approval titles, `/sessions`, `/rename`,
    `/todo`, error replies) so `<`/`&` no longer 400 the reply.
  - 429 `retry_after` is honored with backoff; multi-chunk sends are paced.
  - `callback_data` ids that exceed Telegram's 64-byte limit are mapped to
    sha1 tokens.
  - Local and remote `/abort` now target the same resolved session.
  - Persistent 409 (another bot) / 401 (bad token) are logged as FATAL instead
    of silently dying.
- **Web transport**
  - WebSocket clients register synchronously on attach so early subscribes are
    not dropped and dead sockets can't leak.
  - `maxPayload` capped at 64KB; unexpected `verifyUpgrade` errors destroy the
    socket cleanly.
  - Query-param credentials (`?token=`, `?cf_access_jwt=`) are now only accepted
    on the `/ws` upgrade path, never on plain HTTP.
  - `/api/abort` and `/api/approval` validate their bodies and return 400 for
    malformed input instead of 500.
- **Plugin / host**
  - `.env` precedence reversed: the plugin's own `.env` is authoritative; the
    cwd `.env` can only supplement, not hijack token/allowlist.
  - `.env` written by the installer is created with `0600` permissions.
  - Transport start failures retry with exponential backoff instead of giving up
    on a transient boot error.
  - State and ACP store are flushed on SIGINT/SIGTERM so debounced writes aren't
    lost.
  - Log file rotates at 10MB.

### Web UI — terminal output & design audit
- **Terminal-style tool output** ships as production: multi-line or long tool
  args render in `TerminalBlock`, ANSI SGR colors convert to spans, and output
  over 20 lines collapses behind a show-more toggle.
- **Accessibility & motion**
  - Global `prefers-reduced-motion` fallback.
  - Session-row action buttons are visible on `:focus-within`, not just hover.
  - Focus trap + focus restore for NewSessionModal and CommandPalette.
  - Chip dropdowns (`AgentModelChip`, `SessionControls`) get
    `aria-haspopup`/`aria-expanded`, Escape, and click-outside dismissal.
  - Status dots carry accessible text; busy vs idle are distinguished by color
    (`--ok` vs `--accent`) as well as pulse.
  - Placeholder-only inputs receive `aria-label`s.
- **Theming / anti-patterns**
  - Banned 2px side-stripes removed from error and think-stream cards.
  - Added `--scrim`, `--bg-code`, and a semantic `--z-*` scale; swept ~15
    hard-coded colors and duplicated scrims onto tokens.
  - Layout-property animations (rail width, progress-bar width, modal padding)
    moved to transform-based animations.

### Also
- `TerminalBlock` ANSI parsing fixed for combined reset+color sequences
  (`\x1b[0;31m`) and 256/truecolor parameter groups.
- Web `feeds` store prunes inactive sessions to bound memory.
- Inspector panels discard stale async results when the user switches sessions.

## v0.8.0 — 2026-06-22

Headline: **OCRC becomes Pactify Linx** — a full console redesign around an
**agent-as-top-axis** information architecture, plus the Pactify brand (cool-slate
palette, chain-link mark). Built multi-agent: backend/contract by the orchestrator,
the UI by real **kimi-code** sessions driven headlessly.

### Rebrand — Pactify Linx
- Cool-slate theme (`#0a0e14` base) replacing warm charcoal; chain-link brand mark
  (role-colored arcs + silver "pact" square) and a `pactify linx` wordmark; refined
  per-agent accent themes, a fixed conversation palette (`--cv`), brand role colors,
  and regenerated app icons. App/manifest renamed to Pactify Linx.

### Console redesign (desktop + mobile)
- **Agent axis** — agents (backends) are the top-level axis: a left-panel agent
  dropdown + picker, sessions scoped to the active agent, and a per-agent chrome theme
  (the conversation stays emerald). `/api/backends` now reports name/host/status.
- **Chat** — session switcher in the sub-header; signature **EXECUTION** panel; reasoning
  toggle; code/list blocks; meta + copy/retry; in-place approval flow.
- **Inspector** — Tasks (scrolling middle) + pinned Working dir / **Usage** (tokens-first)
  / Context.
- **New session** modal (agent + working dir + recents + branch) and a `+ New` menu.
- **Command palette** — Agents (switch) + sessions across all agents + commands.
- **Mobile** — dual-screen Sessions↔Chat flow, bottom-sheet inspector, horizontal agent
  switcher row, and a FAB speed-dial.

### Also
- Telegram command-menu self-heal now confirmed active in the plugin hub.

## v0.7.3 — 2026-06-21

Headline: **the full ACP enhancement backlog (#1–9) ships** — kimi sessions reach
near-parity with opencode across diffs, history, images, @-mentions, mode/model
switching, MCP, the command palette, and terminal-style output. Built multi-agent via
Pactify orchestration (backend by the orchestrator, frontend by the kimi seat).

### Inspector & transcript
- **Red/green diff viewer** — the working-dir panel expands each changed file to a
  normalized, render-ready inline diff (`DiffEntry`: add/del/ctx lines) across all backends.
- **tier-2 history replay** — opening a native/TUI kimi session (no OCRC-recorded cards)
  now replays its history via `session/load` and rebuilds the conversation — fixes the
  "no message" blank on agent-native sessions.
- **terminal-style tool output** — tool-call output renders as a monospace terminal block
  (ANSI-aware, collapsible) instead of plain text.

### Composer & input
- **Image input** — attach or paste images; sent as ACP image content blocks to backends
  that advertise `promptCapabilities.image` (kimi). Gated by the `imageInput` capability.
- **@-mention file picker** — typing `@` lists the session's workspace files
  (`GET /api/session/:id/files`); selecting inserts an `@path` reference.
- **Mode + model switching** — kimi sessions expose their mode (plan/acceptEdits/…) and
  model via pickers (ACP `session/set_mode` + `set_config_option`); `sessionControls` cap.

### Backend surfacing
- **MCP** — the inspector MCP panel now shows an ACP agent's OWN configured servers
  (e.g. kimi's `~/.kimi-code/mcp.json`); `mcp` capability flips on for ACP.
- **Command palette** — lists the *viewed* session's backend commands with the right label
  (no more hardcoded "opencode commands").

### Telegram
- **Command-menu self-heal** — bot init now clears stale narrower command scopes
  (`all_private_chats`/`all_group_chats`) so the default 18-command menu can't be shadowed.

## v0.7.2 — 2026-06-20

Headline: **ACP backends surface working-dir diffs and TODO lists** — kimi (and
any ACP agent) now lights up the inspector's Task panel and changed-files list,
matching opencode. Plus adaptation to the kimi-cli → kimi-code-cli 0.18 rewrite.

### ACP capabilities (kimi + any future ACP agent, e.g. Claude Code)
- **TODO / plan list** — the inspector Task panel now populates for ACP agents.
  Reads both the ACP `plan` update (older kimi-cli / Gemini) and kimi-code 0.18's
  todo tool call (`rawInput.todos`), so it works across agent versions.
- **Working-dir diff** — files an ACP agent edits (captured from `tool_call`
  `diff` content, deduped by path) now show in the inspector's working-dir panel.
- The `diff`/`todos` capability flags flip to true for ACP backends — entirely
  backend-side, no frontend change.

### kimi-code-cli 0.18
- kimi-cli (Python, `KimiCLI/1.47.0`) → kimi-code-cli (Node/TS, `0.18.0`). The
  `kimi acp` ACP entrypoint is unchanged (no wire changes); the TODO list moved
  from the ACP `plan` update to a tool call carrying `rawInput.todos` — handled
  above.
- Ops: data dir `~/.kimi` → `~/.kimi-code`, OAuth not migrated (re-run `/login`);
  the launchd host template gains `KIMI_CODE_HOME` + a headless-auth note. See
  docs/OPS.md → 升级 kimi → kimi-code 0.18.
- `scripts/acp-field-probe.mjs` — a diagnostic that dumps live ACP `session/update`
  payloads, for re-confirming field shapes when an agent's CLI changes.

## v0.7.1 — 2026-06-19

Headline: **ACP sessions are now first-class** — kimi (and any ACP agent) gets
persistent sessions with history, per-session working directories, and a session
list scoped to the selected agent. The standalone multi-backend host now serves
the production domain (`ocrc.agentjoey.ai`).

### ACP sessions
- **Persistent sessions + history** — ACP agents resume across connections but
  don't list sessions or replay history, so they used to vanish on host restart.
  OCRC now persists the session list (id/title/dir) and finalized conversation
  cards itself (`acp-sessions.json`), and `resumeSession`s a session before
  prompting it. kimi sessions survive restarts and reopen with their history,
  like opencode.
- **Per-session working directory** — new ACP sessions take a user-entered
  directory (opencode-style workspace UX, applied to all ACP agents). The web
  shows a free-form directory input with a datalist of known dirs; the agent runs
  in that directory and the inspector shows it. New capability flags
  `workspaces`/`freeformWorkspace` drive picker-vs-input.
- **Slash-commands** — `listCommands` is populated from ACP
  `available_commands_update` (kimi exposes `/init`, `/compact`, …).

### Multi-backend UX
- **Backend switcher moves you to that agent** — selecting a backend opens its
  most-recent session (or the empty state to start one) instead of leaving you on
  the previous session.
- **Session list scoped to the selected backend** — pick acp:kimi and the sidebar
  shows only kimi sessions (active only when >1 backend is served).
- **Working dir shows for ACP** — the inspector's working-dir was wrongly gated on
  the `diff` capability; now the directory always shows, only the diff file list
  is gated.

### Deployment
- The standalone multi-backend host (`opencode + kimi`) now serves the production
  domain; the cloudflared `ocrc` ingress points at the host's web port. Uses the
  persisted web token, so paired devices need no re-pairing.

## v0.7.0 — 2026-06-18

Headline: **multi-agent** — OCRC can now drive non-opencode agents over ACP
(validated live with Kimi), and one standalone instance can serve **opencode + an
ACP agent at once** with an in-UI backend switcher. Plus the earlier mobile/PWA
polish.

### Multi-agent (ACP + multi-backend)
- **ACP backend** — a second `AgentBackend` (`AcpBackend`) drives any Agent Client
  Protocol agent over stdio (`@agentclientprotocol/sdk`); validated end-to-end
  against `kimi acp` (streaming text + reasoning, tool calls, permission approval).
  Normalizes ACP `session/update` → the relay's `AgentEvent` (Phase 2 event seam).
- **Standalone host** (`oprc host`) — run OCRC against spawned agents with **no
  opencode**, web-only or with Telegram. `scripts/run-acp-host.sh` + `.env.acp`
  make it turnkey; `OCRC_ACP_AUTO_APPROVE` gates tool approval.
- **In-UI backend switching** — set `OCRC_BACKENDS="opencode, kimi=kimi acp"` and
  one host serves both: the host spawns its own opencode server, the web titlebar
  shows a backend switcher (sets where new sessions go), `/api/sessions`
  aggregates across backends, and each session routes to its owning agent.
- **Per-backend capability gating** — the UI hides affordances a backend can't
  serve (workspaces/diff/todos/agent-model/MCP/commands), keyed off the *viewed*
  session's backend. ACP slash-commands are surfaced from `available_commands_update`.

### Mobile web / PWA
Headline: the input now follows the iOS keyboard smoothly, safe areas are correct,
and a stale token self-heals.
smoothly, safe areas are correct, and a stale token self-heals.

### Mobile web / PWA
- **Composer follows the keyboard** — on phones (≤820px) the input floats over the
  chat and tracks the keyboard/bottom-toolbar by translating a published `--kb`
  inset on the GPU, so it glides rather than resizing the app each frame. The
  home-indicator padding telescopes away once the box lifts, so there's no dead
  gap above the keyboard.
- **iOS safe areas fixed** — the app uses `height:100vh` (not `100dvh`/`100%`); on
  standalone PWAs those mis-size on cold start and break `viewport-fit=cover`, so
  `env(safe-area-inset-*)` resolved to 0 and a dark strip showed below the input.
  Now the app fills to the physical screen bottom with real insets.
- **Dim-under-input** — chat content fades to low brightness as it scrolls beneath
  the floating input (a CSS fade mask, not a frosted panel).
- **Latest message stays reachable** — the chat reserves the composer height (plus
  the keyboard inset) and re-pins to the bottom, fixing the "can't scroll to the
  newest message after switching sessions" bug.
- Browser tabs and installed PWAs share the same `--kb` math; Safari's bottom
  toolbar no longer hides the input at rest.

### Fixed
- **Stale web token self-heals** — a 401 while a token is stored now clears the
  token and drops to the in-app PairGate to re-pair, instead of looping forever on
  "reconnecting". The Cloudflare Access reload path is unchanged for that mode.

### Internal / foundation
- **Pluggable agent backend (Phase 1)** — the relay, every web route, the Telegram
  handlers, push, and history now run behind an `AgentBackend` interface; opencode
  implements it (zero behavior change). Adds `GET /api/capabilities` and a
  backend-id chip in the web titlebar. This is the groundwork for driving
  non-opencode agents over ACP (Kimi/Gemini/Cursor/Codex/Claude) without touching
  the card model or transports — see `docs/ACP_BACKEND_DESIGN.md`. Read-path
  verified against a live opencode hub. Only the event stream stays
  opencode-specific (Phase 2).

## v0.6.1 — 2026-06-12

Headline: **token auth works end-to-end** — pair a device and run the web PWA
without Cloudflare Access. Plus real app icons and PWA cache fixes.

### Added
- **Token auth, end-to-end** — the web app captures a pairing token (`#token=…`)
  on load, persists it to localStorage, strips it from the address bar, and
  attaches it to every API request (`Authorization: Bearer`) and WebSocket
  connect (`?token=`). Pairing now works **without Cloudflare Access**,
  completing the P2 goal of decoupling auth from CF Access.
- **Auto-detect the Cloudflare Tunnel hostname for `/pair`** — when
  `WEB_PUBLIC_URL` is unset, scan `~/.cloudflared/*.{yml,yaml}` for an ingress
  hostname mapped to the web port and emit that HTTPS URL instead of an
  unreachable LAN IP. Resolution order: `WEB_PUBLIC_URL` > cloudflared hostname >
  LAN IP > loopback.
- **Real PWA app icons** — replace the 1×1 placeholder icons with a rendered
  brand mark (rounded `any` + full-bleed `maskable` 512, apple-touch 180,
  favicon 48); add the missing favicon and an `apple-touch-icon` link. PWA
  `name`/`short_name` → `OCRC`.

### Fixed
- **Service worker precache no longer captures stale assets** — `addAll` honored
  the browser HTTP cache, so a precache could pin an asset still under a CDN
  `max-age` (icons showed mixed old/new generations). Each entry is now fetched
  with `cache: 'reload'`, straight from the network.

### Docs
- README / OPS: token-default auth, device pairing, and **remote access without
  a domain** (Tailscale, cloudflared quick tunnel, or SSH port-forward).

### Ops
- When fronting the PWA with a CDN (e.g. Cloudflare), add a **cache-bypass rule**
  for `/service-worker.js`, `/manifest.webmanifest`, `/icon-*`,
  `/apple-touch-icon.png`, `/favicon.png` so PWA updates propagate on `build` +
  restart without a manual purge. (Hashed `_app/*` assets keep long caching.)

## v0.6.0 — 2026-06-12

Headline: **multi-instance ready**. A single-machine fleet of opencode instances
now elects one PRIMARY to own the global web/Telegram singletons; the web/bot can
switch between workspaces; auth and public exposure are pluggable (no longer
Cloudflare-Access-only); and the web chat got a substantial UX pass.

### Added — Multi-instance foundation (P1)
- **PRIMARY election** (`src/core/primary-election.ts`) — atomic lock file
  (`~/.opencode/oprc-primary.lock`, `openSync(path,'wx')`) elects one instance to
  own the global web/Telegram singletons; others stand down PASSIVE. Stale-PID
  reclaim; lock released on construction failure or shutdown.
- **Cross-workspace global event stream** (`src/opencode/global-events.ts`) —
  `startGlobalEvents()` subscribes `client.global.event()` with reconnect, so the
  PRIMARY observes events from sibling workspaces over HTTP.
- Plugin entry gates web/bot on election; the per-instance `event` hook remains
  the in-worker dispatch source (the global stream does not deliver inside the
  plugin worker — see `docs/decisions/2026-06-12-cross-workspace-streaming.md`).

### Added — Pluggable connectivity & auth (P2)
- **Auth strategies** (`src/connectivity/auth/`) — `WEB_AUTH=token` (default) or
  `cf-access`. `TokenAuth` generates/persists an app token (0600 at
  `~/.opencode/oprc-token`), verifies HTTP + WS with `timingSafeEqual`. CF Access
  is now optional, decoupled from transport.
- **Exposure provider** (`src/connectivity/exposure/`) — `resolvePublicUrl()`
  prefers `WEB_PUBLIC_URL` > physical LAN > loopback.
- **Device pairing** (`src/connectivity/pairing.ts`) — `oprc pair` / `/pair`
  emit a QR + URL (token in the URL fragment) to onboard a device.

### Added — Workspace UX (P3)
- **Workspace switcher** — `GET /api/workspaces`, sidebar switcher; sessions
  filter to the active workspace.
- **Create session in a workspace** — `POST /api/session`; Telegram `/new`.
- **`/workspaces`** Telegram command lists known workspaces.
- **Custom commands in the web command palette** — `GET/POST /api/commands`
  run opencode custom commands against the active session (⌘K).
- **Session rename** — inline rename in the web sidebar +
  `POST /api/sessions/:id/rename` + Telegram `/rename`.

### Added — Web chat UX
- **Syntax highlighting** — highlight.js + marked-highlight; inline `` `code` ``
  renders green (file/command/path), fenced code blocks get full multi-color
  highlighting (keywords purple, functions yellow, classes cyan, numbers orange,
  comments gray, strings green).
- **GFM table rendering** — markdown tables now styled (borders, header band,
  zebra rows, horizontal scroll).
- **Top search box** — replaces the top-bar session ID; opens the command
  palette (sessions + commands), matching ⌘K.
- **Session status dots** — solid green = connected + recently active, blinking
  green = a turn is streaming, hollow gray = disconnected/inactive.
- **De-emphasized in-progress streaming** — thinking/streaming text renders
  smaller and gray; the finalized answer stays full-size.
- **Redesigned system cards** — compact status/approval/abort/info cards;
  approval buttons are filled (Allow / Always / Reject).
- **Enter-to-send** — Enter sends, Shift+Enter newlines (IME-safe).

### Fixed
- Restore the per-instance event hook as the in-worker dispatch source after P1
  routed dispatch through the global stream (which delivers zero events inside
  the worker) — this had broken web/Telegram message receipt and streaming.
- Adopt externally-initiated turns in the relay so TUI- and command-initiated
  turns stream to the web (previously dropped for lack of a session ctx).
- `theme.css` syntax colors were dropped because `:global()` is Svelte-only and
  invalid in plain CSS — rewrote the 25 hljs rules without it.
- Default `WEB_PORT` to `17081` (was `7081`, opencode 1.17's own server port).
- Telegram `ws:set` callback exceeded the 64-byte limit (short-token map);
  `notify` tool uses the tool context's `sessionID`.

### Docs
- `docs/decisions/2026-06-12-cross-workspace-streaming.md` — records that
  cross-workspace *streaming* is not supported with current opencode (worker SSE
  doesn't deliver; sessions are directory-bound). Accepted as a known limit.

---

## v0.6.0-rc.1 — 2026-05-31

### Added
- **Plugin Registry mode** — `npx opencode-remote-control install` deploys as
  opencode plugin; Telegram bot + Web PWA auto-start with `opencode`
- `src/plugin/entry.ts` — Plugin entry exporting `remoteControlPlugin: Plugin`
- `src/plugin/config.ts` — Plugin-mode config loader (openCode env + process.env)
- `src/cli/install.ts` — interactive/CI-friendly plugin installer (`--yes`, `--local`)
- `src/cli/uninstall.ts` — remove plugin from opencode config
- `rc-status` tool — status command visible in opencode TUI
- `relay.handleEvent()` — event-hook compatible event dispatch for Plugin mode
- `@opencode-ai/plugin` dependency
- `package.json` exports `./plugin`, `./install`, `./uninstall`

### Changed
- Relay deps: `eventStream` and `baseUrl` are now optional (Plugin mode compatible)
- Transport constructors: `baseUrl` and `eventStream` are now optional
- `ARCHITECTURE.md` — Plugin mode as primary deployment, sidecar as legacy
- `package.json` — removed `engines.node` restriction (Bun compatibility)

### Deprecated
- launchd deployment — replaced by Plugin auto-start
- `src/launcher/` — opencode itself is the launcher in Plugin mode
- `src/index.ts` legacy path — use `RC_MODE=legacy` to opt back in

## v0.5.7 — 2026-05-21

### Removed
- **Telegram streaming** — `renderStreaming()`, `renderThinking()`, `retryEdit()`,
  all throttling/chunking logic deleted. Telegram now delivers final result only
  via `sendMessage()`. Web transport keeps streaming unchanged.

### Fixed
- **SessionId mismatch with thinking card** — thinking card now published after
  `sessionId = resolvedId`, ensuring the sessionId in the card is always the
  correct resolved one. Early `setActiveAbort` restored for pre-submit abort.
- **Delta accumulation** — `message.part.delta` sends incremental text (not full).
  Relay now tracks `partTextAcc` Map per partId, appends deltas, and passes the
  full accumulated text to the accumulator. Root cause of truncated responses.
- **Empty text overwrite** — accumulator skips `text=""` updates when block
  already has non-empty text (SDK sends empty on some `part.updated` events).
- **TCP hang** — all sendMessage calls now have 10s timeout via `withTimeout()`/
  `sendTimed()`. Previously stuck connections hung forever.
- **429 retry_after cap** — capped at 5s; longer cooldowns force immediate
  fallback to sendMessage instead of prolonged retries.
- **push.ts fetchSummary race** — retries after 3s if first attempt returns empty
  (opencode persistence race on session idle).

### Changed
- **finalize() error handling** — catches all errors, logs them, and attempts a
  last-resort sendMessage with truncated text (3800 chars). Previously fatal
  errors silently dropped responses.
- **Thinking card** — no more `showStop` functionality (Stop button removed).
- **UI cleanup** — Stop button removed from thinking/streaming cards; Part N
  headers („·done“/„·streaming…“) removed; continuation shows just „⏳“.
- **sendInfo retries** — 3 attempts with 2s delay for ECONNRESET/ETIMEDOUT.

## v0.5.6 — 2026-05-20

### Fixed
- **Delta accumulation** — `message.part.delta` sends incremental text, not full text.
  Relay now tracks `partTextAcc` per partId, appends deltas to baseline, and passes
  the full accumulated text to the accumulator. This was the root cause of truncated/
  partial assistant responses in Telegram.
- **finalize() robust fallback**: `retryEdit()` now returns boolean. If Telegram
  edit fails, `finalize()` falls back to `sendMessage()` instead of silently
  dropping the response.
- **TCP hang protection**: all `sendMessage` and `editMessageText` calls now have
  10s timeouts via `withTimeout()` helper and `sendTimed()` wrapper method.
  Previously stuck TCP connections caused `retryEdit` and fallback `sendMessage`
  to hang forever.
- **push.ts timing race**: `fetchSummary()` retries after 3s if the first
  attempt finds no assistant message (opencode server may not have persisted it
  yet).

### Changed
- **Remove Stop button** — streaming/thinking messages no longer include ⏹ Stop
  inline keyboard.
- **Remove Part N headers** — pagination chunks no longer show `Part N · done` or
  `Part N · streaming…` prefixes. New continuation chunk shows just `⏳`.

## v0.4.0-rc.1 — 2026-05-16

### Added
- **Single-command launcher** — `oprc` (or `opencode-remote-control`) spawns
  opencode if needed, waits for health, then starts the bot. Handles
  SIGINT/SIGTERM clean shutdown of both processes.
- **Subprocess management** — `SPAWN_OPENCODE=true` auto-starts `opencode serve`
  with exponential backoff on crashes (2s→4s→8s→16s→30s), SIGTERM→SIGKILL
  fallback, and log capture to `LOG_DIR`.
- **Multi-user allowlist** — `ALLOWED_USER_IDS=a,b,c` accepts comma-separated
  Telegram user IDs. Backward-compatible with legacy `ALLOWED_USER_ID`.
- **TUI ↔ Bot state sync** — bot tracks the TUI's selected session and current
  agent in realtime via SSE events, with 5s polling fallback.
- **Info commands** — `/diff` (per-file patch preview), `/todo` (status markers ✓/▶/○),
  `/context` (agent, model, tokens, cost with next-override display).
- **Inline tool calls** — streaming cards show `▸ bash · cmd`, `▸ read · path`,
  `▸ grep · pattern` lines (configurable via `TOOL_CALLS_INLINE`).
- **Push notifications** — pushes to Telegram when: (a) a task runs >60s then
  finishes, (b) a test failure is detected in bash output. Rate-limited to
  10/hour with per-session 5min cooldown.
- **Inline Stop button** — all streaming/thinking cards include a ⏹ Stop button
  that immediately aborts the current generation.
- **Cost footer** — every assistant response shows `💰 $X.XX · ↑in ↓out · agent · model`.
  `/status` aggregates daily session costs.
- **Init wizard** — `npx -y opencode-remote-control init` interactively
  prompts for bot token, user IDs, and spawn preference, tests Telegram
  connectivity, writes `.env`.
- **CLI binary** — `oprc` (shortcut for `opencode-remote-control`).
- **Two-step `/model` picker** — select provider, then model; avoids
  Telegram's 4000-char message limit.
- **launchd plist + install/uninstall scripts** for macOS background service.

### Changed
- `/context` now shows pending next-agent and next-model overrides.
- `/help` and `setMyCommands` now include `/diff`, `/todo`, `/context`.
- Approval handler supports both v1 (`permission.updated`) and v2
  (`permission.asked`) event types with compatible field mapping
  (`title`↔`permission`, `permissionID`↔`requestID`, `response`↔`reply`).
- `.env.example` now documents `TOOL_CALLS_INLINE` and `PUSH_TEST_FAILURES`.

### Fixed
- Approve requests correctly push to Telegram bot regardless of opencode
  server version (v1 or v2 event schema).

## v0.3.0-rc.1 — 2026-05-16

### Added
- **SDK-native submission** — default path is now `client.session.prompt()`;
  TUI inject is optional (`TUI_VISIBLE=true`)
- **Transport abstraction** — `Transport` interface with `Card`/`Button` types;
  Telegram is the first implementation
- **Persistent state** — `data/state.json` stores `lastSessionId`, `nextAgent`,
  `nextModel` across restarts
- **Per-message agent/model override** — `/agent` and `/model` set sticky
  overrides applied to subsequent prompts (no more TUI cycle/picker)
- **New env vars** — `TUI_VISIBLE`, `STATE_PATH`, `TRANSPORT`
- **OSS docs** — `LICENSE` (MIT), `SECURITY.md`, public `README.md`,
  `docs/ARCHITECTURE.md`, per-transport docs
- **CI** — GitHub Actions workflow (`npm ci`, `npx tsc --noEmit`, `npm test`)
- **Issue/PR templates**

### Changed
- Restructured `src/bot/` → `src/core/` + `src/transport/telegram/`
- Moved `src/bot/reply.ts` → `src/transport/telegram/reply-stream.ts`

### Removed
- `src/bot/` directory and all its contents (replaced by new architecture)
- Obsolete unit tests for old handlers

## v0.2.0 — 2026-05-15

### Added
- `/files` command showing file operations from session messages
- `/session` pin/unpin with inline buttons
- Cardified commands (`/status`, `/start`, `/help`, `/current`)
- Callback handler framework

## v0.1.0 — 2026-05-14

### Added
- Initial MVP: Telegram bot relaying to local opencode TUI
- SSE event stream subscriber
- TUI inject submission path
- Approval flow with inline buttons
- launchd deployment
