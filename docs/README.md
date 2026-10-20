# Documentation index

The product is one line: **provision and drive a complete openchamber instance
on a remote Linux host, pair it into the desktop app, and keep its config and
credentials in sync.** Documents below are grouped by whether they describe the
current code or record history.

## Current (kept in sync with the code)

| Document | What it answers |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | What is in scope and what is explicitly not. Read before proposing a feature. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the control side, the service process, the tunnel and the peer fit together. |
| [OPS.md](OPS.md) | How to install, operate, upgrade, diagnose; bootstrap and its exit codes. |
| [../AGENTS.md](../AGENTS.md) | Orientation for AI agents: naming, repo map, dev rules. |
| [../README.md](../README.md) | User-facing overview and the one-command path. |
| [../CHANGELOG.md](../CHANGELOG.md) | User-visible changes, newest first. |

## Design notes still referenced by the code

| Document | What it covers |
| --- | --- |
| [remote-provisioning-design.md](remote-provisioning-design.md) | The peer-instance contract this repo implements. |
| [v2-api-notes.md](v2-api-notes.md) | opencode v2 plugin/config behaviour verified on a real engine. |
| [n12-spike-record.md](n12-spike-record.md) | The desktop-handoff probe that shaped pairing. |

## Historical archive (not rewritten; banners say when superseded)

`handoff/`, `research/`, `decisions/`, `design/`, `transports/`, plus the loose
records `frontend-integration-audit.md`, `frontend-mobile-audit.md`,
`motion-design.md`, `next-phase.md`, `perf-remediation-brief.md`,
`workflow-*.md`.

These document earlier product shapes (Telegram/Web cockpit, engine-side remote
hosts, the web frontend) that were deleted from this repository on 2026-10-19.
They are kept for the reasoning and the failure evidence, not as instructions.
