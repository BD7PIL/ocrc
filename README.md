# OCRC — provision and drive remote openchamber instances

**One machine runs the panel, another machine runs the work.** The control side is the
**openchamber desktop app** (Win/Mac) with the **OCRC** extension; the controlled side runs a
full **openchamber** instance that we install for it — runtime, a pinned opencode, and the app
itself — reachable either directly or through the control side, depending on what that machine
can reach. You then pair it and it shows up in the app as **another OpenChamber server**.

> Status (2026-10-19): the panel path is the product. Verified end to end on two peers —
> a RHEL7 box with **no outbound network** (relayed through the control side) and an Ubuntu box
> with its own internet (direct). The earlier Telegram / Web-PWA surfaces are still in the
> codebase and still work; they are no longer the entry point.

[![Release](https://img.shields.io/github/v/release/BD7PIL/ocrc?color=10b981)](https://github.com/BD7PIL/ocrc/releases)
[![License: MIT](https://img.shields.io/github/license/BD7PIL/ocrc?color=10b981)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/BD7PIL/ocrc/ci.yml?branch=main&label=CI)](https://github.com/BD7PIL/ocrc/actions)

npm `@bd7pil/ocrc` · CLI `ocrc` · state `~/.ocrc/` · extension `extensions/ocrc`

## What it is

- **A panel extension that installs a whole cockpit on the other machine.** Runtime, a pinned
  opencode, and openchamber itself, pushed over ssh — the remote machine needs no internet and
  no package manager (`push`), or we can adopt what is already installed (`reuse`) without
  writing a byte.
- **Egress is decided by probing, not by a setting.** We ask the controlled machine whether it
  can reach a model catalogue; if it cannot, its engine talks through a relay leg on the control
  side (`-R` + a local proxy). The card and the status rail always show which of the two is in
  effect, and why.
- **Identity comes from upstream.** A pairing link (one-time, per-device, revocable) is pasted
  into the app's **导入链接**; the machine appears under *other OpenChamber servers*. We store no
  credentials for it.
- **One name, one repo.** Brand `OCRC`; machine identifiers are just `ocrc` — extension
  directory, `panel.id`, release asset, tags, mirror branch. Why, and what it costs existing
  installs: [`docs/decisions/2026-10-18-rename-to-ocrc.md`](docs/decisions/2026-10-18-rename-to-ocrc.md).

## Install the extension

Settings → Extensions → paste a URL:

```
https://github.com/BD7PIL/ocrc#ocrc        # git install — the app can update it for you
https://github.com/BD7PIL/ocrc/releases/download/ocrc-latest/ocrc.zip   # pinned, no self-update
```

The git form is the only shape openchamber self-updates: the extension lives at the root of the
`ocrc` branch (`git subtree split` publishes it), which is what the app's update check needs.
The version in `extensions/ocrc/package.json` **is** the update signal — a release that does not
bump it is invisible to git-installed copies. Then approve the **service** capability once (the
extension runs `ssh` on the host); an in-app update asks again.

> An older install with `panel.id = ocrc-remote` (≤ 0.8.2) is a *different* extension: remove it
> before installing this one, or both stay in the list.

## Use it

1. **添加服务器** — ssh target, login (key or password), install mode, network mode. Derived
   values (compat tier, runtime, pins, bind) are shown, not asked: the target's glibc decides
   them.
2. **检查并安装** — a read-only inspection first (uname, glibc, what is already there, what would
   be written, and the ssh-reachability verdict). Nothing is written until you confirm in that
   card.
3. **启动** — the instance runs on the remote loopback; the control side holds the forward.
4. **创建配对链接 → 复制链接** — paste it into the app's **导入链接** and confirm. (The panel
   cannot open `openchamber://` itself: the guest bridge only forwards http/https URLs.)
5. **配置差异与同步** — diff this machine's `~/.config/opencode` against the remote's, then push
   files, merge the config document, and ship `auth.json` over stdin at 0600. Deletions are
   opt-in per item.

The status rail (right edge of the app) is a read-only readout, one line per machine: state,
OpenChamber version, and `直连` / `经本机转发`.

## CLI

The same library's headless entry — for machines without a panel:

```bash
ocrc remote list|plan|apply|up|down|status|pairlink|logs|peerlog|upgrade <id>
ocrc remote config-diff|sync-config|sync-auth <id>
ocrc remote prepare [--app-version V]     # pre-fetch packs on the control side
ocrc remote supervise                     # foreground R10 ①② for panel-less hosts
```

The remote channel is also exposed **to the model**, from any transport
(`docs/research/e2-verdict.md`): `ocrc_remote_list`, `ocrc_remote_sync_workspace`,
`ocrc_remote_provision`, `ocrc_remote_create_session`, `ocrc_remote_sync_auth`.

## Earlier surfaces (still in the codebase)

Telegram (35 commands: sessions, running work, controls, ops) and a token-gated Web PWA that
streams the same live sessions from the same pipeline — prompts from either surface mirror to
both, approvals arrive as buttons. They predate the panel path and remain supported; the entry
point for a new setup is the extension above.

```bash
npm i -g @bd7pil/ocrc
ocrc install            # Telegram bot token + allowed user id
ocrc start <dir>        # or: OCRC_BACKENDS=opencode OCRC_WEB_ENABLED=true ocrc host
ocrc pair               # QR + link for a device (works without Telegram)
```

<p align="center">
  <img src="docs/assets/ocrc-web.png" width="760" alt="the Web PWA driving a live opencode session">
</p>

## Compatibility

| | |
|---|---|
| opencode | pinned **1.18.x**, plus a v2 track (the packed peer engine is v2, `2.0.27`) |
| controlled side | Linux x86_64; **RHEL7 / glibc 2.17** is a supported floor (CI builds a legacy pack) |
| control side | Windows / macOS desktop app; Windows dev boxes covered by the handoff docs |
| ssh | system OpenSSH (ProxyJump / `~/.ssh/config` work as-is) |

## Development

```bash
npm install && npm run build:all     # backend + vendored engine
npm test                             # backend (vitest)
npm run typecheck
npm run preflight                    # BEFORE COMMITTING: rebuilds both extensions, typechecks,
                                     # tests, guest-bundle invariants, stages artifacts
```

The extension is the only thing installed from a URL, and its artifacts (`panel/ status/ service/
shared/`) are **committed** so a folder install needs no build — which is why `preflight` exists:
edit `src/` without rebuilding and CI's dist check fails.

```bash
npm --prefix extensions/ocrc run typecheck && npm --prefix extensions/ocrc test
node extensions/ocrc/scripts/preview.mjs     # the real panel on a fake host, ?scenario= switches state
node extensions/ocrc/scripts/audit.mjs       # per-component screenshots (24 states) for visual review
bash scripts/accept-remote-instance.sh --target user@host   # end-to-end acceptance on a real peer
```

Where to read next: [AGENTS.md](AGENTS.md) (orientation, naming, dev rules) ·
[docs/PRODUCT.md](docs/PRODUCT.md) (product boundaries — read this before proposing a feature) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPS.md](docs/OPS.md) (operations, upgrades,
the egress verdict) · [docs/handoff/](docs/handoff/) (delivery records) ·
[docs/research/](docs/research/) (verdicts with evidence).

## Credits & license

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). ocrc began as a fork of
[opencode-remote-control](https://github.com/agentjoey/opencode-remote-control) and has since
been rebuilt well past that origin; the Telegram interaction model draws on
[@grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot), and the panel
is upstream [openchamber](https://github.com/openchamber/openchamber) (used as-is, not forked).
All three remain standing credits with gratitude.