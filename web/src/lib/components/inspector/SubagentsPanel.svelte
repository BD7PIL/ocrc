<!-- SubagentsPanel.svelte — 子代理 tab: live list of child sessions (running
     first), and an INLINE live transcript per child — watch a subagent work
     without leaving the session (ZCode right-pane register). -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  import MarkdownView from '../MarkdownView.svelte'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  interface Row { id: string; title: string; done: number; total: number; busy?: boolean }

  let subs: Row[] = []
  let loading = false
  let selected: string | undefined

  async function loadSubs() {
    if (!sessionId) { subs = []; return }
    loading = true
    try {
      const r = await api.subagents(sessionId)
      subs = [...(r.subagents ?? [])].sort((a, b) => Number(b.busy ?? false) - Number(a.busy ?? false))
    } catch { subs = [] } finally { loading = false }
  }
  $: if (sessionId) { void sessionId, tick, loadSubs() }
  // Selection dies with the session switch (or if the child vanished).
  $: if (selected && !subs.some((s) => s.id === selected)) selected = undefined

  // ── Inline live transcript for the selected child ──
  type Lite = { kind: string; text: string; tool?: string; args?: string; status?: string }
  let transcript: Lite[] = []
  let tLoading = false
  const TAIL = 40

  async function loadTranscript(childId: string) {
    tLoading = true
    try {
      const res = await api.history(childId, { limit: TAIL })
      const cards = (res.cards ?? []) as Array<Record<string, any>>
      const out: Lite[] = []
      for (const c of cards) {
        if (c.kind === 'user') out.push({ kind: 'user', text: String(c.text ?? '') })
        else if (c.kind === 'assistant') {
          for (const b of (c.blocks ?? []) as Array<any>) {
            if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'assistant', text: b.text })
            else if (b.type === 'tool') out.push({ kind: 'tool', tool: b.tool, args: b.args, status: b.status })
          }
        } else if (c.kind === 'error') out.push({ kind: 'error', text: String(c.message ?? '') })
      }
      transcript = out.slice(-TAIL)
    } catch { transcript = [] } finally { tLoading = false }
  }
  // Tick refreshes ONLY the open transcript (the list refreshes above) — a
  // running child's output arrives without leaving the pane.
  $: if (selected && tick) { void selected, tick, loadTranscript(selected) }
  $: if (!sessionId) { selected = undefined; transcript = [] }
</script>

<div class="subs">
  {#if !selected}
    {#each subs as s (s.id)}
      <button class="row" on:click={() => { selected = s.id; void loadTranscript(s.id) }}>
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
  {:else}
    <div class="t-hd">
      <button class="back" on:click={() => { selected = undefined; transcript = [] }}>← 返回列表</button>
      <span class="live-hint mono">{tLoading ? '刷新中…' : '实况'}</span>
    </div>
    <div class="t-body">
      {#each transcript as t, i}
        {#if t.kind === 'user'}
          <div class="ln user"><span class="who mono">用户</span><span class="tx">{t.text}</span></div>
        {:else if t.kind === 'assistant'}
          <div class="ln md"><MarkdownView src={t.text} /></div>
        {:else if t.kind === 'tool'}
          <div class="ln tool mono"><span class="who mono">{t.tool}</span><span class="tx mono">{(t.args ?? '').slice(0, 120)}</span></div>
        {:else if t.kind === 'error'}
          <div class="ln err mono">{t.text}</div>
        {/if}
      {:else}
        <div class="empty">{tLoading ? '…' : '（无输出）'}</div>
      {/each}
    </div>
  {/if}
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

  .t-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .back {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .live-hint { font-size: 10px; color: var(--text-3); }
  .t-body { display: flex; flex-direction: column; gap: 10px; }
  .ln.user { display: flex; gap: 8px; padding: 6px 8px; background: var(--bg-input); border-radius: var(--radius-xs); }
  .who { flex-shrink: 0; font-size: 9.5px; color: var(--text-3); padding-top: 2px; }
  .ln.user .tx { color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
  .ln.md { font-size: 12px; color: var(--text-2); }
  .ln.md :global(.md) { font-size: 12px; color: var(--text-2); }
  .ln.tool {
    display: flex;
    gap: 8px;
    font-size: 10.5px;
    color: var(--text-3);
    padding-left: 8px;
    border-left: 2px solid var(--border-2);
  }
  .ln.tool .who { color: var(--text-2); }
  .ln.tool .tx { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ln.err { color: var(--err); font-size: 11px; }
</style>
