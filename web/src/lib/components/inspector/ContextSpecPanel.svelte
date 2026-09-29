<!-- ContextSpecPanel.svelte — the 上下文 tab: opencode-web-style spec sheet.
     Merges the old Context + Usage panels: label:value rows (no stat boxes),
     the context-fill bar, cache hit rate, cost, and live message counts. -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  import { feeds, cardsOf } from '$lib/stores/sessions.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  let ctx: Record<string, any> = {}

  async function load(id?: string) {
    if (!id) { ctx = {}; return }
    try { ctx = await api.context(id) } catch { /* keep last valid */ }
  }
  $: load(sessionId), tick

  $: tin = typeof ctx?.tokens?.input === 'number' ? (ctx.tokens.input as number) : undefined
  $: tout = typeof ctx?.tokens?.output === 'number' ? (ctx.tokens.output as number) : undefined
  $: used = typeof ctx?.tokens?.used === 'number'
    ? (ctx.tokens.used as number)
    : (tin != null || tout != null ? (tin ?? 0) + (tout ?? 0) : undefined)
  $: max = typeof ctx?.tokens?.max === 'number' ? (ctx.tokens.max as number) : undefined
  $: pct = used != null && max != null ? Math.min(100, Math.round((used / max) * 100)) : undefined
  $: model = ctx?.model ? String(ctx.model).split('/').pop() : undefined
  $: cost = typeof ctx?.cost === 'number' ? (ctx.cost as number) : undefined
  $: cacheRead = typeof ctx?.tokens?.cache?.read === 'number' ? (ctx.tokens.cache.read as number) : undefined
  $: cacheWrite = typeof ctx?.tokens?.cache?.write === 'number' ? (ctx.tokens.cache.write as number) : undefined
  $: cacheHit = cacheRead != null && tin != null && tin + cacheRead > 0
    ? Math.round((cacheRead / (tin + cacheRead)) * 100)
    : undefined

  // Feed-derived message counts (用户/助手), like the reference's 消息数 rows.
  $: feed = sessionId ? $feeds[sessionId] : undefined
  $: cards = cardsOf(feed)
  $: userMsgs = cards.filter((c) => c.kind === 'user').length
  $: asstMsgs = cards.filter((c) => c.kind === 'assistant').length
  $: title = $feeds[sessionId] ? undefined : undefined

  function fmt(n?: number) { return n == null ? '—' : n.toLocaleString() }
  function fmtCost(n?: number) { return n == null ? '—' : `$${n.toFixed(3)}` }
  function k(n?: number) {
    if (n == null) return '—'
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
    return String(n)
  }
</script>

<div class="spec">
  {#if pct != null}
    <div class="bar" aria-hidden="true">
      <div class="fill" style="width:{pct}%"></div>
    </div>
  {/if}

  <div class="kv"><span class="k">使用率</span><span class="v mono">{pct != null ? pct + '%' : '—'}</span></div>
  <div class="kv"><span class="k">上下文上限</span><span class="v mono">{max != null ? fmt(max) : '—'}</span></div>
  <div class="kv"><span class="k">已用 tokens</span><span class="v mono">{fmt(used)}</span></div>
  <div class="kv"><span class="k">输入 tokens</span><span class="v mono">{fmt(tin)}</span></div>
  <div class="kv"><span class="k">输出 tokens</span><span class="v mono">{fmt(tout)}</span></div>
  {#if cacheRead != null}
    <div class="kv"><span class="k">缓存命中</span><span class="v mono">{cacheHit != null ? cacheHit + '%' : '—'} · {k(cacheRead)} read</span></div>
  {/if}
  <div class="kv"><span class="k">模型</span><span class="v mono">{model ?? '—'}</span></div>
  <div class="kv"><span class="k">总成本</span><span class="v mono">{fmtCost(cost)}</span></div>
  <div class="kv"><span class="k">用户消息</span><span class="v mono">{userMsgs}</span></div>
  <div class="kv"><span class="k">助手消息</span><span class="v mono">{asstMsgs}</span></div>
</div>

<style>
  .spec { display: flex; flex-direction: column; }
  .bar {
    height: 6px;
    background: var(--bg-input);
    border-radius: var(--radius-bar);
    overflow: hidden;
    margin: 2px 0 8px;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-bar);
    transition: width .3s ease;
  }
  .kv {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 0;
    border-bottom: 1px solid var(--border-2);
  }
  .kv:last-child { border-bottom: none; }
  .k { color: var(--text-3); font-size: 12px; }
  .v { color: var(--text); font-size: 12px; text-align: right; overflow-wrap: anywhere; }
</style>
