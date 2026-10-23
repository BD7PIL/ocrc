# Contributing to OCRC

Thanks for taking a look. OCRC does one thing: **provision and drive a complete
openchamber instance on a remote Linux host, then pair it into the desktop app
and keep its config and credentials in sync.** New features have to fit that
boundary — read [docs/PRODUCT.md](docs/PRODUCT.md) before proposing one. The
"不做" list there is a decision record, not a suggestion list.

## Setup

Requirements: Node.js >= 20 and npm. The runtime package has **no runtime
dependencies** — everything under `src/` uses Node built-ins. Please keep it
that way; a new dependency needs a reason in the PR.

```bash
npm install
npm run build
npm test
```

## Checks before you open a PR

```bash
npm run typecheck         # src
npm run typecheck:tests   # tests are typechecked too
npm run lint              # Biome, lint-only (formatting is not enforced)
npm test                  # 248 tests
npm run preflight         # rebuilds both extensions + typechecks + tests + guest invariants
```

`npm run preflight` is the gate that matters. It rebuilds
`extensions/*/panel|status|service|shared` from `src/`. Those artifacts are
committed so a folder install needs no build; editing `extensions/*/src/`
without rebuilding makes CI's dist-consistency check fail.

For panel or status changes, also run:

```bash
node extensions/ocrc/scripts/preview.mjs   # real panel on a fake host, ?scenario= switches state
node extensions/ocrc/scripts/audit.mjs     # per-component screenshots
```

and look at the screenshots before sending the PR (the checklist lives in
`extensions/ocrc/preview/audit/README.md`).

## Tests

- Unit tests live in `tests/unit/*.test.ts` (Vitest).
- Add a test with each behaviour change; the suite is the contract for
  argument builders, config merging, gates and the bootstrap sequence.
- A test must not need a real peer. Real-machine acceptance uses
  `scripts/accept-remote-instance.sh --target user@host` and is run manually.

## Code style

- TypeScript strict mode; match the surrounding code rather than importing a
  new style.
- Comments explain **why** a rule exists (often a past failure), not what the
  next line does.
- Keep public functions typed and small.

## Security rules (non-negotiable)

These are product constraints, not preferences:

- **Never write a secret into a config file.** Only `{env:VAR}` / `{file:path}`
  indirection is allowed. Secrets travel through the process environment
  (`OCRC_INSTANCE_ENV`) or `auth.json`.
- **Transport credentials (SSH keys/passwords) never leave the panel host.**
  They are stored in `~/.ocrc/remote-instances.json` (0600) and are never
  returned by the API.
- **No test traffic against a production engine.** Everything in this repo
  talks to an isolated stack (mock `:4098` + host `:4199`) or to a dedicated
  peer instance. Never kill or reconfigure an engine the user already adopted.
- Do not introduce code or prompt text from `omo`-derived projects (see
  `docs/PRODUCT.md`, SUL-1.0).
- Remote scripts must contain **zero egress commands** — `npm run
  offline-proof` is the structural check.

If a change needs one of these rules relaxed, open an issue first; the policy
is part of the product.

## Documentation

- `README.md` — what it is, install, the one-command path.
- `docs/PRODUCT.md` — boundaries; read before adding a feature.
- `docs/ARCHITECTURE.md`, `docs/OPS.md` — how it works, how to operate it.
- `CHANGELOG.md` — user-visible changes, newest first.
- `AGENTS.md` — orientation for AI agents working in this repo.

Update the docs that would otherwise become false. Historical records under
`docs/handoff/`, `docs/research/` and `docs/decisions/` are not rewritten;
they get a banner when superseded.

## Pull requests

- One logical change per commit; explain the failure the change fixes.
- Link the issue if there is one.
- CI must be green (lint, typecheck, tests, extension dist consistency, guest
  invariants).
- By contributing you agree that your changes are licensed under the MIT
  License of this repository.
