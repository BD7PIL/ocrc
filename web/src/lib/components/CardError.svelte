<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type { ExtractStructuredCard } from '../api/types.js'

  export let card: ExtractStructuredCard<'error'>
  /** Provided when the failure is recoverable by re-sending the last message. */
  export let onRetry: (() => void) | undefined = undefined

  const dispatch = createEventDispatcher<{ retry: void }>()

  // Classify by cause so the recovery action is honest (baseline: never a
  // generic "Something went wrong" without a next step).
  function classify(m: string): { label: string; retryable: boolean } {
    const s = (m || '').toLowerCase()
    if (s.includes('abort')) return { label: 'Stopped', retryable: false }
    if (s.includes('timeout') || s.includes('timed out')) return { label: 'Timed out', retryable: true }
    if (s.includes('fetch') || s.includes('network') || s.includes('econn') || /\b(429|500|502|503|504)\b/.test(s))
      return { label: 'Network issue', retryable: true }
    return { label: 'Error', retryable: true }
  }

  $: kind = classify(card.message)

  function retry() {
    if (onRetry) onRetry()
    else dispatch('retry')
  }
</script>

<div class="card error">
  <div class="head"><span class="ico" aria-hidden="true">⚠</span> {kind.label}</div>
  <code>{card.message}</code>
  {#if kind.retryable}
    <button class="retry" on:click={retry} disabled={!onRetry}>↻ Retry</button>
  {/if}
</div>

<style>
  .card {
    align-self: flex-start;
    max-width: 80%;
    margin: 4px 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--err);
    background: color-mix(in srgb, var(--err) 8%, transparent);
    line-height: 1.4;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--err);
  }
  .retry {
    margin-top: 7px;
    padding: 4px 11px;
    background: transparent;
    border: 1px solid var(--err);
    border-radius: var(--radius-pill);
    color: var(--err);
    font-size: 11.5px;
    cursor: pointer;
  }
  .retry:hover { background: var(--err); color: var(--accent-ink); }
  code {
    display: block;
    margin-top: 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    background: var(--bg);
    border: 1px solid var(--border-2);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
