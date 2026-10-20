# Security Policy

## Reporting a vulnerability

Use GitHub's **[private vulnerability reporting](https://github.com/BD7PIL/ocrc/security/advisories/new)**
(Security tab → Report a vulnerability). Please do not open a public issue for a
security problem.

## Response targets

- Acknowledge within 48 hours
- Patch high-severity issues within 14 days
- Patch other issues within 30 days

## Scope

ocrc provisions and drives a remote openchamber instance over SSH. The security
boundaries are:

- **SSH credentials** used to reach the controlled host (key or password).
- **The remote instance's UI password** and the single-use pairing link.
- **The control-side egress relay** — the controlled host can reach its own
  loopback through it, so the target allowlist is a security boundary.
- **Provider credentials** synced by `sync-auth`: written `0600` on the peer,
  never printed, never copied into a config file.

In scope: bypassing the engine v2 gate, writing outside the documented remote
paths, leaking a credential into logs or config, the relay accepting a
non-allowlisted target, and the extension service executing anything beyond the
documented `ssh` commands.

Out of scope: vulnerabilities in opencode, openchamber, or model providers —
report those upstream.
