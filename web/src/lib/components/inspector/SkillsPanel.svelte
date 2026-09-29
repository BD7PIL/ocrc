<!-- src/lib/components/inspector/SkillsPanel.svelte — M8: agent skills
     (GET /skill via the backend), read-only list. -->
<script lang="ts">
  import { api, type SkillRow } from '$lib/api/client.js'

  export let tick = 0

  let skills: SkillRow[] = []
  let expanded = false
  $: shown = expanded ? skills : skills.slice(0, 18)

  async function load() {
    try { skills = (await api.skills()).skills ?? [] } catch { /* keep */ }
  }
  $: load(), tick
</script>

<div class="skills">
  {#if skills.length > 0}
    <div class="chips" class:clipped={!expanded && skills.length > 18}>
      {#each shown as s (s.name)}
        <span class="chip" title={s.description ?? s.name}>{s.name}</span>
      {/each}
    </div>
    {#if skills.length > 18}
      <button class="more" on:click={() => (expanded = !expanded)}>
        {expanded ? '收起' : `展开全部 ${skills.length}`}
      </button>
    {/if}
  {:else}
    <div class="label">none</div>
  {/if}
</div>

<style>
  .skills { font-size: 11.5px; }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .chips {
    display: flex; flex-wrap: wrap; gap: 4px;
    margin-top: 6px;
    animation: ocrc-fade 150ms var(--ease-out, ease-out);
  }
  .chips.clipped { max-height: 132px; overflow: hidden; mask-image: linear-gradient(to bottom, #000 70%, transparent); }
  .chip {
    padding: 2px 7px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: 10.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .more {
    margin-top: 5px;
    padding: 0;
    background: transparent; border: none;
    color: var(--text-3);
    font: inherit; font-size: 10.5px;
    cursor: pointer; text-align: left;
  }
  .more:hover { color: var(--accent); }
</style>
