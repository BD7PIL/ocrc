<script lang="ts">
  import { connection } from '../stores/connection.js'

  // r7 flow review: the banner was purely informational — the WS backoff was
  // the only recovery. This asks the layout for an immediate reconnect.
  function retry() {
    window.dispatchEvent(new CustomEvent('ocrc:ws-reconnect'))
  }
</script>

{#if $connection !== 'connected'}
  <div class="banner" class:offline={$connection === 'offline'} role="status">
    {#if $connection === 'reconnecting'}
      Reconnecting…
    {:else}
      Offline — live updates paused
    {/if}
    <button on:click={retry}>立即重连</button>
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
    /* Slide in from under the header on mount; removal stays instant
       (rule 4: transform/opacity only, 120–220ms). */
    animation: banner-drop 180ms var(--ease-out, ease-out);
  }
  @keyframes banner-drop {
    from { transform: translateY(-100%); }
    to { transform: translateY(0); }
  }
  .banner.offline {
    background: color-mix(in srgb, var(--err) 14%, var(--bg));
    color: var(--err);
    border-bottom-color: color-mix(in srgb, var(--err) 32%, transparent);
  }
  .banner button {
    margin-left: 10px;
    padding: 1px 8px;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: var(--radius-xs);
    color: inherit;
    font-size: inherit;
    cursor: pointer;
  }
  .banner button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
</style>
