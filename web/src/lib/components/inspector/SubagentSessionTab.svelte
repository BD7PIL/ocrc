<!-- SubagentSessionTab.svelte — a dynamic pane tab: one subagent's LIVE
     transcript. The child session is WS-subscribed alongside the viewed
     session (multi-subscribe hub), so streaming cards land here in real
     time with full markdown/thinking/tool rendering via the same Card
     pipeline as the main column. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { goto } from '$app/navigation'
  import { api } from '$lib/api/client.js'
  import { feeds, cardsOf, setHistory } from '$lib/stores/sessions.js'
  import { wsSend } from '$lib/ws/send.js'
  import Card from '../Card.svelte'

  export let childId: string
  export let tick = 0

  let scrollEl: HTMLElement
  let pinned = true
  let backfilledFor: string | undefined

  async function backfill(id: string) {
    const feed = get(feeds)[id]
    if (feed && feed.order.length > 0) return
    try {
      const res = await api.history(id, { limit: 60 })
      setHistory(id, res.cards ?? [], res.lastSeq ?? 0)
    } catch { /* live subscription still works */ }
  }

  $: if (childId && childId !== backfilledFor) {
    backfilledFor = childId
    void (async () => {
      await backfill(childId)
      const seq = get(feeds)[childId]?.lastSeq ?? 0
      wsSend({ type: 'subscribe', sessionId: childId, sinceSeq: seq })
    })()
  }
  // Parent-feed ticks refetch the list panel; the live tab rides the WS.
  $: if (childId && tick && get(feeds)[childId]?.order?.length === 0) void backfill(childId)
  onDestroy(() => { if (childId) wsSend({ type: 'unsubscribe', sessionId: childId }) })

  // $feeds (auto-subscription) — a get(feeds) here would read once and never
  // re-render when WS cards land.
  $: cards = childId ? cardsOf($feeds[childId] ?? null) : []
  $: if (cards) pinIfPinned()

  function pinIfPinned() {
    if (pinned && scrollEl) requestAnimationFrame(() => { if (scrollEl && pinned) scrollEl.scrollTop = scrollEl.scrollHeight })
  }
  function onScroll() {
    if (!scrollEl) return
    pinned = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60
  }
</script>

<div class="t-wrap">
  <div class="t-hd">
    <span class="t-hint mono">实况 · {cards.length} 条</span>
    <button class="open" on:click={() => goto('/' + childId)}>在中栏打开此会话 →</button>
  </div>
  <div class="t-body" bind:this={scrollEl} on:scroll={onScroll}>
    {#each cards as c, i (c.seq ?? c.id ?? i)}
      <Card card={c} />
    {:else}
      <div class="empty">（暂无输出——子代理开跑后这里实时滚动）</div>
    {/each}
  </div>
</div>

<style>
  .t-wrap { font-size: 12px; display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .t-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    flex-shrink: 0;
  }
  .t-hint { font-size: 10px; color: var(--text-3); }
  .open {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .t-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    -webkit-overflow-scrolling: touch;
  }
  .t-body :global(.card) { margin: 4px 0 10px; }
  .empty { padding: 14px 0; color: var(--text-3); font-size: 11.5px; }
</style>
