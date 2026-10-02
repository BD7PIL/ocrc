<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { ExtractStructuredCard, ToolBlock, TextBlock } from '../api/types.js'
  import MarkdownView from './MarkdownView.svelte'
  import Icon from './Icon.svelte'
  import ToolCallList from './ToolCallList.svelte'

  export let card: ExtractStructuredCard<'assistant'>
  /** Present only on the last assistant card — re-sends the last user message. */
  export let onRegenerate: (() => void) | undefined = undefined
  /** Present only on the last assistant card — reverts this exchange
   *  (opencode session.revert); the feed refetches from the layout listener. */
  export let onRevert: (() => void) | undefined = undefined
  let reverting = false
  async function revert() {
    if (!onRevert || reverting) return
    if (!confirm('撤销这一轮回复？（可恢复）')) return
    reverting = true
    try { onRevert() } finally { reverting = false }
  }

  $: tools = card.blocks
    .filter((b): b is ToolBlock => b.type === 'tool')
    .map(b => ({ tool: b.tool, args: b.args, status: b.status, partId: b.partId, messageId: b.messageId }))
  $: text = card.blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text).join('')

  function fmtK(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  }
  $: m = card.meta
  $: hasMeta = m.agent || m.model || m.tokens || (m as any).duration != null || m.cost !== undefined

  let copied = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  async function copy() {
    if (!text) return
    try { await navigator.clipboard.writeText(text) } catch { return }
    copied = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied = false), 1300)
  }
  onDestroy(() => clearTimeout(copyTimer))
</script>

<div class="card assistant">
  {#if card.thinkingText}
    <details class="think">
      <summary>思考过程</summary>
      <pre>{card.thinkingText}</pre>
    </details>
  {/if}
  <ToolCallList {tools} sessionId={card.sessionId} />
  {#if text}<div class="text"><MarkdownView src={text} /></div>{/if}
  {#if hasMeta}
    <div class="meta">
      <div class="chips">
        {#if m.agent}<span class="chip agent mono">{m.agent}</span>{/if}
        {#if m.model}<span class="chip mono">{m.model}</span>{/if}
        {#if m.tokens}<span class="chip mono">↑{fmtK(m.tokens.input)} ↓{fmtK(m.tokens.output)}</span>{/if}
        {#if (m as any).duration != null}<span class="chip mono">{(m as any).duration}s</span>{/if}
        {#if m.cost !== undefined}<span class="chip cost mono">${m.cost.toFixed(3)}</span>{/if}
      </div>
      <div class="actions">
        {#if onRegenerate}
          <button class="icon" title="重新生成" aria-label="重新生成" on:click={onRegenerate}><Icon name="refresh" size={13} /></button>
        {/if}
        {#if onRevert}
          <button class="icon" class:reverting title="撤销这一轮" aria-label="撤销这一轮" disabled={reverting} on:click={revert}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>
          </button>
        {/if}
        <button class="icon" class:copied title="复制" aria-label="复制" on:click={copy}>
          {#if copied}<Icon name="check" size={13} />{:else}<Icon name="copy" size={13} />{/if}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .card {
    align-self: stretch;
    width: 100%;
    padding: 4px 2px 8px;
    margin: 6px 0 18px;
  }
  /* The turn's reasoning, preserved from the live stream — collapsed by
     default, plain text (the answer below is the artifact). */
  .think {
    margin: 0 0 10px;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    overflow: hidden;
  }
  .think summary {
    padding: 6px 12px;
    font-size: 12px;
    font-style: italic;
    color: var(--text-3);
    cursor: pointer;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .think summary::before {
    content: '›';
    transition: transform .15s ease;
  }
  .think[open] summary::before { transform: rotate(90deg); }
  .think summary:hover { color: var(--text-2); }
  .think pre {
    margin: 0;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--border-2);
    color: var(--text-3);
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
  }
  .text { color: var(--text); }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
    padding-top: 2px;
  }
  .chips {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
  }
  .chip {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-3);
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-pill);
    padding: 2px 8px;
  }
  /* Orange discipline: the agent chip is metadata, not brand — neutral like
     the other chips. */
  .chip.agent {
    color: var(--text-2);
  }
  .chip.cost { color: var(--warn); }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: transparent;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
    transition: color .15s ease, border-color .15s ease, background .15s ease;
  }
  .icon:hover { color: var(--text); border-color: var(--border); background: var(--bg-elev); }
  .icon.copied { color: var(--accent); border-color: var(--accent-line); background: var(--accent-2); }
  .icon:disabled { opacity: .5; cursor: default; }
</style>
