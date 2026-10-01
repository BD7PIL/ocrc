<!-- SubagentSessionTab.svelte — a dynamic pane tab: one subagent's live
     transcript (opened from the 子代理 list or a PlanHud row). Refreshes on
     the pane's activity tick while the child is producing output; a header
     button navigates the middle column into the child session. -->
<script lang="ts">
  import { goto } from '$app/navigation'
  import { api } from '$lib/api/client.js'
  import MarkdownView from '../MarkdownView.svelte'

  export let childId: string
  export let tick = 0

  type Lite = { kind: string; text?: string; tool?: string; args?: string; status?: string }
  const TAIL = 40

  let transcript: Lite[] = []
  let loading = false

  async function load() {
    loading = true
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
    } catch { transcript = [] } finally { loading = false }
  }
  $: if (childId) { void childId, tick, load() }
</script>

<div class="t-wrap">
  <div class="t-hd">
    <span class="t-hint mono">{loading ? '刷新中…' : '实况 · 最近 ' + TAIL + ' 条'}</span>
    <button class="open" on:click={() => goto('/' + childId)}>在中栏打开此会话 →</button>
  </div>
  <div class="t-body">
    {#each transcript as t}
      {#if t.kind === 'user'}
        <div class="ln user"><span class="who mono">用户</span><span class="tx">{t.text}</span></div>
      {:else if t.kind === 'assistant'}
        <div class="ln md"><MarkdownView src={t.text ?? ''} /></div>
      {:else if t.kind === 'tool'}
        <div class="ln tool mono"><span class="who mono">{t.tool}</span><span class="tx mono">{(t.args ?? '').slice(0, 120)}</span></div>
      {:else if t.kind === 'error'}
        <div class="ln err mono">{t.text}</div>
      {/if}
    {:else}
      <div class="empty">{loading ? '…' : '（无输出）'}</div>
    {/each}
  </div>
</div>

<style>
  .t-wrap { font-size: 11.5px; }
  .t-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
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
  .empty { padding: 10px 0; color: var(--text-3); font-size: 11px; }
</style>
