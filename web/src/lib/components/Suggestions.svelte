<!-- Suggestions — tappable follow-up drafts above the composer.
     Interaction ruling (user-approved): a chip NEVER sends directly — it fills
     the composer and focuses it, so every send stays human-confirmed.
     Sources: Tier1 state heuristics (starters) and Tier2 model-generated
     follow-ups (ephemeral-session call, replaces the starters when ready). -->
<script lang="ts">
  export let suggestions: string[] = []

  export let onPick: (text: string) => void = () => {}
  export let onDismiss: () => void = () => {}
</script>

{#if suggestions.length > 0}
  <div class="suggestions" role="list" aria-label="Suggested follow-ups">
    {#each suggestions as s (s)}
      <button class="chip" role="listitem" on:click={() => onPick(s)}>{s}</button>
    {/each}
    <button class="dismiss" on:click={onDismiss} aria-label="Dismiss suggestions">✕</button>
  </div>
{/if}

<style>
  .suggestions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 max(24px, calc((100% - 720px) / 2 + 24px)) 10px;
  }
  .chip {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: 12px;
    padding: 6px 13px;
    cursor: pointer;
    transition: border-color .12s var(--ease, ease), color .12s var(--ease, ease);
  }
  .chip:hover { border-color: var(--accent); color: var(--text); }
  .dismiss {
    background: transparent;
    border: none;
    color: var(--text-4);
    font-size: 12px;
    cursor: pointer;
    padding: 6px 8px;
  }
  .dismiss:hover { color: var(--text-2); }
</style>
