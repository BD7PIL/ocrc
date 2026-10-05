# ocrc — remote control for opencode

> **Drive your opencode from your phone or browser** — a Telegram bot plus a
> scan-to-pair Web PWA. One install; both surfaces stream the same live
> sessions, tool calls, diffs and costs in real time.

[![Release](https://img.shields.io/github/v/release/BD7PIL/ocrc?color=10b981)](https://github.com/BD7PIL/ocrc/releases)
[![License: MIT](https://img.shields.io/github/license/BD7PIL/ocrc?color=10b981)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/BD7PIL/ocrc/ci.yml?branch=main&label=CI)](https://github.com/BD7PIL/ocrc/actions)
[![tests](https://img.shields.io/badge/tests-591%20backend%20%2B%20140%20web-10b981)](CHANGELOG.md)

npm `@bd7pil/ocrc` · config `~/.ocrc/` · CLI `ocrc`. Works against a local
opencode (verified on 1.18.x, RHEL7/glibc 2.17 included) — no cloud, no
shared backend.

<p align="center">
  <img src="docs/assets/ocrc-web.png" width="840" alt="ocrc — the Web PWA driving a live opencode session (sessions, live chat, task & cost inspector)">
</p>

## What it is

- **Two surfaces, one session.** Prompts in from Telegram or the browser;
  streaming output, tool calls, approvals and questions mirror to both.
- **Local-first, single-user.** Runs on your machine against your opencode.
  One allowlisted Telegram user; the web panel is gated by a device token.
- **Remote hosts built in.** Drive opencode on other machines over SSH —
  detection, provisioning, tunneling and credential sync are automated
  (enterprise proxies supported), and remote turns appear in the same
  Telegram/Web pipeline as local ones.
- **Honest channel status.** Telegram and Web are implemented and stable.
  Feishu / WeCom / DingTalk have a configuration panel pre-wired but the
  transports themselves are **not implemented yet**.

## Two ways to run

| | **Plugin mode** | **Host mode** |
|---|---|---|
| Command | opencode loads the npm plugin | `ocrc host` (standalone) |
| Process | inside opencode — no daemon | own process; spawns the opencode server |
| Use when | desktop / normal machines | headless servers, minimal environments (verified on RHEL7) |

In **plugin mode** the npm package must be listed in opencode's config —
verified on 1.18.x, the `"plugin"` array is the reliable load path:

```jsonc
// opencode.json / opencode.jsonc
{ "plugin": [ "@bd7pil/ocrc" ] }
```

`ocrc install` adds this line automatically when it can do so safely (plain
`opencode.json`); for a commented `jsonc` it prints the exact edit. opencode
installs the package on next start; upgrades ship via `npm i -g
@bd7pil/ocrc@latest` + restart. This array is the **only** supported
plugin-mode load path — directory-scanned "bridge" files (an older install
mechanism) were removed in 0.26.8: opencode loaded them at unpredictable
moments, spawning ghost instances that fought the real one for the PRIMARY
lock and the web port. `ocrc uninstall` cleans any legacy bridges up.

In **host mode** nothing touches opencode's config at all:

```bash
OCRC_BACKENDS=opencode OCRC_WEB_ENABLED=true ocrc host
```

Both modes elect a single PRIMARY when several instances are alive; the
losers stand by (one web bind, one Telegram poller, always).

**Which mode am I in?** Three ways to tell:

```bash
ocrc status          # web panel line says: ocrc 0.26.x (plugin|host mode, <commit>)
curl -s localhost:4099/api/version -H "Authorization: Bearer $(cat ~/.ocrc/token)" | grep mode
```

or by process: the mode is whichever entry owns the web panel — `node …
ocrc host` / `ocrc host` in the process list = **host mode**; the panel
served from inside an `opencode` process = **plugin mode**. Rule of thumb:
if you started it with `ocrc start` or `ocrc host`, it's host mode; if
opencode itself was started (TUI/serve) with the plugin configured, it's
plugin mode.

## Quick start

Requires **opencode 1.17+** (verified on 1.18.x) and **Node 20+**.

```bash
# 1. Install
npm i -g @bd7pil/ocrc
ocrc install          # interactive: Telegram bot token + your user id
                      # (the `opencode-remote-control` name on npm is an
                      #  unrelated package — don't npx it)

# 2. Start
ocrc start /path/to/your/project    # supervised plugin mode
# or: OCRC_BACKENDS=opencode OCRC_WEB_ENABLED=true ocrc host

# 3. Talk to it
#    Telegram: send "hello" to your bot
#    Web:      open http://<host>:4099 and pair (see below)
```

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
panel's QR (机器人面板 → 配对新设备). The first-run landing page
(`http://<host>:4099`) also shows the QR plus live channel status — no
credentials there, status only.

## Lifecycle

```bash
ocrc start <dir>             # start — supervision built in
ocrc status                  # server / supervisor / web panel at a glance
ocrc stop                    # graceful stop (supervisor first, then the instance)
ocrc restart [dir]           # restart
ocrc restore                 # re-launch the last instance (idempotent)
```

Supervision is always on: the supervisor adopts an already-running
instance, restarts the child after a crash (default 5 s, `OCRC_WATCH_DELAY`),
and treats SIGKILL / segfaults as crashes — an OOM kill self-heals.
SIGTERM or the stop file means "stop for real". Boot-time recovery is
opt-in:

```
@reboot sleep 60 && ocrc restore >> ~/.ocrc/prod.log 2>&1
```

## Telegram

35 commands, grouped: sessions (`/sessions /session /new /rename /workspaces
/projects /cleanup`), running work (`/skills /ls /open /worktree /diff /todo
/context /subs /current`), controls (`/agent /model /mode /task /tasks /tasklist
/taskdel /mcps /commands /messages /detach`), ops (`/start /status /version
/pair /channels /help`), plus `/abort` and plain text relay. Send any text to
drive the agent; approvals and interactive questions arrive as buttons.
Streaming replies render live and degrade to plain text when Telegram's
rich format is unavailable — an unreachable Telegram API never takes the
web panel down with it.

## Web panel

PWA (installable), token-gated. Desktop uses a three-pane register (sessions
rail · live chat · tabbed inspector); ≤820px it collapses into a drawer +
bottom sheet tuned for phones. The right pane opens dynamic tabs: git
(branch + lazy per-file patches), file browser/viewer, live subagent
transcripts, full tool-output pages, and a side chat. Per session: todos,
MCP servers, schedules, usage/cost, context ring, working-dir diff, skills,
worktrees, remotes — plus a floating plan HUD for subagent jumps and session
revert/unrevert. The bot channels panel configures reply granularity,
workspace scope, allowlists, and shows the pairing QR.

## Remote access

The web binds `0.0.0.0:4099` by default (token-gated). For a PWA install you
need a secure context:

| Method | Command | Notes |
|---|---|---|
| **LAN, plain HTTP** | open `http://<lan-ip>:4099` | Works in-browser; PWA install needs HTTPS |
| **Tailscale** | `tailscale serve 4099` | Stable `https://<host>.ts.net`, device auth |
| **cloudflared** | `cloudflared tunnel --url http://localhost:4099` | Free, URL rotates; set `OCRC_WEB_PUBLIC_URL` |

### SSH remote hosts (0.26+)

Drive opencode on **other machines** from the same panel. Register a host in
the Inspector → Remotes panel; ocrc then:

1. **detects** it over one ssh round-trip (platform, glibc, opencode path +
   version, credentials, port),
2. **provisions** the official opencode if missing — pinned to THIS machine's
   version (no internet on the remote? ocrc scp's its own binary),
3. **launches** `opencode serve` bound to the remote loopback and reaches it
   through an SSH local forward — one ssh process does tunnel + serve, so
   when it dies everything it started dies with it (respawn 2s→60s backoff),
4. **syncs credentials** (`sync-auth`: your `~/.local/share/opencode/auth.json`)
   so remote turns run with your LLM logins,
5. mirrors remote turns into Telegram/Web exactly like local ones (per-remote
   event SSE into the same pipeline).

Per-remote **enterprise proxy** settings (HTTP(S)_PROXY / NO_PROXY / custom
CA) are injected into the remote's serve environment — NO_PROXY always keeps
loopback traffic direct. The generated Basic password never leaves
`~/.ocrc/remotes.json` (0600) and is redacted in every API response.
Requires only system ssh + a reachable host (`~/.ssh/config`, ProxyJump work
as-is; verified against OpenSSH 7.4 on EL7).

## Security model

- One allowlisted Telegram user; web devices hold a token generated at first
  start (persisted `0600` at `~/.ocrc/token`), verified with constant-time
  compare on HTTP and WS.
- Pairing QR links carry a pending token (1 min, single use) — never the
  permanent credential.
- If the opencode server itself runs with `OPENCODE_SERVER_PASSWORD`, ocrc
  authenticates its server calls with HTTP Basic (same env, no extra config).
- Bot credentials are write-only through the API: responses carry a last-4
  hint, never the value.
- No cloud. Everything stays on the machine except Telegram API traffic.

## Configuration

Settings live in `~/.ocrc/config.env` (`0600`; `KEY=VALUE`). Highlights:

| Key | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required for the Telegram surface |
| `TELEGRAM_PROXY` | — | proxy for Bot API egress (`http://proxy:8080`); falls back to `HTTPS_PROXY`/`https_proxy` — for firewalled/corporate networks |
| `ALLOWED_USER_IDS` | — | comma-separated Telegram user ids |
| `OCRC_WEB_ENABLED` | `true` | web panel on/off |
| `OCRC_WEB_PORT` | `4099` | web panel port |
| `OCRC_WEB_HOST` | `0.0.0.0` | bind address |
| `OCRC_SERVER_PORT` | `4096` | opencode server port (lifecycle commands) |
| `OCRC_SERVER_BIN` | `~/.local/bin/opencode` | binary used by `ocrc start` |
| `OCRC_WATCH_DELAY` | `5` | supervisor restart delay (s) |
| `OPENCODE_SERVER_PASSWORD` | — | enables HTTP Basic for server calls |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error` |

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

In host mode the same surfaces live in the ocrc process instead, with the
opencode server spawned on :4096 and reached over HTTP. Deep dive:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); production notes:
[`docs/OPS.md`](docs/OPS.md); product boundaries:
[`docs/PRODUCT.md`](docs/PRODUCT.md).

## Compatibility

- **opencode**: pin 1.18.x; the V2 plugin API is a separate track.
- **OS baseline**: x86_64; verified on RHEL7 (glibc 2.17, OpenSSH 7.4) and
  current-generation Linux desktops. Windows runs ocrc in host mode inside
  WSL today; a native Windows shell is planned.

## Development

```bash
npm install && npm run build:all     # plugin + web
npm test                             # backend (vitest)
cd web && npm test                   # web (vitest)
bash scripts/spike-restart.sh        # isolated dev instance (never touches prod)
```

Releases: pushing a `v*` tag runs CI (typecheck + full test matrix + builds)
and publishes to npm via OIDC trusted publishing — no token in the repo.

## Credits & license

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). ocrc began as a fork of
[opencode-remote-control](https://github.com/agentjoey/opencode-remote-control)
and has since been rebuilt well past that origin (remote hosts, host mode,
supervision, the web panel); the Telegram interaction model draws on
[@grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot).
Both remain standing credits with gratitude.
