# Operations Guide

> ocrc 运维手册，对齐 **v0.26.5** 现状（npm 包 `@bd7pil/ocrc`、`ocrc start`
> 生命周期、SSH remote hosts）。架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安装

```bash
npm i -g @bd7pil/ocrc     # npm 上的 opencode-remote-control 是无关包，别 npx
ocrc install              # 交互：Telegram bot token + user id（可留空 → web-only）
ocrc start /path/to/your/project
```

要求：Node 20+，opencode 1.17+（生产验证至 1.18.32，EL7/glibc 2.17 是硬边界）。
`ocrc install` 写插件桥到 `~/.config/opencode/plugins/ocrc.js`、配置到仓库 `.env`
（0600）。从源码跑：`npm install && npm run build:all`，CLI 入口 `node dist/cli/index.js`。

## 生产生命周期（supervisor 内建）

```bash
ocrc start <dir>    # spawn 自身 --supervisor（detached），adopt-or-spawn
ocrc status         # binary / server / supervisor / web panel / workdir
ocrc stop           # 先 TERM supervisor，再实例；15s 后 SIGKILL 兜底
ocrc restart [dir]  # stop + start
ocrc restore        # 读 ~/.ocrc/run/last.json 幂等复活（@reboot cron 用）
```

语义（cli/service.ts）：
- **崩溃自愈**：子进程 SIGKILL/段错误/OOM 都视为崩溃，5s 后重启
  （`OCRC_WATCH_DELAY` 可调）；SIGTERM/SIGINT 或 stop 文件 = 真停。
- **adopt**：端口已被占用时收编现有实例而不是双起。
- 开机自启（opt-in）：`@reboot sleep 60 && ocrc restore >> ~/.ocrc/prod.log 2>&1`
- 日志：`~/.ocrc/prod.log`（supervisor/实例 stdout）+ `~/.ocrc/ocrc.log`
  （应用日志，10MB 轮转）。

## Standalone host（可选，多后端）

```bash
OCRC_BACKENDS="opencode, kimi=kimi acp" ocrc host
```

独立进程（非插件），ACP agent 需先登录（如 `kimi login`）；opencode 后端由
host 自 spawn（4096 起，被占则向后探测 10 个）。ACP 会话持久化在
`~/.ocrc/acp-sessions.json`。前台进程，崩溃不自启——生产建议 plugin 模式。

## SSH remote hosts（0.26+）

Web 面板 Inspector → **Remotes** 卡片（API：`/api/remotes`）：

| 操作 | 路由 | 说明 |
|---|---|---|
| 注册/编辑 | `POST/PATCH /api/remotes[/:id]` | host/port/user/remotePort；密码自动生成（0600 存储，API 永不回显） |
| 探测 | `POST /api/remotes/:id/inspect` | 一轮 ssh：平台/glibc/opencode 路径+版本/凭据/端口 |
| 安装 | `POST /api/remotes/:id/provision` | 官方安装器 pin 本地版本；无外网回退 scp 本地二进制 |
| 同步凭据 | `POST /api/remotes/:id/sync-auth` | 复制本机 `~/.local/share/opencode/auth.json`（0600） |
| 启停 | `PATCH /api/remotes/:id` `enabled` | 启动 = 隧道+serve 一个 ssh 进程；删除两步确认 |

状态机：`unknown → detecting → provisioning → launching → online`，异常态
`needs-auth / error / offline / disabled`；面板轮询 GET /api/remotes 看
`status.logTail`（ssh 输出 200 行环）。远端默认端口 4199（避开用户自己的
4096 serve）。注册生效需重启实例（channels 同款语义，UI 已标注）。

添加主机走**四步向导**（选择方式 → 填写配置 → 连接中 → 完成）：向导自动
探测 → 缺装则部署 → 启动隧道 + serve → 等待在线；「连接中」页实时展示
部署/隧道日志。

## 企业内网场景（air-gapped / 中转）

三件事，两件配置一件免费：

**A. LLM 请求经企业代理出网**（向导「企业代理」字段组，存 remotes.json 0600）：
- `HTTP_PROXY` / `HTTPS_PROXY`：注入远端 serve 进程（大小写双份）。
- `NO_PROXY`：留空自动设为 `127.0.0.1,localhost`；自定义时也会**强制追加**
  这两项——隧道与 ocrc→serve 的回环流量绝不能被企业代理劫持。
- `CA 证书路径（远端）`：远端信任企业网关的 MITM 证书（`NODE_EXTRA_CA_CERTS`）。
- 模型网关：opencode provider 支持 `options.baseURL` 覆盖——把被控端
  `opencode.json` 的 provider 指向企业 LLM 网关，随 **同步配置** 推过去即可。

**B. 控制通道走跳板**：零开发。`~/.ssh/config` 配 ProxyJump，ocrc 用系统 ssh
自动继承：

```
Host airgapped-01
    HostName 10.20.0.11
    ProxyJump bastion.corp
```

**C. 离线安装**：远端无外网时 provision 自动回退为 **scp 本地二进制**
（同一官方 artifact、平台匹配、pin 本机版本；跨架构会被拒绝）。向量导的
「连接中」日志里看 `falling back to scp` 字样。

凭据同步（`sync-auth`）与配置同步（`sync-config`）都走 ssh 通道，不依赖
公网；代理 URL 含凭据时面板脱敏显示。

## 公网访问（手机 PWA 需 HTTPS）

Web 默认 `0.0.0.0:4099`（token 门禁）。PWA 安装需要安全上下文：

| 方式 | 命令 | 说明 |
|---|---|---|
| LAN 明文 HTTP | `http://<lan-ip>:4099` | 浏览器可用；装 PWA 需 HTTPS |
| Tailscale | `tailscale serve 4099` | 稳定 `*.ts.net`，设备级认证 |
| cloudflared | ingress `service: http://localhost:4099` | 稳定域名；改后 `kill -HUP <pid>` 热重载 |
| cloudflared 快速隧道 | `cloudflared tunnel --url http://localhost:4099` | 免费，URL 轮换；配 `OCRC_WEB_PUBLIC_URL` |

配对：`ocrc pair` / TG `/pair` / 首次打开面板的 onboarding 页。链接带
**1 分钟一次性 pending token**（`#pair=`），设备端换取正式 token；正式 token
持久化在 `~/.ocrc/token`，轮换 = 删文件重启。**隧道后严禁**
`OCRC_WEB_CF_ACCESS_DEV_BYPASS=true`（cloudflared 从 127.0.0.1 连入，等于对
全网免认证）。

## 环境变量（`~/.ocrc/config.env` 或 `.env`，0600）

| 变量 | 默认 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` / `ALLOWED_USER_IDS` | — | TG 通道；两者必须成对，留空 = web-only |
| `OCRC_WEB_ENABLED` / `_HOST` / `_PORT` | `true` / `0.0.0.0` / `4099` | fork 默认 LAN-first（legacy `WEB_*` 名仍兼容） |
| `OCRC_WEB_AUTH` | `token` | 或 `cf-access`（需 TEAM+AUD） |
| `OCRC_WEB_PUBLIC_URL` | 自动探测 | cloudflared ingress → LAN IP → loopback |
| `OCRC_SERVER_PORT` / `OCRC_SERVER_BIN` | `4096` / `~/.local/bin/opencode` | `ocrc start` 用 |
| `OCRC_WATCH_DELAY` | `5`（秒） | 崩溃重启延迟 |
| `OPENCODE_SERVER_PASSWORD` | — | 服务端开了 Basic 认证时，所有裸 fetch 自动附带 |
| `CHAT_TIMEOUT_MS` | `600000` | 单轮超时 |
| `TG_CHUNK_SOFT_LIMIT` | `3500` | TG 分页软限 |
| `LOG_LEVEL` | `warn` | 只写文件（stdout 会污染 TUI） |
| `OCRC_LOCALE` | `zh` | TG i18n（en 兜底） |
| `OCRC_BACKENDS` / `OCRC_ACP_CMD` | — / `kimi acp` | 仅 standalone host |
| `OCRC_OFFPEAK_WINDOW` | `00:00-08:00` | 闲时工单派发窗口（`HH:MM-HH:MM`，start>end 表示跨午夜） |

## 目标循环（N12 goal）——运维要点

- **状态在哪**：`~/.ocrc/state.json` 的 `goals` 槽位（按 sessionId）。删会话会连带清掉；
  `POST /api/goal {action:'clear'}` 或 TG `/goal clear` 单清。
- **重启行为**：host 启动时把**所有 active 目标落成 `paused`**（绝不自动拉起——上游同款
  冷恢复语义）。用户 `resume` 才续跑；状态、迭代计数、用量与验收历史都不丢。
- **验收器**：一次独立子会话调用（`promptOnce`：建子会话 → 带 `tools` 禁用写类工具发一次
  prompt → 读回复 → 删子会话）。**fail-closed**：坏 JSON / 调用失败 / 空回复一律停机并通知，
  不判"通过"。**残余风险**：工具名空间无法枚举，`tools` map 只能禁已知写类工具（write/edit/
  multiedit/patch/bash/task/todowrite），叠加提示词里的"不要调用工具"约束；证据窗口有界
  （~8k 字符），超长会话可能"证据不足"→ 同样停机通知（宁可停，不误判完成）。
- **三条硬闸**：token 预算（上游有）、迭代上限 12、无进展检测（连续 2 轮同 nextAction）
  ——后两条是本项目新增。撞闸 = `paused` + 一张 info 卡（TG 与 /z/ 都收得到）。
- **成本**：每回合末一次验收调用（一个子会话，约等于一次短问答）。不想要就 `/goal clear`。
- **关停**：host `dispose()` 会先 `goalManager.stop()` 再拆传输——停机时不会有续跑派发进已拆的
  relay。

## 诊断速查

```bash
ocrc status                                          # 一眼看全
tail -f ~/.ocrc/ocrc.log                             # 应用日志（LOG_LEVEL=debug 更细）
curl -s -H "Authorization: Bearer $(cat ~/.ocrc/token)" \
  http://127.0.0.1:4099/api/logs | tail              # 应用内日志环（500 行）
curl http://localhost:4096/global/health             # opencode 健康
ss -ltnp | grep -E '4096|4099'                       # 端口占用
```

WS 上下文零帧/配对失败等前端问题：浏览器 DevTools → Application → Service
Workers → Unregister（别用 Clear site data，会连 localStorage 的 token 一起清）。

## 构建与测试（源码开发）

```bash
npm install && npm run build:all   # tsc + web-next（vite build）
npm test                           # 后端 vitest（733 例）
npm run typecheck
cd web-next && npm test            # /z/ 桥接 vitest（161 例）；npm run typecheck

# 隔离 dev 实例（4199）——AGENTS.md 有完整命令；scripts/spike-restart.sh 是 4598
# 遗留脚本，误跑会拉起同 token 的竞争实例把隔离 host 顶死（Telegram 409）。
```

> 本地 vitest 不编译 web 的全部组件——CI 才是完整门禁（历史上两次构建错误只有
> CI 抓到）。
