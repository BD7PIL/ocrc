<!-- src/lib/components/EffortChip.svelte — reasoning-effort override picker
     (composer). ModelChip's sibling: same wrap/chip/pop skeleton, same
     overrides store — variant rides every message body (opencode v1.18 model
     variants, e.g. glm-5.3-flash: low/high/max). -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api/client.js'
  import Icon from './Icon.svelte'

  let open = false
  let wrap: HTMLElement
  let providers: Array<{ id: string; models: Array<{ id: string; name?: string; variants?: string[] }> }> = []
  let current: { agent: string | null; model: { providerID: string; modelID: string } | null; variant?: string | null } = { agent: null, model: null }

  async function refresh() {
    try {
      [providers, current] = await Promise.all([api.models(), api.getOverrides()])
    } catch { /* ignore */ }
  }
  onMount(refresh)

  async function pick(v: string | null) {
    await api.setOverrides({ variant: v })
    await refresh(); open = false
  }

  function onWindowKey(e: KeyboardEvent) { if (e.key === 'Escape' && open) open = false }
  function onWindowClick(e: MouseEvent) { if (open && wrap && !wrap.contains(e.target as Node)) open = false }

  // Variants of the CURRENT model — hidden entirely when the model exposes none.
  $: modelVariants = (() => {
    const modelID = current.model?.modelID
    for (const p of providers) {
      const hit = (p.models ?? []).find((m) => m.id === modelID)
      if (hit?.variants?.length) return hit.variants
    }
    return []
  })()
  $: label = current.variant || '默认'
</script>

<svelte:window on:keydown={onWindowKey} on:click={onWindowClick} />

<div class="wrap" bind:this={wrap}>
  <button class="chip mono" aria-haspopup="listbox" aria-expanded={open} title="推理强度（当前模型：{current.model?.modelID ?? '—'}）"
          on:click={() => { open = !open; if (open) refresh() }}>
    <Icon name="brain" size={11} />
    <span class="txt">{label}</span>
    <Icon name="caret-down" size={9} />
  </button>
  {#if open}
    <div class="pop" role="listbox" aria-label="推理强度覆盖">
      {#if modelVariants.length === 0}
        <div class="none label">当前模型无推理档位</div>
      {/if}
      <button class="opt" class:sel={!current.variant} role="option" aria-selected={!current.variant} on:click={() => pick(null)}>
        <span>默认</span>
      </button>
      {#each modelVariants as v (v)}
        <button class="opt" class:sel={current.variant === v} role="option" aria-selected={current.variant === v} on:click={() => pick(v)}>
          <span>{v}</span>
        </button>
      {/each}
      <button class="opt clear" role="option" aria-selected={false} on:click={() => pick(null)}>
        <Icon name="close" size={11} /> 清除覆盖
      </button>
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; min-width: 0; }
  .chip {
    display: flex; align-items: center; gap: 5px;
    min-height: 24px; min-width: 0; max-width: min(150px, 100%);
    box-sizing: border-box;
    background: transparent; border: 1px solid var(--border);
    color: var(--text-2); border-radius: var(--radius-pill);
    padding: 5px 11px; font-size: 11.5px; white-space: nowrap; cursor: pointer;
    transition: border-color .15s, color .15s;
  }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .chip :global(svg) { flex-shrink: 0; }
  .txt { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .pop {
    position: absolute; bottom: 36px; right: 0; width: 180px;
    max-height: min(52vh, 360px); overflow-y: auto;
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 8px;
    box-shadow: 0 16px 40px rgba(0,0,0,.5);
    z-index: var(--z-popover);
  }
  .opt {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; background: transparent; border: none; color: var(--text);
    padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer;
    font-size: 12px; text-align: left;
  }
  .opt:hover, .opt.sel { background: var(--accent-2); }
  .clear { color: var(--text-3); margin-top: 4px; }
  .none { padding: 6px 8px; }
</style>
