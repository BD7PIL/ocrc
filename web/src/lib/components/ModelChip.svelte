<!-- src/lib/components/ModelChip.svelte — model override picker (composer).
     Lists the connected providers' catalog (the native picker's universe)
     narrowed by the user's opencode config filters (enabled_providers /
     disabled_providers / provider.<id>.models whitelist) — filtering happens
     server-side in getModels. Separate from AgentChip by design. -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api/client.js'
  import Icon from './Icon.svelte'

  let open = false
  let wrap: HTMLElement
  let providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }> = []
  let current: { agent: string | null; model: { providerID: string; modelID: string } | null } = { agent: null, model: null }

  async function refresh() {
    try { [providers, current] = await Promise.all([api.models(), api.getOverrides()]) } catch { /* ignore */ }
  }
  onMount(refresh)

  async function pick(providerID: string, modelID: string) {
    await api.setOverrides({ model: { providerID, modelID } })
    await refresh(); open = false
  }
  async function clear() { await api.setOverrides({ model: null }); await refresh(); open = false }

  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape' && open) open = false }
  function onWindowClick(e: MouseEvent) { if (open && wrap && !wrap.contains(e.target as Node)) open = false }

  $: label = current.model?.modelID ?? 'model'
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="wrap" bind:this={wrap}>
  <button class="chip mono" aria-haspopup="listbox" aria-expanded={open} on:click={() => { open = !open; if (open) refresh() }}>
    <Icon name="bolt" size={11} /> <span class="txt">{label}</span> <Icon name="caret-down" size={9} />
  </button>
  {#if open}
    <div class="pop" role="listbox" aria-label="模型覆盖">
      {#if providers.length === 0}<div class="none label">暂无模型</div>{/if}
      {#each providers as p (p.id)}
        <div class="prov label mono">{p.id}</div>
        {#each p.models as mo (mo.id)}
          <button
            class="opt"
            class:sel={current.model?.providerID === p.id && current.model?.modelID === mo.id}
            role="option"
            aria-selected={current.model?.providerID === p.id && current.model?.modelID === mo.id}
            on:click={() => pick(p.id, mo.id)}
          >
            <span>{mo.name || mo.id}</span>
          </button>
        {/each}
      {/each}
      <button class="opt clear" role="option" aria-selected={current.model == null} on:click={clear}><Icon name="close" size={11} /> 清除覆盖</button>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  /* min(150px, 100%): the 150px desktop cap, but never wider than the
     flex-resolved wrap — the mobile composer shrinks the wrap and this chip
     must truncate with it, not paint over its sibling. */
  .chip { display: flex; align-items: center; gap: 5px; min-height: 24px; min-width: 0; max-width: min(150px, 100%); box-sizing: border-box; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: var(--radius-pill); padding: 5px 11px; font-size: 11.5px; white-space: nowrap; cursor: pointer; transition: border-color .15s, color .15s; }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .chip :global(svg) { flex-shrink: 0; }
  .txt { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .pop { position: absolute; bottom: 36px; right: 0; width: 248px; max-height: min(56vh, 400px); overflow-y: auto; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; box-shadow: 0 16px 40px rgba(0,0,0,.5); z-index: var(--z-popover); }
  .prov { padding: 7px 8px 2px; color: var(--text-3); }
  .opt { display: flex; justify-content: space-between; align-items: center; width: 100%; background: transparent; border: none; color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; text-align: left; }
  .opt:hover, .opt.sel { background: var(--accent-2); }
  .clear { color: var(--text-3); margin-top: 4px; }
  .none { padding: 6px 8px; }
</style>
