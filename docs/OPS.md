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
npm install && npm run build:all   # tsc + web（vite build → web/dist）
npm test                           # 后端 vitest（505 例）
npm run typecheck
cd web && npm test                 # web vitest（131 例）；npm run check = svelte-check
bash scripts/spike-restart.sh      # 隔离 dev 实例（绝不触碰生产实例）
```

> 本地 vitest 不编译 web 的全部组件——CI 才是完整门禁（历史上两次构建错误只有
> CI 抓到）。
