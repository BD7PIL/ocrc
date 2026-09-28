# 调研与迁移方案 v2：生产 octg → ocrc（干净切换 · baseline 直升）

日期：2026-09-29（v2，吸收用户三项裁决）｜ v1 的只读调研事实仍然有效（octg 全栈解剖见 git 历史版本）

**用户裁决（2026-09-29）**：
1. **不做保守共存，直接升级 baseline**——生产 opencode 从 1.18.28 升到 ocrc 全量验证过的
   1.18.32（spike 运行多日的同款二进制），1.18.28 兼容性核验工作取消。
2. **完全清除 octg 存在的痕迹**——不留退役目录、不留 crontab、不留 bashrc 引用。
3. **不要外置守护**——不做 supervisor 脚本/崩溃自动重启/@reboot 拉起；生产启动 = 一行命令，
   崩溃 = 手动重启。插件内的传输级自愈（重试/守卫/选举）保留，进程级守护放弃。

## 0. 结论（TL;DR）

干净切换方案。好消息三连：**baseline 是 glibc 原生二进制**（实测 ldd 直链 /lib64，musl 兼容层
整层不需要）；**`opencode web` 模式 + Basic 密码下插件已活体验证**（影子实测：插件加载 ✓、
`/api/file-content` 密码 401→修复后返回正文 ✓、`/api/skills` 出真实数据 ✓）；**数据零迁移**
（同一存储库，插件进程内直读）。切换窗口预期 <5 分钟，回滚 = 归档倒放。

切换前唯一代码工作（**已完成**）：`OPENCODE_SERVER_PASSWORD` 的 HTTP Basic 支持（生产 4096
实测 401 + `www-authenticate: Basic`；grinev 同款 env 契约：`OPENCODE_SERVER_USERNAME` 默认
"opencode"）。已合入并通过单测 + 影子活体验证。

## 1. 目标态架构

| 角色 | octg 时代 | 切换后 |
|---|---|---|
| opencode 二进制 | `~/.octg/lib/opencode` 1.18.28（musl 包装） | `~/.local/bin/opencode` **1.18.32**（glibc 原生，无包装） |
| TG 前端 | grinev 0.25.0（独立进程 `node bot/dist/cli.js`，A_bot） | ocrc 插件（**进程内**，A_bot token 迁移） |
| 守护/自恢复 | run-4096.sh + `@reboot octg restore` | **无**（用户裁决）：`nohup opencode web … &` 一行；崩溃手动重启 |
| Web 面板 | 无 | 新增：4099，token 门 + QR 配对（pending-token 语义） |
| 数据 | `~/.local/share/opencode` 978M | **不变**（零迁移） |
| 管理器 | `octg` start/stop/restore | 退役（启动/停止一行命令见 §3） |

## 2. octg 痕迹清除清单（切换窗口内执行，先归档后删除）

| 痕迹 | 位置 | 动作 |
|---|---|---|
| 开机自恢复 | crontab `@reboot sleep 60 && octg restore …` | 删行 |
| shell 配置 | `~/.bashrc:34-35`（`source ~/.config/octg/config.env`） | 删两行 |
| musl 残留 | `/tmp/.octg-ld/`、`/tmp/etc/ld-musl-x86_64.path` | 删 |
| 安装树（533M） | `~/.octg/`（octg 管理器、setup.sh、provenance、bin/、lib/、**bot/（grinev）**、node/） | `tar` 归档至 `~/octg-archive-<date>.tar.gz` 后删除 |
| 运行配置（含 A_bot token、0600） | `~/.config/octg/`（config.env、run-4096.sh、instance-4096.*、bot-4096/、logs） | 同上归档后删除；**token 值先搬入 ocrc 配置，不经聊天/文档** |
| 旧二进制 | 归档内含 | 随归档 |

**迁移前置勘误（本项目发现）**：插件会按优先级加载 `PLUGIN_ROOT/.env`（仓库/全局包目录）
**高于** `OPENCODE_CONFIG_DIR/.env`（`override:false` 先到先得）——影子实测被开发期遗留的
仓库 `.env` 劫持过 bot 身份。npm 全局安装无此文件（tarball 不含 `.env`）；**若从源码克隆安装，
必须先删克隆目录里的 `.env`**。

## 3. 切换 runbook（窗口 <5 分钟，每步有验证点）

前置：用户在场；WLG5144_dev 无进行中任务；ocrc 已发布含 Basic 支持的版本（0.11.0+）。

1. **停 grinev（第一动作——A_bot polling 独占，防互踢）**：kill `node …/bot/dist/cli.js` 进程；
   验证：`ps` 无 bot 进程；spike/其他实例无 409 冲突日志。
2. **装新二进制**：官方 1.18.32 release（或 sha256 对齐我们验证过的 baseline）→ `~/.local/bin/opencode`；
   `opencode --version` 输出 1.18.32。
3. **装插件**：`npm i -g @bd7pil/ocrc && ocrc install`（写 `~/.config/opencode/plugins/ocrc.js`
   + `~/.ocrc/` 配置；A_bot token 与 allowed user 从 octg 归档搬运，值不落文档）；
   生产 env：`OPENCODE_SERVER_PASSWORD` 沿用原值（新 server 仍要密码——0.0.0.0 绑定不能裸奔）。
4. **启动**：`cd /home/demo/develop/ate/WLG5144_dev && nohup ~/.local/bin/opencode web --port 4096 --hostname=0.0.0.0 >> ~/.config/ocrc/prod.log 2>&1 &`
5. **验证清单**：4096 LISTEN ✓ → 带密码 `/doc` 200 ✓ → 插件日志 `became PRIMARY` ✓ →
   A_bot polling ✓（发 hi 得回复）→ setMyCommands ✓ → web 4099 `/api/me` ✓ → 手机扫码配对 ✓ →
   一个真实任务端到端 ✓ → `/api/skills`（Basic 下 raw fetch）非 401 ✓。
6. **清除痕迹**：按 §2 清单逐项执行（先归档后删）。

回滚（<3 分钟）：杀新进程 → 删 `~/.config/opencode/plugins/ocrc.js` → 解档 `octg-archive` 回
`~/.octg` 与 `~/.config/octg` → 恢复 bashrc/crontab 两处 → `run-4096.sh` 原样复活（数据未动）。

## 4. 已完成的功能补齐（本次交付）

- **Basic 密码支持**：`ocFetch` 包装全部 13 处 opencode 直连 fetch（backend 11 + question SSE +
  opencode-config），无密码时调用形状与改动前逐字节一致（ spike 行为零变化）；
  单测 6 例（头构造/用户名覆盖/无密码不加头/POST 头保留）+ 影子活体验证（401→200）。
- **`opencode web` 模式插件加载**：影子实证（此前只验过 `serve` 模式）——生产启动模式不变。
- **影子测试顺带发现并记录**：`.env` 劫持坑（§2 勘误）。

## 5. 边界

- 无外置守护 = 宿主崩溃需手动拉起；插件 bug 导致的崩溃循环的紧急路径 = 删桥接文件 + 重启。
- 4097 第二实例、单设备令牌吊销（设备表）、grinev 独有功能（知识库 @ 引用、TTS/STT）：
  均不在本次范围，按需另立。
- 生产四红线在用户对切换窗口放行前继续有效。
