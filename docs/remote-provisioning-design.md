# Remote provisioning 设计 — 把「你的 opencode 环境」带到远端

> 状态：设计文档（2026-10-05）。§1-2 是对 ZCode SSH/WSL 远程连接机制的逆向
> 结论（证据：本机 `~/.zcode/server/zcode-server.cjs` v0.26-era bundle 的符号
> 级 grep + 本机运行时文件）；§3-4 是 ocrc 的对照与实施方案。
> 相关代码：`src/core/remote-host.ts`、`src/core/remotes.ts`、
> `src/transport/web/routes/remotes.ts`。

## 1. ZCode 是怎么做的（bundle 证据）

**部署（deploy-on-connect）**
- 资源包清单 `REMOTE_RESOURCE_PACKAGE_IDS = ["server-bundle","node-runtime",
  "node-pty","glm","bfs","ripgrep","ugrep"]`（bundle:180749），必装仅
  server-bundle + node-runtime；版本按 sha256 pin；两种安装模式
  `local-download-upload` / `remote-download`（:180677）。资源缓存在
  `.zcode/server/asset-cache/components/<platform>/`。
- "glm" 包 = agent 运行时 + zcode-agent + bundled-skills + plugins。

**LLM 凭证：复制，不是代理**
- 本地 `providerProvisioningSource.read(syncId)` 解密
  `~/.zcode/v2/credentials.json`（AES-256-GCM `enc:v1:`，密钥 =
  sha256(`ZCODE_CREDENTIAL_SECRET` env 或 platform:homedir:username 回退，
  bundle:202588）；
- 按白名单取键（oauth:zai/bigmodel token、zcodejwttoken、
  `account-provider:*:api-key`，:270612）组 envelope；
- 远端 `providerProvisioningTarget.apply()` 以 syncId 幂等（状态文件
  `runtime/provider/provisioning.json`），在远端**重新加密落盘**自己的
  credentials.json + 更新 provider_config/setting，失败自动回滚
  （:247715-247900）；触发时机含 `environment-online`（:180814）＝远端一上线
  就推。本机 `~/.zcode/v2/runtime/provider/provisioning.json` 有 2 条 applied
  记录（credentialCount:6）——**远端持有 key**。

**MCP / 插件 / skills：用户选择性「本地导出 → 远端导入」，不覆盖**
- skills：扫 `~/.zcode/skills` + `~/.agents/skills` 打 archive（≤20MB）导入
  远端同名根目录（:252116）；
- plugins：读 `~/.zcode/plugins` + `~/.zcode/cli/config.json`，支持
  marketplace 源镜像（≤50MB，:253469）；
- MCP：读 `~/.zcode/cli/config.json`(mcp.servers) / `~/.agents/mcp.json`，
  export → import 写远端用户目录（0600，:252540）；
- 三者都有 `listRemoteUser*Statuses` / `checkRemoteUser*WriteAccess`（远端执行）。
- **agent 配置（subagents/commands/hooks/output-style）没有 SSH 同步通道**
  （ServiceChannels :190600 区只有 SkillSync/McpSync/PluginSync）。

**通道与生命周期**
- ssh/wsl/docker 目标走 **stdio RPC，无 TCP 隧道**：远端跑 `entry-stdio`，
  stdout 发 `zcode-hello{version,platform,arch,pid}`，10s 内等 ack；
  `ZCODE_SERVICE_AUTHORITY_MODE=desktop-attached-remote`（:278128-278160）。
  仅 "server" 目标才用 URL+token 的 websocket。
- 远端进程随连接存亡：stdin 关闭 → 逐服务 dispose → 杀 agent 进程树 → exit
  （:271703）。**远端文件不清理**——资源包/凭证常驻远端 `~/.zcode`。
- WSL 目标只有 {distro,user}（经本机 wsl.exe），无资源包选择；SSH 目标支持
  sshConfigAlias、密码/口令经 credentialKey 引用加密凭证库（:188050）。
- SSH spawn/上传编排在 Desktop 客户端，不在本 bundle。

## 2. ocrc 现状（0.26.5）与对照

| 维度 | ZCode | ocrc 现状 | 差距 |
|---|---|---|---|
| 远端运行时 | 自家 server bundle + node 运行时，sha pin | **官方 opencode 安装器，pin 本地版本**；无外网 scp 本地二进制（remote-host.ts provision） | 无（理念一致：一个版本家族） |
| LLM 凭证 | AES-GCM 解密→白名单→远端重加密落盘，上线即推 | `sync-auth`：scp `auth.json`（0600）——opencode 的凭证本来就是明文 JSON 文件，语义等价 | 无（手动触发 vs 自动推送；见 §4 备注） |
| skills / MCP / agent 配置 | 选择性导出导入，不覆盖 | **无** —— 远端 opencode 读它自己的 `~/.config/opencode` | **本轮补** |
| 插件 | marketplace 镜像 | 无（且刻意不传 ocrc 自身的 plugin 桥——远端 opencode 不需要被控端） | 维持 |
| 通道 | stdio RPC（无隧道） | `ssh -N -L` TCP 隧道 + HTTP Basic（opencode 只讲 HTTP，隧道保证远端端口不出机器） | 形态不同，合理性等价 |
| 生命周期 | 进程随连接存亡，文件常驻 | ssh 进程即一切（死了全死，2s→60s 退避重生）；文件常驻 | 无 |
| WSL | 独立 target（wsl.exe） | 无（SSH 已覆盖 WSL 上跑 sshd 的场景） | 不补（用户群是 Linux 服务器） |

**scope 结论**：这套东西不越界。ocrc 的核心（relay/CardBus/transports）是
host 无关的，`ocrc start/host` CLI 与 supervisor 本来就是插件形态之外的合法
组成；「remote control for opencode」的产品语义天然包含「把环境带过去」。
真正的边界线在：不做成通用机器管理产品（不碰系统包管理、不做文件同步盘）。

## 3. 本轮实现：`syncConfig(id)`（最小版）

对齐 ZCode 的「不覆盖、可回滚」语义，复用 remote-host.ts 现有 ssh 通道：

- **白名单**（本地 `~/.config/opencode/`，可被 `OPENCODE_CONFIG_DIR` 重定向）：
  `opencode.json`、`AGENTS.md`、`CLAUDE.md`、`command/`、`agent/`、`plugin/`
  **除外**（远端不需要 ocrc 自身）、`skill/`（若存在）。MCP 配置在
  `opencode.json` 的 `mcp` 段内，随主文件走。
- **传输**：`tar -cz` 白名单子集 → `ssh <target> 'tar -xz'` stdin 管道（与
  sync-auth 的 stdin 模式一致，零新依赖）。
- **冲突语义**：远端已存在的同名文件**先备份为 `*.ocrc-bak` 再写入**；
  tar 导入前先跑一轮远端检测（`checkRemoteUser*WriteAccess` 的 ocrc 版：
  目录可写性 + 现有清单回显），结果报告在面板日志抽屉里。
- **API**：`POST /api/remotes/:id/sync-config`（502 失败语义同 inspect/
  provision）；RemotesPanel 加「同步配置」按钮。
- **测试**：白名单收集、tar 参数形状、冲突备份命令构造、0600 权限断言。

## 4. 后续可选项（本轮不做，记录取舍）

- **凭证自动推送**（对齐 ZCode 的 environment-online）：remote 状态机进入
  online 时自动跑一次 sync-auth + syncConfig。风险：把凭证分发变成隐式行为；
  ZCode 用 syncId 幂等 + 回滚兜底，ocrc 若做需同等级别。维持显式按钮。
- **导出预览/选择性同步**（ZCode 的 listRemoteUser*Statuses）：白名单小、
  全量 <1MB 时收益低；等配置膨胀再做。
- **反向同步**（远端 → 本地）：无需求，不做。
