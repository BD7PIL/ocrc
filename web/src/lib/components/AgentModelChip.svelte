<!-- src/lib/components/AgentModelChip.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api/client.js'
  import Icon from './Icon.svelte'
  let open = false
  let wrap: HTMLElement
  let agents: Array<{ name: string; model: string }> = []
  // Full provider/model catalog — the same source the TG 🧠 menu lists, so
  // user-level providers (xiaomi/deepseek/…) are pickable here too.
  let providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }> = []
  let current = { agent: null as string | null, model: null as { providerID: string; modelID: string } | null }

  async function refresh() {
    try {
      ;[agents, providers, current] = await Promise.all([api.agents(), api.models(), api.getOverrides()])
    } catch { /* ignore */ }
  }
  onMount(refresh)

  function parseModel(m: string) { const i = m.indexOf('/'); return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : null }
  async function pick(a: { name: string; model: string }) {
    await api.setOverrides({ agent: a.name, model: parseModel(a.model) })
    await refresh(); open = false
  }
  // Model-only pick — agent override stays untouched ('model' in body semantics).
  async function pickModel(providerID: string, modelID: string) {
    await api.setOverrides({ model: { providerID, modelID } })
    await refresh(); open = false
  }
  function modelRowClass(providerID: string, modelID: string) {
    return current.model?.providerID === providerID && current.model?.modelID === modelID ? 'opt sel' : 'opt'
  }
  async function clear() { await api.setOverrides({ agent: null, model: null }); await refresh(); open = false }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) open = false
  }
  function onWindowClick(e: MouseEvent) {
    if (open && wrap && !wrap.contains(e.target as Node)) open = false
  }

  $: label = current.agent ? `${current.agent}${current.model ? ' · ' + current.model.modelID : ''}` : 'default'
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="wrap" bind:this={wrap}>
  <button class="chip mono" aria-haspopup="listbox" aria-expanded={open} on:click={() => { open = !open; if (open) refresh() }}><Icon name="gear" size={11} /> {label} <Icon name="caret-down" size={9} /></button>
  {#if open}
    <div class="pop" role="listbox" aria-label="Agent and model override">
      <div class="label">Agent</div>
      {#if agents.length === 0}<div class="none label">no agents configured</div>{/if}
      {#each agents as a}
        <button class="opt" class:sel={a.name === current.agent} role="option" aria-selected={a.name === current.agent} on:click={() => pick(a)}>
          <span>{a.name}</span> <span class="label mono">{a.model.split('/').pop()}</span>
        </button>
      {/each}
      <div class="label">Model</div>
      {#if providers.length === 0}<div class="none label">no models</div>{/if}
      {#each providers as p (p.id)}
        <div class="prov label mono">{p.id}</div>
        {#each p.models as mo (mo.id)}
          <button class={modelRowClass(p.id, mo.id)} role="option" aria-selected={current.model?.providerID === p.id && current.model?.modelID === mo.id} on:click={() => pickModel(p.id, mo.id)}>
            <span>{mo.name || mo.id}</span>
          </button>
        {/each}
      {/each}
      <button class="opt clear" role="option" aria-selected={current.agent == null && current.model == null} on:click={clear}><Icon name="close" size={11} /> clear override</button>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; }
  .chip { display: flex; align-items: center; gap: 5px; min-height: 24px; box-sizing: border-box; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: var(--radius-pill); padding: 5px 11px; font-size: 11.5px; white-space: nowrap; cursor: pointer; transition: border-color .15s, color .15s; }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .pop { position: absolute; bottom: 44px; left: 0; width: 248px; max-height: min(60vh, 420px); overflow-y: auto; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; box-shadow: 0 16px 40px rgba(0,0,0,.5); z-index: var(--z-popover); }
  .prov { padding: 7px 8px 2px; color: var(--text-3); }
  .opt { display: flex; justify-content: space-between; align-items: center; width: 100%; background: transparent; border: none; color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; text-align: left; }
  .opt:hover, .opt.sel { background: var(--accent-2); }
  .clear { color: var(--text-3); margin-top: 4px; }
  .none { padding: 6px 8px; }
</style>
