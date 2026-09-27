<!-- src/lib/components/inspector/SkillsPanel.svelte — M8: agent skills
     (GET /skill via the backend), read-only list. -->
<script lang="ts">
  import { api, type SkillRow } from '$lib/api/client.js'

  export let tick = 0

  let skills: SkillRow[] = []

  async function load() {
    try { skills = (await api.skills()).skills ?? [] } catch { /* keep */ }
  }
  $: load(), tick
</script>

<div class="skills">
  <div class="label">Skills</div>
  <div class="list">
    {#each skills as s (s.name)}
      <div class="row" title={s.description}>
        <span class="name">{s.name}</span>
      </div>
    {/each}
    {#if skills.length === 0}<div class="label">none</div>{/if}
  </div>
</div>

<style>
  .skills { font-size: 11.5px; }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .list { display: flex; flex-direction: column; gap: 4px; color: var(--text-2); margin-top: 6px; }
  .row { display: flex; align-items: center; gap: 7px; }
  .name { font-size: 11.5px; }
</style>
