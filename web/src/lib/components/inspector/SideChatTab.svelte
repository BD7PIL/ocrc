<!-- SideChatTab.svelte — 辅助对话: a real scratch session rendered live in the
     pane (ZCode SelectionSideChatPane register). The session is WS-subscribed
     alongside the viewed one (multi-subscribe hub), messages stream through
     the same Card pipeline, and the mini composer sends via /api/message. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { goto } from '$app/navigation'
  import { api } from '$lib/api/client.js'
  import { feeds, cardsOf, setHistory } from '$lib/stores/sessions.js'
  import { wsSend } from '$lib/ws/send.js'
  import Card from '../Card.svelte'

  export let childId: string
  // Inspector fan-out only; this tab refreshes via its own feed subscription.
  export const tick: number = 0

  let text = ''
  let sending = false
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

  $: cards = childId ? cardsOf($feeds[childId] ?? null) : []
  $: if (cards) pinIfPinned()

  function pinIfPinned() {
    if (pinned && scrollEl) requestAnimationFrame(() => { if (scrollEl && pinned) scrollEl.scrollTop = scrollEl.scrollHeight })
  }
  function onScroll() {
    if (!scrollEl) return
    pinned = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60
  }

  async function send() {
    const body = text.trim()
    if (!body || sending) return
    sending = true
    text = ''
    pinned = true
    try {
      await api.sendMessage({ sessionId: childId, text: body, clientId: `sc_${Date.now().toString(36)}` })
    } catch {
      text = body // restore draft on failure
    } finally { sending = false }
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() }
  }
  onDestroy(() => { if (childId) wsSend({ type: 'unsubscribe', sessionId: childId }) })
</script>

<div class="sc">
  <div class="sc-hd">
    <span class="hint mono">辅助对话 · {cards.length} 条</span>
    <button class="open mono" title="在中栏打开此会话" on:click={() => goto('/' + childId)}>中栏打开 ↗</button>
  </div>
  <div class="sc-body" bind:this={scrollEl} on:scroll={onScroll}>
    {#each cards as c, i (c.seq ?? c.id ?? i)}
      <Card card={c} />
    {:else}
      <div class="empty">问点什么——回复实时流在这里。</div>
    {/each}
  </div>
  <div class="sc-input">
    <textarea
      rows={2}
      placeholder="辅助对话…（↵ 发送）"
      bind:value={text}
      on:keydown={onKeydown}
      aria-label="辅助对话输入"
    ></textarea>
    <button class="send" on:click={send} disabled={sending || !text.trim()} aria-label="发送">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
    </button>
  </div>
</div>

<style>
  .sc { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12px; }
  .sc-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; flex-shrink: 0; }
  .hint { font-size: 10px; color: var(--text-3); }
  .open { background: transparent; border: none; padding: 0; color: var(--accent); font-size: 11px; cursor: pointer; }
  .sc-body {
    flex: 1; min-height: 0; overflow-y: auto;
    display: flex; flex-direction: column;
    -webkit-overflow-scrolling: touch;
  }
  .sc-body :global(.card) { margin: 4px 0 10px; }
  .sc-body :global(.card .text) { font-size: 12px; }
  .empty { padding: 14px 0; color: var(--text-3); font-size: 11.5px; }
  .sc-input {
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-top: 8px;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .sc-input:focus-within { border-color: var(--accent-line); }
  textarea {
    flex: 1; min-width: 0;
    background: transparent; border: none; outline: none; resize: none;
    color: var(--text); font-family: var(--font-sans); font-size: 12px; line-height: 1.5;
    max-height: 96px;
  }
  .send {
    flex-shrink: 0;
    display: inline-grid; place-items: center;
    width: 28px; height: 28px;
    background: var(--accent); color: var(--accent-ink);
    border: none; border-radius: 50%;
    cursor: pointer;
  }
  .send:disabled { background: var(--border); color: var(--text-3); cursor: not-allowed; }
</style>
