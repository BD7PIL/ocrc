# ocrc — remote control for opencode

> **Drive your local opencode from your phone or browser** — a Telegram bot
> plus a scan-to-pair Web PWA, running as an **in-process opencode plugin**.
> One install; both surfaces stream the same live sessions.

[![Release](https://img.shields.io/github/v/release/BD7PIL/ocrc?color=10b981)](https://github.com/BD7PIL/ocrc/releases)
[![License: MIT](https://img.shields.io/github/license/BD7PIL/ocrc?color=10b981)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/BD7PIL/ocrc/ci.yml?branch=main&label=CI)](https://github.com/BD7PIL/ocrc/actions)
[![tests](https://img.shields.io/badge/tests-479%20backend%20%2B%20120%20web-10b981)](CHANGELOG.md)

A fork of [agentjoey/opencode-remote-control](https://github.com/agentjoey/opencode-remote-control)
(MIT); the Telegram interaction model is inspired by
[@grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot).
Full attribution in [NOTICE](NOTICE). npm `@bd7pil/ocrc` · config `~/.ocrc/` · CLI `ocrc`.

<p align="center">
  <img src="docs/assets/ocrc-web.png" width="840" alt="ocrc — the Web PWA driving a live opencode session (sessions, live chat, task & cost inspector)">
</p>

## What it is

- **One process.** The plugin loads inside opencode — no daemon, no extra
  services. Telegram and the Web PWA start with opencode and die with it
  (an optional supervisor is available, see [Lifecycle](#lifecycle)).
- **Two surfaces, one session.** Prompts in from either side; streaming
  output, tool calls, diffs, todos, costs mirror to both in real time.
- **Local-first, single-user.** Runs on your machine against your local
  opencode server. One allowlisted Telegram user; the web panel is gated by a
  device token. No cloud, no shared backend.
- **Honest channel status.** Telegram and Web are implemented and stable.
  Feishu / WeChat have a configuration panel pre-wired but the transports
  themselves are **not implemented yet**.

## Quick start

Requires **opencode 1.17+** (verified on 1.18.32) and **Node 20+**.

```bash
# 1. Install
npm i -g @bd7pil/ocrc
ocrc install          # interactive: Telegram bot token + your user id
                      # (the `opencode-remote-control` name on npm is an
                      #  unrelated package — don't npx it)

# 2. Start (supervised: crash auto-restart)
ocrc start --watch /path/to/your/project

# 3. Talk to it
#    Telegram: send "hello" to your bot
#    Web:      open http://<host>:4099 and pair (see below)
```

Upgrades: `npm i -g @bd7pil/ocrc@<version>` + restart. The opencode binary
itself is yours to manage (`opencode upgrade <version>` — pin the version).

## Pairing a device

Web access is gated by a device token. Two ways to pair — **Telegram is not
required**:

1. **From the host terminal** (works always, no Telegram):
   ```bash
   ocrc pair        # prints a QR + link — scan or open on the device
   ```
2. **From Telegram** (once the bot is running): send `/pair`, open the link.

Links carry a *pending* token — valid **1 minute, single use**, and issuing
a new one invalidates the old (refresh = new code). The device exchanges it
for the real access token on first open; the token never appears in a URL
again. Already-paired sessions can onboard further devices from the web
panel's QR (机器人面板 → 配对新设备).

## Lifecycle

```bash
ocrc start <dir>             # start (detached, no supervision)
ocrc start --watch <dir>     # start under the supervisor (recommended)
ocrc status                  # server / watcher / web panel at a glance
ocrc stop                    # graceful stop (watcher first, then the instance)
ocrc restart [dir]           # restart, keeping the current mode
ocrc restore                 # re-launch the last instance under --watch
```

`--watch` is a foreground supervisor with octg-proven semantics: adopts an
already-running instance, restarts the child after a crash (default 5 s,
`OCRC_WATCH_DELAY`), and treats SIGKILL / segfaults as crashes — an OOM kill
self-heals. SIGTERM or the stop file means "stop for real". Boot-time
recovery is opt-in:

```
@reboot sleep 60 && ocrc restore >> ~/.ocrc/prod.log 2>&1
```

## Telegram

~34 commands, grouped: sessions (`/sessions /session /new /rename /workspaces
/projects /cleanup`), running work (`/skills /ls /open /worktree /diff /todo
/context /subs`), controls (`/agent /model /mode /task /tasks /tasklist
/taskdel /mcps /commands /messages /detach`), ops (`/start /status /version
/pair /channels /help`), plus `/abort` and plain text relay. Send any text to
drive the agent; approvals and interactive questions arrive as buttons.

## Web panel

PWA (installable), token-gated, with a live inspector per session: todos,
MCP servers, schedules, usage/cost, context, working-dir diff, skills, file
browser, worktrees — plus a floating plan HUD for subagent jumps. The bot
channels panel configures reply granularity, workspace scope, and shows the
pairing QR.

## Remote access

The web binds `0.0.0.0:4099` by default (token-gated). For a PWA install you
need a secure context:

| Method | Command | Notes |
|---|---|---|
| **LAN, plain HTTP** | open `http://<lan-ip>:4099` | Works in-browser; PWA install needs HTTPS |
| **Tailscale** | `tailscale serve 4099` | Stable `https://<host>.ts.net`, device auth |
| **cloudflared** | `cloudflared tunnel --url http://localhost:4099` | Free, URL rotates; set `OCRC_WEB_PUBLIC_URL` |

## Security model

- One allowlisted Telegram user; web devices hold a token generated at first
  start (persisted `0600` at `~/.ocrc/token`), verified with constant-time
  compare on HTTP and WS.
- Pairing QR links carry a pending token (5 min, single use) — never the
  permanent credential.
- If the opencode server itself runs with `OPENCODE_SERVER_PASSWORD`, ocrc
  authenticates its server calls with HTTP Basic (same env, no extra config).
- No cloud. Everything stays on the machine except Telegram API traffic.

## Configuration

Settings live in `~/.ocrc/config.env` (`0600`; `KEY=VALUE`). Highlights:

| Key | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required for the Telegram surface |
| `ALLOWED_USER_IDS` | — | comma-separated Telegram user ids |
| `OCRC_WEB_ENABLED` | `true` | web panel on/off |
| `OCRC_WEB_PORT` | `4099` | web panel port |
| `OCRC_WEB_HOST` | `0.0.0.0` | bind address |
| `OCRC_SERVER_PORT` | `4096` | opencode server port (lifecycle commands) |
| `OCRC_SERVER_BIN` | `~/.local/bin/opencode` | binary used by `ocrc start` |
| `OCRC_WATCH_DELAY` | `5` | supervisor restart delay (s) |
| `OPENCODE_SERVER_PASSWORD` | — | enables HTTP Basic for server calls |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Legacy `WEB_*` names are honored as fallbacks. Full list:
[`docs/OPS.md`](docs/OPS.md).

## Architecture

```
┌────────────────────────────────────────────────────┐
│  opencode (single process)                          │
│                                                     │
│  ┌─────────────────┐  ┌──────────────────────────┐ │
│  │ AI engine :4096 │  │ plugin: ocrc              │ │
│  │                 │  │  ├─ grammY (Telegram)     │ │
│  │  event hook ────┼──┼─►├─ Hono + WS (Web PWA)  │ │
│  │                 │  │  └─ relay + CardBus       │ │
│  └─────────────────┘  └─────────┬────────────────┘ │
│                                 ▼                   │
│                        Telegram / Web (PWA)         │
└────────────────────────────────────────────────────┘
```

Deep dive: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Development

```bash
npm install && npm run build:all     # plugin + web
npm test                             # backend (vitest)
cd web && npm test                   # web (vitest)
bash scripts/spike-restart.sh        # isolated dev instance (never touches prod)
```

## Credits & license

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE): forked from
[agentjoey/opencode-remote-control](https://github.com/agentjoey/opencode-remote-control);
Telegram UX model from [@grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot).
