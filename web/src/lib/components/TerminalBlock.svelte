<script lang="ts">
  import { onDestroy } from 'svelte'
  import { ansiToHtml } from '../ansi.js'

  /** Terminal-styled block for tool/command output: monospace, dark,
      ANSI-aware. Long output collapses behind a "show more" toggle. */
  export let text: string
  export let tool = ''
  export let status: 'running' | 'done' | 'error' = 'done'
  export let dur: number | undefined = undefined
  export let adds: number | undefined = undefined
  export let dels: number | undefined = undefined

  const MAX_LINES = 20
  let userExpanded = false

  $: lines = text.split('\n')
  $: collapsible = lines.length > MAX_LINES
  // While running, always show the full output — otherwise the newest lines
  // (the interesting part) sit hidden behind "show more".
  $: expanded = status === 'running' || userExpanded
  $: shown = collapsible && !expanded ? lines.slice(0, MAX_LINES).join('\n') : text

  let html = ''
  let lastApplied: string | undefined
  let raf = 0
  let pending = ''

  function apply(s: string) {
    if (s === lastApplied) return // memoize — skip re-render of unchanged text
    lastApplied = s
    html = ansiToHtml(s)
  }

  // While running, deltas arrive per-token: coalesce the ansiToHtml render to
  // one per animation frame. Once done (or without rAF), apply synchronously so
  // the final output is always complete.
  $: {
    const s = shown
    if (status === 'running' && typeof requestAnimationFrame !== 'undefined') {
      pending = s
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(pending) })
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      apply(s)
    }
  }

  onDestroy(() => { if (raf) cancelAnimationFrame(raf) })

  $: glyph = status === 'done' ? '✓' : status === 'running' ? '●' : '✗'

  function fmtDur(s?: number): string {
    if (s == null) return ''
    if (s < 1) return `${(s * 1000).toFixed(0)}ms`
    return `${s.toFixed(1)}s`
  }
</script>

<div class="term {status}">
  <div class="term-head">
    <span class="glyph" aria-hidden="true">{glyph}</span>
    <span class="tname mono">{tool}</span>
    {#if adds || dels}
      <span class="diff mono">
        {#if adds}<span class="add">+{adds}</span>{/if}
        {#if dels}<span class="del">−{dels}</span>{/if}
      </span>
    {/if}
    {#if status === 'running'}
      <span class="shimmer" aria-hidden="true"></span>
    {:else if dur != null}
      <span class="dur mono">{fmtDur(dur)}</span>
    {/if}
  </div>
  <div class="term-body mono">{@html html}</div>
  {#if collapsible && status !== 'running'}
    <button class="toggle mono" on:click={() => (userExpanded = !userExpanded)}>
      {expanded ? '▴ show less' : `▾ show more · ${lines.length - MAX_LINES} more lines`}
    </button>
  {/if}
</div>

<style>
  .term {
    background: var(--bg-code);
    border: 1px solid var(--border-2);
    border-radius: 8px;
    overflow: hidden;
  }
  .term-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border-2);
    background: transparent;
  }
  .glyph {
    font-size: 11px;
    flex-shrink: 0;
  }
  .done .glyph { color: var(--ok); }
  .running .glyph {
    color: var(--accent);
    animation: ocrc-blink 1s step-end infinite;
  }
  .error .glyph { color: var(--err); }
  .tname {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-2);
  }
  .running .tname { color: var(--text); }
  .error .tname { color: var(--err); }
  .diff {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .diff .add { color: var(--ok); }
  .diff .del { color: var(--err); }
  .shimmer {
    margin-left: auto;
    width: 42px;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--accent) 0%, var(--text) 50%, var(--accent) 100%);
    background-size: 200% 100%;
    animation: ocrc-shimmer 1.4s linear infinite;
  }
  .dur {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-4);
  }
  .term-body {
    padding: 8px 10px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--toolout);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .toggle {
    display: block;
    width: 100%;
    min-height: 32px;
    padding: 4px 10px;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border-2);
    color: var(--text-3);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .toggle:hover { color: var(--text); }
</style>
