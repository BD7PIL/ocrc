<!-- SubagentsPanel.svelte — 子代理 pinned tab: the launcher list. Clicking a
     child opens a `sub:<id>` dynamic pane tab with its live transcript
     (ZCode subagent-session register); the list itself stays put. -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  import { openPaneTab } from '$lib/stores/sidePane.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  interface Row { id: string; title: string; done: number; total: number; busy?: boolean }

  let subs: Row[] = []
  let loading = false

  async function load() {
    if (!sessionId) { subs = []; return }
    loading = true
    try {
      const r = await api.subagents(sessionId)
      subs = [...(r.subagents ?? [])].sort((a, b) => Number(b.busy ?? false) - Number(a.busy ?? false))
    } catch { subs = [] } finally { loading = false }
  }
  $: if (sessionId) { void sessionId, tick, load() }

  function open(s: Row) {
    // Stash the parent link so the child session offers a way back (same
    // contract as PlanHud's jump rows).
    try { sessionStorage.setItem(`ocrc.subparent.${s.id}`, sessionId ?? '') } catch { /* private mode */ }
    openPaneTab({ id: `sub:${s.id}`, kind: 'subagent', title: s.title || '…' + s.id.slice(-6), childId: s.id })
  }
</script>

<div class="subs">
  {#each subs as s (s.id)}
    <button class="row" on:click={() => open(s)}>
      <span class="dot" class:live={s.busy} class:done={!s.busy && s.total > 0 && s.done >= s.total} aria-hidden="true"></span>
      <span class="meta">
        <span class="title">{s.title || '…' + s.id.slice(-6)}</span>
        {#if s.total > 0}<span class="count mono">{s.done}/{s.total}</span>{/if}
      </span>
      {#if s.busy}<span class="live-label">运行中</span>{/if}
    </button>
  {/each}
  {#if !loading && subs.length === 0}
    <div class="empty">该会话暂无子代理</div>
  {/if}
  {#if loading}<div class="empty">…</div>{/if}
</div>

<style>
  .subs { font-size: 11.5px; }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 4px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover { background: var(--bg-input); color: var(--text); }
  .dot {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-sizing: border-box;
    background: transparent;
    border: 1.5px solid var(--text-4);
  }
  .dot.live { background: var(--accent); border-color: var(--accent); animation: ocrc-pulse 1.2s ease-in-out infinite; }
  .dot.done { background: var(--ok); border-color: var(--ok); }
  .meta { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { flex-shrink: 0; font-size: 10px; color: var(--text-3); }
  .live-label { flex-shrink: 0; font-size: 10px; color: var(--text-3); }
  .empty { padding: 10px 0; color: var(--text-3); font-size: 11px; }
</style>
