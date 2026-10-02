<!-- src/lib/components/AgentChip.svelte — agent override picker (composer).
     Deliberately separate from ModelChip: agent and model are two different
     choices (user ruling) — picking an agent no longer pins its default model. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api/client.js'
  import Icon from './Icon.svelte'

  let open = false
  let wrap: HTMLElement
  let agents: Array<{ name: string; model: string }> = []
  let current: { agent: string | null; model: { providerID: string; modelID: string } | null } = { agent: null, model: null }

  async function refresh() {
    try { [agents, current] = await Promise.all([api.agents(), api.getOverrides()]) } catch { /* ignore */ }
  }
  onMount(refresh)

  async function pick(a: { name: string; model: string }) {
    await api.setOverrides({ agent: a.name })
    await refresh(); open = false
  }
  async function clear() { await api.setOverrides({ agent: null }); await refresh(); open = false }

  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape' && open) open = false }
  function onWindowClick(e: MouseEvent) { if (open && wrap && !wrap.contains(e.target as Node)) open = false }

  $: label = current.agent ?? 'default'
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="wrap" bind:this={wrap}>
  <button class="chip mono" aria-haspopup="listbox" aria-expanded={open} on:click={() => { open = !open; if (open) refresh() }}>
    <Icon name="cpu" size={11} /> <span class="txt">{label}</span> <Icon name="caret-down" size={9} />
  </button>
  <!-- Mobile icon variant (ZCode register): same popover, icon-only trigger. -->
  <button class="chip icon mono" aria-haspopup="listbox" aria-label={`Agent：${label}`} aria-expanded={open} on:click={() => { open = !open; if (open) refresh() }}>
    <Icon name="cpu" size={14} />
  </button>
  {#if open}
    <div class="pop" role="listbox" aria-label="Agent 覆盖">
      {#if agents.length === 0}<div class="none label">未配置 agent</div>{/if}
      {#each agents as a (a.name)}
        <button class="opt" class:sel={a.name === current.agent} role="option" aria-selected={a.name === current.agent} on:click={() => pick(a)}>
          <span>{a.name}</span> <span class="label mono">{a.model.split('/').pop()}</span>
        </button>
      {/each}
      <button class="opt clear" role="option" aria-selected={current.agent == null} on:click={clear}><Icon name="close" size={11} /> 清除覆盖</button>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  /* The chip must track the wrap's flex-resolved width (never overflow it and
     paint over the sibling chip on narrow screens): label is a truncating
     span, icons are fixed, the chip caps at its parent. */
  .chip { display: flex; align-items: center; gap: 5px; min-height: 24px; min-width: 0; max-width: 100%; box-sizing: border-box; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: var(--radius-pill); padding: 5px 11px; font-size: 11.5px; white-space: nowrap; cursor: pointer; transition: border-color .15s, color .15s; }
  .chip :global(.icon), .chip :global(svg) { flex-shrink: 0; }
  .txt { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  /* Mobile icon variant: hidden on desktop, swaps in ≤820px. */
  .chip.icon { display: none; }
  @media (max-width: 820px) {
    .chip { display: none; }
    .chip.icon {
      display: inline-flex;
      justify-content: center;
      min-width: 34px;
      height: 30px;
      padding: 0 8px;
      color: var(--text-2);
    }
  }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .pop { position: absolute; bottom: 36px; left: 0; width: 220px; max-height: min(52vh, 360px); overflow-y: auto; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; box-shadow: 0 16px 40px rgba(0,0,0,.5); z-index: var(--z-popover); }
  .opt { display: flex; justify-content: space-between; align-items: center; width: 100%; background: transparent; border: none; color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; text-align: left; }
  .opt:hover, .opt.sel { background: var(--accent-2); }
  .clear { color: var(--text-3); margin-top: 4px; }
  .none { padding: 6px 8px; }
</style>
