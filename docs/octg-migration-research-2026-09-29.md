# 调研与迁移方案：生产 octg → ocrc

日期：2026-09-29 ｜ 性质：**只读调研**（未触碰生产：4096 未停、二进制未换、`~/.config/octg/` 与 A_bot token 未动）
红线状态：本文件是"单独议"的启动产出——**执行任何一阶段前仍需用户逐段拍板**。

## 0. 结论（TL;DR）

**可行，且比预期干净。** octg 的本质是"musl 兼容层 + opencode 1.18.28 + grinev 0.25.0 + bash 守护/自恢复"，
ocrc 以进程内插件替换的恰是 grinev 这一整层，**opencode 二进制、数据存储（978M 单库）、守护脚本全部可以保留**。
数据零迁移；切换窗口预期 **< 5 分钟**；回滚 = 恢复 grinev 进程行 + 删一个插件文件。

三个必须先解决的硬前提（都不难，但一个都不能少）：

1. **生产 4096 开着 HTTP Basic 密码**（实测 `/doc` 401，`www-authenticate: Basic`）。ocrc 的 raw fetch
   （skills/files/worktrees/questions/tui/SSE 全部直连 baseUrl）在带密码的服务器上会 401——**切前必须修**
   （方案：读 `OPENCODE_SERVER_PASSWORD` + 用户名，给 raw fetch 加 `Basic base64(user:pass)` 头，grinev 同款，见 §3.1）。
2. **1.18.28 端点面未验证**：ocrc 全部能力在 1.18.32 上活体验证；生产是 1.18.28。`/question`、
   `/experimental/worktree`、`/skill`、`/global/event`（含 question.* 只走全局流）这些必须在 1.18.28 上影子验证
   （§4 Phase 0，用生产同款二进制在隔离 HOME + 临时端口起影子实例——不碰生产）。
3. **getUpdates 独占冲突**：A_bot 的 Telegram polling 是独占的。切换窗口内 grinev 与 ocrc 插件若同时以
   A_bot token 轮询会互踢（409 循环）。切换顺序必须严格"先停 bot 腿，再让插件起"（§4 Phase 2）。

## 1. octg 全栈解剖（现状清单）

| 组件 | 位置 | 事实 |
|---|---|---|
| 定位 | `~/.octg/octg`（bash） | "OpenCode Telegram Group Instance Manager"：start/stop/restart/list/status/**restore**，多实例多端口（OCTG_PORTS=4096 4097） |
| 安装/升级器 | `~/.octg/setup.sh` | prompt_config / setup_shell / **setup_autorestore**（写 @reboot cron）/ **handle_upgrade**（检测旧配置+运行实例，可选停止）/ check_prerequisites；无版本锁定/回滚机制，升级=重跑覆盖 |
| 来源证明 | `~/.octg/provenance.json` | SLSA in-toto 证明（bin/opencode、bin/opencode.bin 的 sha256 subject） |
| opencode 二进制 | `~/.octg/lib/opencode`（经 `bin/opencode` 包装器） | **v1.18.28**；musl 二进制 + `lib/`（ld-musl、libstdc++、clear_ldpath.so）补丁 ELF interpreter 跑在 CentOS 7 老 glibc 上（loader 落 /tmp/.octg-ld/） |
| 生产实例 | pid 68580，`opencode web --port 4096 --hostname=0.0.0.0` | WORK_DIR=`/home/demo/develop/ate/WLG5144_dev/`；**带 OPENCODE_SERVER_PASSWORD（HTTP Basic）** |
| TG bot（grinev） | `@grinev/opencode-telegram-bot@0.25.0`，`~/.octg/bot/`，自带 node（~/.octg/node） | 进程：`node bot/dist/cli.js`；连接方式 Basic 密码 + A_bot token；数据仅 `bot-4096/{settings.json,logs}`（会话不在这里） |
| 守护 | `~/.config/octg/run-4096.sh` | while 循环：ss TCP 探活（免疫 401）→ 崩溃 5s 重启；**可接管已存在实例**；`.stop-4096` 文件优雅停机；SIGTERM 清理；区分主动杀/崩溃 |
| 自恢复 | crontab `@reboot sleep 60 && octg restore` | 开机 60s 后按 autorestore 快照拉起实例 |
| 实例状态 | `instance-4096.{env,pid}`、`config.env`（0600） | PORT/BOT_TOKEN/BOT_NUM/WORK_DIR/MODE/BOT_CONFIG_DIR/STARTED_AT |
| 第二实例 | `bot-4097/`（已配置未运行） | OCTG_PORTS 含 4097；ocrc 主备选举（PASSIVE）天然对应此场景，Phase 2+ 再议 |
| 生产数据 | `~/.local/share/opencode`（**978M**） | opencode.db + deep-memory/local-memory/memory + logs；**ocrc 进程内读同一库 → 数据零迁移** |
| 生产 opencode 配置 | `~/.config/opencode/`（AGENTS.md、MEMORY.md、command/、memory/、node_modules/） | **无 plugins/ 目录**（spike 历次安装全部隔离在 /tmp HOME，生产未污染） |

## 2. 组件映射：谁被谁替代

| octg 组件 | 命运 | 说明 |
|---|---|---|
| grinev 0.25.0（bot 进程 + A_bot 前端） | **被 ocrc 替代** | ocrc 插件内含 TG 传输（33+ 命令、流式、权限/问询、i18n 中文） |
| `~/.octg/bin/opencode-telegram` + `bot/` + `node/` | **退役**（保留磁盘不删） | 回滚时一键复活 |
| opencode 1.18.28 二进制 + musl 层 | **保留** | ocrc 要求 1.17+；1.18.28 待 Phase 0 端点验证。不换二进制=零风险 |
| `run-4096.sh` 守护 | **保留，删一行** | 它已支持"接管已有 opencode"；只需把 `opencode-telegram start &` 一腿去掉（或留空转），插件随 opencode 进程自动起 |
| `octg` 管理器 + @reboot restore | **保留** | start/stop/restore 语义不变（restore 拉起 opencode → 插件随之自起） |
| A_bot token | **迁移**（config.env `OCTG_BOT_TOKEN_1` → ocrc 配置） | 值不经聊天/文档；用 root 侧脚本搬运或用户手抄 |
| OPENCODE_SERVER_PASSWORD | **保留 + ocrc 必须学会用** | §3.1 |
| 生产数据 978M | **零迁移** | 同库同实例，插件进程内直读 |
| Web 面板 | **新增能力** | 插件起 4099（或另择端口）token 门 + QR 配对；生产首次需要跑一次 `ocrc` 配对流程 |

## 3. 切换前必须完成的代码工作（ocrc 侧预修复）

### 3.1 Basic 密码支持（阻塞项，~0.5d）
- `opencode-backend.ts` 的全部 raw fetch（skill/file/worktree/question/tui/global-event SSE）+ `selectTuiSession`
  增加 `Authorization: Basic base64(${OCRC_OC_USER ?? 'opencode'}:${OPENCODE_SERVER_PASSWORD})`，env 存在才附加。
- 插件进程由 run-4096.sh 拉起时该 env 天然在位（grinev 现在就是这么拿到的）。
- SDK client（ctx.client）是 opencode 自建的、自带鉴权——无需处理。
- 验证：影子实例带密码跑全套冒烟。

### 3.2 1.18.28 兼容性核验（Phase 0 一并做）
- 用生产同款 `~/.octg/lib/opencode`（经 bin 包装器）在**隔离 HOME + 临时端口（如 4599）**起影子实例，
  `GET /doc` 对比 ocrc 依赖端点：`/question*`、`/skill`、`/file*`、`/experimental/worktree`、`/global/event`、
  `/tui/select-session`、`/project`；重点：**question.* 事件是否同样只走 /global/event**（.32 上实证的行为，
  .28 若不同，M10 通路要加分支）。能力位探测已内建（capabilities 缺省即 UI 隐藏），风险可控。

### 3.3 生产参数落位
- ocrc 配置（web 端口选型：4099 现被 spike 占用是暂态；生产建议 web=4099、TG=A_bot）；
  `~/.ocrc/` 状态目录在真实 HOME 下初始化；通道粒度/工作区范围按用户偏好设置。

## 4. 迁移执行方案（批准后按此跑）

### Phase 0 — 影子验证（不动生产，~0.5d）
1. 隔离 HOME + 4599 端口 + 生产同款二进制起影子实例，完成 §3.2 端点/事件核验并出对照表。
2. 影子实例装 ocrc 插件，跑全套冒烟（TG 用 B_bot、web 用临时端口），含 Basic 密码场景。
3. 产出：兼容性对照表 + 需要的代码修复清单（回 §3.1 补齐）。

### Phase 1 — 预修复与演练（不动生产，~1d）
1. §3.1 密码支持合入、测试、发版（CI 流水线现成）。
2. **全流程演练**：在影子环境完整走一遍 Phase 2 的切换 runbook 两遍（含回滚一遍）。
3. 准备切换产物：插件桥接文件、ocrc 配置、A_bot token 搬运脚本（root 侧 cp，值不落文档/聊天）。

### Phase 2 — 切换窗口（动生产，用户指定时间，预期 <5 分钟）
前置：WLG5144_dev 无进行中任务；用户在场。
1. `octg`-语义停止 bot 腿：`touch ~/.config/octg/.stop-4096` 前先单独停 grinev 进程（或临时注释 run-4096.sh 的 bot 行 + kill bot pid）——**polling 停止是第一动作**（避免 getUpdates 互踢）。
2. 安装插件桥：`node <repo>/dist/cli/install.js`（或直接拷贝桥接文件）写入 `~/.config/opencode/plugins/ocrc.js` + `~/.ocrc/` 配置（A_bot token、allowed user、web 端口）。
3. 重启 opencode：`octg restart 4096`（守护脚本原样，opencode 进程带插件自起）。
4. 验证清单（每项必过）：4096 监听恢复 ✓ → 插件日志 `became PRIMARY` ✓ → A_bot polling ✓（发 hi 得回复）→ setMyCommands ✓ → web 4099 `/api/me` ✓ → 手机扫码配对 ✓ → 一个真实任务端到端 ✓。
5. 提交 autorestore 快照（octg restore 语义继续生效）。

### Phase 3 — 观察与收尾（1-3 天）
- 观察点：插件在 `opencode web` 模式下的长期稳定性（事件 hook、SSE 重连）、4099 暴露面（生产建议 bind 127.0.0.1 + 隧道，或维持 token 门）、grinev 磁盘退役（观察期满后可归档）。
- `run-4096.sh` 的 bot 腿正式注释/删除；`bot-4097` 二期再议（ocrc PASSIVE 备援或第二 A_bot）。

### 回滚（任意时刻，<3 分钟）
1. 杀 opencode 进程（或 `octg restart 4096` 前移走 `~/.config/opencode/plugins/ocrc.js`）。
2. 恢复 run-4096.sh 的 bot 腿（`opencode-telegram start &`）。
3. `octg restart 4096` → grinev+A_bot 原样复活（数据未动，无任何损失）。

## 5. 边界与不做

- 本轮**未执行**任何 Phase；生产四红线（不停 4096/不换二进制/不动 config.env 与 A_bot/不改 ~/.config/octg）继续有效直至用户对 Phase 2 放行。
- 不迁移/不触碰 deep-memory、memory、WLG5144_dev 项目内容。
- V2 宿主、4097 第二实例、多设备令牌表：均不在切换关键路径。
