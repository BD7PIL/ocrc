<script lang="ts">
  import { connection } from '../stores/connection.js'
</script>

{#if $connection !== 'connected'}
  <div class="banner" class:offline={$connection === 'offline'} role="status">
    {#if $connection === 'reconnecting'}
      Reconnecting…
    {:else}
      Offline — live updates paused
    {/if}
  </div>
{/if}

<style>
  .banner {
    text-align: center;
    font-size: 0.8em;
    padding: 4px 8px;
    background: color-mix(in srgb, var(--warn) 14%, var(--bg));
    color: var(--warn);
    border-bottom: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
  }
  .banner.offline {
    background: color-mix(in srgb, var(--err) 14%, var(--bg));
    color: var(--err);
    border-bottom-color: color-mix(in srgb, var(--err) 32%, transparent);
  }
</style>
