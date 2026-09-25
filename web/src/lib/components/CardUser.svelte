<script lang="ts">
  import type { ExtractStructuredCard } from '../api/types.js'
  export let card: ExtractStructuredCard<'user'>
</script>

<div class="card user">{card.text}</div>

<style>
  .card {
    align-self: flex-end;
    max-width: 82%;
    padding: 11px 16px;
    border-radius: 18px 18px 4px 18px;
    margin: 14px 0 6px;
    line-height: 1.55;
    font-size: 14px;
    background: var(--user-bubble);
    color: var(--user-ink);
    /* paper-ink bubble rule: single ladder step + hairline, no shadow, no gradient */
    border: 1px solid var(--bubbleline);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
