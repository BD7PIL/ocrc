<!-- src/lib/components/inspector/McpPanel.svelte -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  export let tick = 0
  let servers: Array<{ name: string; status: string }> = []
  async function load() { try { servers = await api.mcp() } catch { /* keep */ } }
  $: load(), tick
</script>
<div class="mcp">
  <div class="list">
    {#each servers as m}<div class="row" class:off={m.status === 'disabled'}><span class="dot" aria-hidden="true"></span><span>{m.name}</span><span class="sr-only">{m.status}</span></div>{/each}
    {#if servers.length === 0}<div class="label">未配置</div>{/if}
  </div>
</div>
<style>
  .mcp { font-size: 11.5px; }
  .list { display: flex; flex-direction: column; gap: 4px; color: var(--text-2); margin-top: 6px; }
  .row { display: flex; align-items: center; gap: 7px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
  .row.off { color: var(--text-3); }
  .row.off .dot { background: var(--text-3); }
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
</style>
