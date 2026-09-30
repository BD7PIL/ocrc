<script lang="ts">
  import { api } from '$lib/api/client.js'
  import Icon from './Icon.svelte'

  export let sessionId: string

  type ControlOption = { id: string; name: string }
  type ControlGroup = { current?: string; options: ControlOption[] }
  type Controls = { mode?: ControlGroup; model?: ControlGroup }

  let controls: Controls = {}
  let openPanel: 'mode' | 'model' | null = null

  async function load() {
    const sid = sessionId
    try {
      const res = await api.controls(sid)
      // Session switched while the request was in flight — drop the stale result.
      if (sid !== sessionId) return
      controls = res
    } catch {
      if (sid === sessionId) controls = {}
    }
  }

  $: if (sessionId) load()

  async function pickMode(id: string) {
    if (controls.mode) controls.mode = { ...controls.mode, current: id }
    openPanel = null
    try { await api.setMode(sessionId, id) } catch { /* ignore */ }
    await load()
  }

  async function pickModel(id: string) {
    if (controls.model) controls.model = { ...controls.model, current: id }
    openPanel = null
    try { await api.setModel(sessionId, id) } catch { /* ignore */ }
    await load()
  }

  function toggle(panel: 'mode' | 'model') {
    openPanel = openPanel === panel ? null : panel
  }

  let rootEl: HTMLElement
  function onWindowKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && openPanel) openPanel = null
  }
  function onWindowClick(e: MouseEvent) {
    if (openPanel && rootEl && !rootEl.contains(e.target as Node)) openPanel = null
  }

  $: modeOpts = controls.mode?.options ?? []
  $: modelOpts = controls.model?.options ?? []
  $: modeLabel = controls.mode?.options.find(o => o.id === controls.mode?.current)?.name ?? controls.mode?.current ?? 'mode'
  $: modelLabel = controls.model?.options.find(o => o.id === controls.model?.current)?.name ?? controls.model?.current ?? 'model'
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="controls" bind:this={rootEl}>
{#if modeOpts.length > 0}
  <div class="wrap">
    <button class="chip mono" aria-haspopup="listbox" aria-expanded={openPanel === 'mode'} on:click={() => toggle('mode')}><Icon name="bolt" size={11} /> <span class="txt">{modeLabel}</span> <Icon name="caret-down" size={9} /></button>
    {#if openPanel === 'mode'}
      <div class="pop" role="listbox" aria-label="Mode">
        <div class="label">Mode</div>
        {#each modeOpts as o}
          <button class="opt" class:sel={o.id === controls.mode?.current} role="option" aria-selected={o.id === controls.mode?.current} on:click={() => pickMode(o.id)}>
            {o.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if modelOpts.length > 0}
  <div class="wrap">
    <button class="chip mono" aria-haspopup="listbox" aria-expanded={openPanel === 'model'} on:click={() => toggle('model')}><Icon name="cpu" size={11} /> <span class="txt">{modelLabel}</span> <Icon name="caret-down" size={9} /></button>
    {#if openPanel === 'model'}
      <div class="pop" role="listbox" aria-label="Model">
        <div class="label">Model</div>
        {#each modelOpts as o}
          <button class="opt" class:sel={o.id === controls.model?.current} role="option" aria-selected={o.id === controls.model?.current} on:click={() => pickModel(o.id)}>
            {o.name}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
</div>

<style>
  /* display:contents keeps the chips as direct flex items of the composer footer;
     the wrapper only exists so outside-click can test containment. */
  .controls { display: contents; }
  .wrap { position: relative; min-width: 0; }
  /* Same contract as AgentChip/ModelChip: the chip tracks its wrap's width and
     the label truncates — the mobile footer shrinks wraps, chips must follow. */
  .chip { display: flex; align-items: center; gap: 5px; min-height: 24px; min-width: 0; max-width: 100%; box-sizing: border-box; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: var(--radius-pill); padding: 5px 11px; font-size: 11.5px; white-space: nowrap; cursor: pointer; transition: border-color .15s, color .15s; }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .chip :global(svg) { flex-shrink: 0; }
  .txt { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .pop { position: absolute; bottom: 44px; left: 0; width: 220px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; box-shadow: 0 16px 40px rgba(0,0,0,.5); z-index: var(--z-popover); }
  .opt { display: flex; align-items: center; width: 100%; background: transparent; border: none; color: var(--text); padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12px; }
  .opt:hover, .opt.sel { background: var(--accent-2); }
</style>
