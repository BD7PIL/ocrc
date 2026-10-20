# OCRC — provision and drive remote openchamber instances

**One machine runs the panel, another machine runs the work.** The control side is the
**openchamber desktop app** (Win/Mac) with the **OCRC** extension; the controlled side runs a
full **openchamber** instance that we install for it — runtime, a pinned opencode, and the app
itself — reachable either directly or through the control side, depending on what that machine
can reach. You then pair it and it shows up in the app as **another OpenChamber server**.

> Status (2026-10-19): this is the whole product. Verified end to end on two peers — a RHEL7 box
> with **no outbound network** (relayed through the control side) and an Ubuntu box with its own
> internet (direct). Everything else ocrc used to be — its own Telegram/Web cockpit, workflows,
> schedules, skills, engine-level remote hosts — was removed from this repo and is being rebuilt
> as separate openchamber extensions elsewhere (see [AGENTS.md](AGENTS.md) → *已删除*).

[![Release](https://img.shields.io/github/v/release/BD7PIL/ocrc?color=10b981)](https://github.com/BD7PIL/ocrc/releases)
[![License: MIT](https://img.shields.io/github/license/BD7PIL/ocrc?color=10b981)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/BD7PIL/ocrc/ci.yml?branch=main&label=CI)](https://github.com/BD7PIL/ocrc/actions)

npm `@bd7pil/ocrc` · CLI `ocrc` · state `~/.ocrc/` · extension `extensions/ocrc`

## What it does

- **Installs a whole cockpit on the other machine.** Runtime, a pinned opencode, and openchamber
  itself, pushed over ssh — the remote machine needs no internet and no package manager
  (`push`), or we adopt what is already installed (`reuse`) without writing a byte.
- **Decides egress by probing, not by a setting.** We ask the controlled machine whether it can
  reach a model catalogue; if it cannot, its engine talks through a relay leg on the control side
  (`-R` + a local proxy). The card and the status rail always show which of the two is in effect,
  and why.
- **Takes identity from upstream.** A pairing link (one-time, per-device, revocable) is pasted
  into the app's **导入链接**; the machine appears under *other OpenChamber servers*. We store no
  credentials for it.
- **Keeps config and credentials in sync.** Diff this machine's `~/.config/opencode` against the
  remote's, push files, deep-merge the config document, ship `auth.json` over stdin at 0600 —
  with deletions opt-in per item and `.ocrc-bak` backups.
- **Assembles components it does not know.** `--with-components` reads each component's own
  `provision.json` (engine plugin, pinned binary, console extension), installs it, and adds its
  entry to the engine's `plugins` union. Adding reeve or deep-memory is a manifest, not an ocrc
  change; the versions are pinned in `ops/components.json`.
- **One name, one repo.** Brand `OCRC`; machine identifiers are just `ocrc` — extension
  directory, `panel.id`, release asset, tags, mirror branch. Why, and what it cost existing
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
5. **配置差异与同步** — diff, then push files / merge the config / ship credentials, as above.

The status rail (right edge of the app) is a read-only readout, one line per machine: state,
OpenChamber version, and `直连` / `经本机转发`.

## CLI

The same library's headless entry — for machines without a panel:

```bash
ocrc remote add --host H [--user U] [--ssh-auth key|password] [--egress auto|relay|direct]
                        [--provision push|reuse] [--instance-port 2610] [--local-port 4610]
ocrc remote list|status <id>
ocrc remote plan <id>                # read-only dry run: ssh, environment, engine gate, actions
ocrc remote apply <id> [--force]     # push runtime + pinned opencode + app
                        [--with-components | --component <dir|tgz|spec>]
                                     # + each component's provision.json (plugin/artifacts/console)
ocrc remote up|down <id>             # start / stop (relay leg + forwards come with it)
ocrc remote pairlink <id>            # one-time pairing link
ocrc remote config-diff|sync-config|sync-auth <id>
ocrc remote peerlog <id> | logs <id> | upgrade <id> | remove <id>
ocrc remote prepare [--app-version V]        # pre-fetch packs on the control side
ocrc remote bootstrap <id> --with-components --yes   # the whole takeover, in order
ocrc remote offline-proof | trace-check F    # prove an install made no outbound calls
```

## One command from Windows

`ocrc remote bootstrap` is a sequencer over the commands above, not a new capability:

```
record → plan → apply → sync-auth → sync-config → up → pairlink
```

```bash
# first look — read-only, writes nothing to the peer
ocrc remote bootstrap user@host --with-components --dry-run

# the takeover
ocrc remote bootstrap user@host --with-components --yes
```

What it does differently from running the seven commands yourself:

- **Only the fields you named are written.** An existing record keeps its `uiPassword`, pinned
  engine path, ports and stored ssh password; `--target` registers the host first, then drives it.
- **Fatal vs warning steps.** A failed `plan`/`apply`/`up` stops the sequence and exits 1. A
  missing local `auth.json`, a config merge problem, or a failed pairing link is printed as `WARN`
  and the rest still runs.
- **No silent writes.** Without `--yes`, a TTY asks `[y/N]`; a non-TTY run refuses (use
  `--dry-run` to preview).

It does **not** touch an engine the host already adopted (the instance lives under `~/.ocrc`), does
not install a desktop extension, and cannot make Windows the controlled side — the peer must be
Linux.

## Compatibility

| | |
|---|---|
| opencode | the packed peer engine is **v2** (`2.0.32`); the v2 gate is enforced (`major=2`, `>= 2.0.20`) |
| controlled side | Linux x86_64; **RHEL7 / glibc 2.17** is a supported floor (CI builds a legacy pack) |
| control side | Windows / macOS desktop app; the service runs on that host |
| ssh | system OpenSSH (ProxyJump / `~/.ssh/config` work as-is) |

## Development

```bash
npm install && npm run build         # CLI (tsc) — no runtime dependencies
npm test                             # 205 tests (the instance line)
npm run typecheck && npm run typecheck:tests
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
the egress verdict) · [docs/handoff/](docs/handoff/) and [docs/research/](docs/research/)
(delivery records and verdicts, historical) · [docs/decisions/](docs/decisions/) (why things are
the way they are).

## Credits & license

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). ocrc began as a fork of
[opencode-remote-control](https://github.com/agentjoey/opencode-remote-control) and has since been
rebuilt well past that origin; the panel is upstream
[openchamber](https://github.com/openchamber/openchamber) (used as-is, not forked).
