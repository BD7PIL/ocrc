/**
 * Library entry for the remote-instance capability.
 *
 * The panel extension's service bundles this (esbuild inlines it), and the CLI
 * uses the same functions directly. It used to re-export the opencode plugin
 * (ocrc's own "cockpit" product: Telegram/Web channels, workflows, schedules,
 * skills, engine-level remote hosts) — that surface is gone from this repo and
 * is being rebuilt as separate openchamber extensions elsewhere.
 */
export * from './remote-instance/index.js'
