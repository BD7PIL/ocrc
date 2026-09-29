<!-- Fold.svelte — inspector section collapse (M14 desktop pass). The right
     panel used to be one long stack where SKILLS/FILES pushed everything
     below the fold; sections are now collapsible, persisted in
     localStorage (ocrc.insp). -->
<script lang="ts">
  export let key: string
  export let title: string
  export let defaultOpen = true

  const STORE = 'ocrc.insp'
  let open = defaultOpen
  try {
    const j = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, boolean>
    if (typeof j[key] === 'boolean') open = j[key]
  } catch { /* private mode */ }

  function toggle() {
    open = !open
    try {
      const j = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, boolean>
      j[key] = open
      localStorage.setItem(STORE, JSON.stringify(j))
    } catch { /* private mode */ }
  }
</script>

<section class="fold">
  <button class="hd" on:click={toggle} aria-expanded={open}>
    <svg class="caret" class:open viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    <span class="t">{title}</span>
    <slot name="hd" />
  </button>
  {#if open}
    <div class="body"><slot /></div>
  {/if}
</section>

<style>
  .fold { display: flex; flex-direction: column; }
  .hd {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 2px -4px;
    padding: 3px 4px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    cursor: pointer;
    text-align: left;
  }
  .hd:hover { color: var(--text-2); background: var(--bg-elev); }
  .caret {
    width: 11px; height: 11px; flex-shrink: 0;
    transition: transform .16s ease;
    transform: rotate(0deg);
  }
  .caret.open { transform: rotate(90deg); }
  .t {
    text-transform: uppercase;
    letter-spacing: .14em;
    font-size: 9.5px;
    font-weight: 600;
  }
  .body { animation: ocrc-fade 150ms var(--ease-out, ease-out); }
</style>
