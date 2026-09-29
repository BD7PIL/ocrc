<!-- src/lib/components/inspector/UsagePanel.svelte -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  import { feeds, cardsOf } from '$lib/stores/sessions.js'
  import type { ExtractStructuredCard } from '$lib/api/types.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  let ctx: Record<string, any> = {}

  async function load(id?: string) {
    if (!id) {
      ctx = {}
      return
    }
    try {
      const res = await api.context(id)
      // Session switched while the request was in flight — drop the stale result.
      if (id !== sessionId) return
      ctx = res
    } catch {
      /* keep last valid context on transient failures */
    }
  }

  $: load(sessionId), tick

  $: hasCtxTokens =
    typeof ctx?.tokens?.input === 'number' || typeof ctx?.tokens?.output === 'number'
  $: ctxIn = typeof ctx?.tokens?.input === 'number' ? (ctx.tokens.input as number) : undefined
  $: ctxOut = typeof ctx?.tokens?.output === 'number' ? (ctx.tokens.output as number) : undefined
  $: ctxCost = typeof ctx?.cost === 'number' ? (ctx.cost as number) : undefined

  $: feed = sessionId ? $feeds[sessionId] : undefined
  // Fallback only: when api.context has no token totals, sum assistant-card
  // meta. Memoized on the feed cursor (lastSeq + card count) so re-renders
  // that changed nothing don't rescan the whole feed — and once the context
  // endpoint reports tokens the scan stops running at all.
  let sumKey = ''
  let sumMeta = { in: 0, out: 0, cost: 0 }
  $: {
    const key = hasCtxTokens ? '' : `${sessionId}:${feed?.lastSeq ?? 0}:${feed?.order.length ?? 0}`
    if (key !== sumKey) {
      sumKey = key
      sumMeta = key === ''
        ? { in: 0, out: 0, cost: 0 }
        : (cardsOf(feed).filter((c) => c.kind === 'assistant') as ExtractStructuredCard<'assistant'>[]).reduce(
            (acc, c) => {
              const m = c.meta ?? {}
              if (typeof m.tokens?.input === 'number') acc.in += m.tokens.input
              if (typeof m.tokens?.output === 'number') acc.out += m.tokens.output
              if (typeof m.cost === 'number') acc.cost += m.cost
              return acc
            },
            { in: 0, out: 0, cost: 0 }
          )
    }
  }

  $: tin = hasCtxTokens ? ctxIn : sumMeta.in || undefined
  $: tout = hasCtxTokens ? ctxOut : sumMeta.out || undefined
  $: cost = ctxCost ?? (sumMeta.cost || undefined)

  function fmt(n?: number) {
    return n == null ? '—' : n.toLocaleString()
  }
  function fmtCost(n?: number) {
    return n == null ? '—' : `$${n.toFixed(3)}`
  }
</script>

<div class="usage">
  <div class="tiles">
    <div class="tile">
      <div class="label">输入 tokens</div>
      <div class="num mono">{fmt(tin)}</div>
    </div>
    <div class="tile">
      <div class="label">输出 tokens</div>
      <div class="num mono">{fmt(tout)}</div>
    </div>
  </div>
  <div class="spend mono">est. spend {fmtCost(cost)}</div>
</div>

<style>
  .usage {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .section-label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px;
    background: var(--bg-elev);
    border-radius: var(--radius-sm);
  }
  .tile .label {
    text-transform: uppercase;
    letter-spacing: .14em;
    color: var(--text-3);
    font-size: 9.5px;
  }
  .tile .num {
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
  }
  .spend {
    color: var(--text-3);
    font-size: 11px;
  }
</style>
