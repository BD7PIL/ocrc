<script lang="ts">
  import type { ToolCall } from '../api/types.js'
  import TerminalBlock from './TerminalBlock.svelte'
  import { openPaneTab } from '$lib/stores/sidePane.js'

  interface ToolCallExtra extends ToolCall {
    adds?: number
    dels?: number
    dur?: number
  }

  export let tools: ToolCall[]
  /** Present on transcript cards — rows with tool-call ids open the
     full-output page (a dynamic pane tab). */
  export let sessionId: string | undefined = undefined
  const LIMIT = 12
  /** args longer than this (or multi-line) render as a terminal block. */
  const INLINE_MAX = 100
  let expanded = false

  $: typed = tools as ToolCallExtra[]
  $: shown = expanded ? typed : typed.slice(0, LIMIT)
  $: total = typed.length
  $: done = typed.filter((t) => t.status === 'done').length
  $: running = typed.filter((t) => t.status === 'running').length

  // Hysteresis: once an entry renders long (terminal block) it stays long, so
  // args streaming across the threshold don't remount the row inline↔terminal
  // and jump the layout. Keyed by the entry's stable id — position keying
  // broke when the list refetched and an older entry dropped out (perf audit).
  const longIdx = new Set<string>()

  function isLong(t: ToolCallExtra, i: number): boolean {
    const key = `${t.messageId ?? ''}:${t.partId ?? '#' + i}`
    if (longIdx.has(key)) return true
    const a = t.args ?? ''
    const long = a.includes('\n') || a.length > INLINE_MAX
    if (long) longIdx.add(key)
    return long
  }

  function fmtDur(s?: number): string {
    if (s == null) return ''
    if (s < 1) return `${(s * 1000).toFixed(0)}ms`
    return `${s.toFixed(1)}s`
  }

  function openOutput(t: ToolCallExtra) {
    if (!sessionId || !t.partId || !t.messageId) return
    openPaneTab({
      id: `tool:${sessionId}:${t.partId}`,
      kind: 'tool',
      title: t.tool,
      sessionId,
      messageId: t.messageId,
      partId: t.partId,
    })
  }
  const openable = (t: ToolCallExtra) => !!(sessionId && t.partId && t.messageId)
</script>

{#if tools.length > 0}
  <div class="execution">
    <div class="header">
      <span class="label mono">EXECUTION</span>
      <span class="rule" aria-hidden="true"></span>
      <!-- r7: done/total alone read 0/7 while 3 tools ran — show the in-flight part -->
      <span class="count mono">{done}/{total} steps{running > 0 ? ` · ${running} 运行中` : ''}</span>
    </div>
    <div class="rows">
      {#each shown as t, i}
        {#if isLong(t, i)}
          <button class="bare" disabled={!openable(t)} title={openable(t) ? '查看完整输出' : undefined} on:click={() => openOutput(t)}>
            <TerminalBlock text={t.args} tool={t.tool} status={t.status} dur={t.dur} adds={t.adds} dels={t.dels} />
          </button>
        {:else}
          <button class="row {t.status} bare" disabled={!openable(t)} title={openable(t) ? '查看完整输出' : undefined} on:click={() => openOutput(t)}>
            <div class="row-main">
              <span class="status" aria-hidden="true"></span>
              <span class="sr-only">{t.status}</span>
              <span class="name mono">{t.tool}</span>
              {#if t.tool === 'bash'}<span class="ps1 mono" aria-hidden="true">$</span>{/if}
              <span class="arg mono">{t.args}</span>
              {#if t.adds || t.dels}
                <span class="diff mono">
                  {#if t.adds}<span class="add">+{t.adds}</span>{/if}
                  {#if t.dels}<span class="del">−{t.dels}</span>{/if}
                </span>
              {/if}
              {#if t.status === 'running'}
                <span class="shimmer" aria-hidden="true"></span>
              {:else if t.dur != null}
                <span class="dur mono">{fmtDur(t.dur)}</span>
              {/if}
              {#if openable(t)}<span class="go" aria-hidden="true">↗</span>{/if}
            </div>
          </button>
        {/if}
      {/each}
      {#if typed.length > LIMIT && !expanded}
        <button class="more mono" on:click={() => (expanded = true)}>
          … {typed.length - LIMIT} more
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .execution {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px 12px;
    margin: 0 0 12px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .label {
    font-size: 10px;
    color: var(--text-4);
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border-2);
  }
  .count {
    font-size: 10px;
    color: var(--text-3);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Rows are buttons when the tool call carries ids (click → full-output
     page); reset the button chrome so they read exactly as before. */
  .bare {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .bare:disabled { cursor: default; }
  .bare:not(:disabled) { cursor: pointer; }
  .bare:not(:disabled):hover { background: var(--bg-input); border-radius: var(--radius-xs); }
  .go {
    flex-shrink: 0;
    color: var(--text-4);
    font-size: 11px;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: inherit;
    text-align: left;
    box-sizing: border-box;
  }

  .status {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  /* Visually hidden, still read by screen readers (text alternative for the dot). */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .row.running .status {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 7px var(--accent);
    /* pulse (not blink): the running affordance is opacity-eased everywhere
       else in the app — step-end here was the odd one out (motion audit) */
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .row.done .status { background: var(--ok); border-color: var(--ok); }
  .row.error .status { background: var(--err); border-color: var(--err); }
  .row:not(.running):not(.done):not(.error) .status {
    background: transparent;
    border: 1.5px solid var(--text-4);
  }

  .name {
    flex-shrink: 0;
    font-size: 13px;
    font-weight: 500;
  }
  .row.done .name { color: var(--text-2); }
  .row.running .name { color: var(--text); }
  .row.error .name { color: var(--err); }
  .row:not(.running):not(.done):not(.error) .name { color: var(--text-2); }

  .ps1 {
    flex-shrink: 0;
    /* r8: accent orange on the code background measured 3.68:1 in the light
       theme — decorative glyph, muted ink reads better anyway */
    color: var(--text-4);
    font-weight: 700;
    font-size: 13px;
  }
  /* bash rows are command echoes — paper-ink: ink command after the $ prompt */
  .row.bash .arg {
    color: var(--toolcmd);
    font-weight: 600;
  }
  .arg {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--hl-green);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diff {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .diff .add { color: var(--ok); }
  .diff .del { color: var(--err); }

  .shimmer {
    position: relative;
    overflow: hidden;
    flex-shrink: 0;
    width: 42px;
    height: 4px;
    border-radius: var(--radius-bar);
  }
  /* Compositor-only shimmer: a tiling gradient strip slides via transform
     (theme.css ocrc-shimmer) — no per-frame repaint. */
  .shimmer::before {
    content: '';
    position: absolute;
    inset: 0;
    width: 200%;
    background: linear-gradient(90deg, var(--accent) 0%, var(--text) 25%, var(--accent) 50%, var(--text) 75%, var(--accent) 100%);
    animation: ocrc-shimmer 1.4s linear infinite;
  }
  .dur {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-4);
  }

  .more {
    align-self: flex-start;
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 12px;
    padding: 4px 8px;
    cursor: pointer;
  }
  .more:hover { color: var(--text); }
</style>
