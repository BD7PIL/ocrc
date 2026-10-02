<!-- ContextRing.svelte — ZCode-style context meter in the composer footer.
     A small ring + percent; hover/tap opens a popover with the stacked
     token breakdown (cache read/write, input, output — real data only;
     the reference's engine-level category split isn't exposed by opencode).
     Desktop only — mobile keeps the Inspector 上下文 tab. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api/client.js'
  import { feeds, cardsOf } from '$lib/stores/sessions.js'
  import { contextBreakdown } from '$lib/inspector/contextBreakdown.js'

  export let sessionId: string

  let ctx: Record<string, any> = {}
  let open = false
  let wrap: HTMLElement
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  // Inspector data plane: pull on session switch, debounced ~1s after feed events.
  let loadedFor: string | undefined
  let lastSeqSeen = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  async function load(sid: string) {
    try { ctx = await api.context(sid) } catch { /* keep last valid */ }
  }
  $: if (sessionId !== loadedFor) { loadedFor = sessionId; void load(sessionId) }
  $: seq = $feeds[sessionId]?.lastSeq ?? 0
  $: if (seq !== lastSeqSeen) { lastSeqSeen = seq; clearTimeout(timer); timer = setTimeout(() => void load(sessionId), 1000) }
  onDestroy(() => { clearTimeout(timer); clearTimeout(closeTimer) })

  $: tin = typeof ctx?.tokens?.input === 'number' ? (ctx.tokens.input as number) : 0
  $: tout = typeof ctx?.tokens?.output === 'number' ? (ctx.tokens.output as number) : 0
  $: used = typeof ctx?.tokens?.used === 'number' ? (ctx.tokens.used as number) : tin + tout
  $: max = typeof ctx?.tokens?.max === 'number' ? (ctx.tokens.max as number) : undefined
  $: pct = used > 0 && max ? Math.min(100, (used / max) * 100) : 0
  $: arcColor = pct >= 90 ? 'var(--err)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)'
  $: model = ctx?.model ? String(ctx.model).split('/').pop() : undefined
  $: cost = typeof ctx?.cost === 'number' ? (ctx.cost as number) : undefined
  $: cacheRead = typeof ctx?.tokens?.cache?.read === 'number' ? (ctx.tokens.cache.read as number) : 0
  $: cacheWrite = typeof ctx?.tokens?.cache?.write === 'number' ? (ctx.tokens.cache.write as number) : 0
  $: cacheHit = tin + cacheRead > 0 ? Math.round((cacheRead / (tin + cacheRead)) * 100) : undefined
  $: feed = $feeds[sessionId]
  $: msgs = cardsOf(feed).filter((c) => c.kind === 'user' || c.kind === 'assistant').length

  const R = 10
  const CIRC = 2 * Math.PI * R

  function fmtK(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
    return String(n)
  }
  function fmtCost(n?: number) { return n == null ? '—' : `$${n.toFixed(3)}` }

  // Hover opens; a short leave-delay lets the pointer travel into the popover.
  function enter() { clearTimeout(closeTimer); open = true }
  function leave() { clearTimeout(closeTimer); closeTimer = setTimeout(() => (open = false), 180) }
  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape') open = false }
  function onWindowClick(e: MouseEvent) { if (open && wrap && !wrap.contains(e.target as Node)) open = false }

  // Category breakdown (opencode-web register: client-side estimation over
  // the feed; residual = system prompt / tool schemas / outputs as 其他).
  $: feedCards = cardsOf(feed)
  $: breakdown = contextBreakdown(feedCards, used)
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="wrap" bind:this={wrap} on:mouseenter={enter} on:mouseleave={leave}>
  <button class="ring" on:click={() => (open = !open)} aria-label={`上下文占用 ${pct.toFixed(0)}%`} aria-expanded={open} title="上下文占用">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle class="track" cx="12" cy="12" r={R} />
      <circle
        class="arc"
        cx="12" cy="12" r={R}
        stroke={arcColor}
        stroke-dasharray={`${Math.max(CIRC * pct / 100, pct > 0 ? 1.5 : 0)} ${CIRC}`}
        transform="rotate(-90 12 12)"
      />
    </svg>
    <span class="pct mono">{pct.toFixed(0)}<i>%</i></span>
  </button>

  {#if open && max}
    <div class="pop" role="dialog" aria-label="上下文用量">
      <div class="head">
        <span class="label">上下文</span>
        <span class="mono dim">{fmtK(used)} / {fmtK(max)}</span>
      </div>
      {#if breakdown.segments.length > 0}
        <!-- THE capacity bar: full scale = model context limit (the ring's
             semantics), segments = category estimates of the used part. The
             old cumulative 缓存读/输入/输出 bar measured session totals —
             incompatible with the ring's full scale (user report). -->
        <div class="bar" aria-hidden="true">
          {#each breakdown.segments as s}
            <span class="seg" style={`width:${(s.tokens / (breakdown.used || 1)) * 100}%; background:${s.color}`}></span>
          {/each}
        </div>
        <div class="legend">
          {#each breakdown.segments as s}
            <span class="lg"><span class="dot" style={`background:${s.color}`}></span>{s.key} {used > 0 ? ((s.tokens / used) * 100).toFixed(1) : '0'}%</span>
          {/each}
        </div>
      {:else}
        <div class="bar" aria-hidden="true"></div>
      {/if}
      <div class="rows">
        {#if cacheHit != null}<div class="row"><span>缓存命中率</span><span class="mono">{cacheHit}%</span></div>{/if}
        {#if msgs > 0}<div class="row"><span>消息</span><span class="mono">{msgs}</span></div>{/if}
        {#if model}<div class="row"><span>模型</span><span class="mono">{model}</span></div>{/if}
        {#if cost != null}<div class="row"><span>总成本</span><span class="mono">{fmtCost(cost)}</span></div>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .ring {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    color: var(--text-3);
  }
  .ring svg { width: 20px; height: 20px; }
  .track { fill: none; stroke: var(--border); stroke-width: 3; }
  .arc { fill: none; stroke-width: 3; stroke-linecap: round; transition: stroke-dasharray .3s ease; }
  .pct { font-size: 10.5px; color: var(--text-3); }
  /* Mobile: icon-only ring (no percent text) — the popover carries the detail. */
  @media (max-width: 820px) {
    .pct { display: none; }
    .ring svg { width: 22px; height: 22px; }
  }
  .pct i { font-style: normal; font-size: 8.5px; }
  .ring:hover .pct { color: var(--text-2); }


  .pop {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 0;
    width: 300px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 16px 40px rgba(0, 0, 0, .28);
    padding: 12px 14px;
    z-index: var(--z-popover);
    animation: ocrc-pop .14s var(--ease-out, ease-out);
    cursor: default;
  }
/* Mobile pop: fit the viewport (declared after the base rule — the earlier
     attempt sat before it and lost the cascade, overflowing 390px). */
  @media (max-width: 820px) {
    .pop {
      width: min(72vw, 300px);
      box-sizing: border-box;
      /* Center-anchor on the ring icon (the wrap sits mid-footer on mobile —
         left:0 ran 300px off-screen right, right:0 off-screen left). */
      left: 50%;
      right: auto;
      transform: translateX(-50%);
    }
  }
  .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .label { font-size: 11px; font-weight: 600; color: var(--text-2); }
  .dim { font-size: 10.5px; color: var(--text-3); }
  .bar {
    display: flex;
    height: 6px;
    border-radius: var(--radius-bar);
    overflow: hidden;
    background: var(--border-2);
  }
  .seg { height: 100%; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 6px 0 8px; }
  .lg { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-3); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .bd-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--text-3);
    margin: 8px 0 4px;
  }
  .bd-label .est {
    font-size: 9px;
    padding: 0 5px;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-pill);
    color: var(--text-4);
  }
  .bar.bd { margin-bottom: 6px; }
  .rows { display: flex; flex-direction: column; }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
    font-size: 11.5px;
    color: var(--text-3);
    border-top: 1px solid var(--border-2);
  }
  .row:first-child { border-top: none; }
  .row .mono { color: var(--text-2); font-size: 11px; }
</style>
