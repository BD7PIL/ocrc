<script lang="ts">
  import type { ExtractStructuredCard, ToolBlock, TextBlock, ReasoningBlock, ToolCall } from '../api/types.js'
  import MarkdownView from './MarkdownView.svelte'
  import ToolCallList from './ToolCallList.svelte'

  export let card: ExtractStructuredCard<'streaming'>

  type Seg =
    | { kind: 'text'; text: string }
    | { kind: 'tools'; tools: ToolCall[] }
    | { kind: 'reasoning'; text: string }

  // Walk blocks in first-seen order, coalescing consecutive same-kind blocks.
  // The transcript reads in true execution order — tools used to be pinned
  // above all text, which lied about what happened when (opencode-web parity).
  $: segments = (() => {
    const out: Seg[] = []
    for (const b of card.blocks as Array<TextBlock | ToolBlock | ReasoningBlock>) {
      if (b.type === 'text') {
        const last = out[out.length - 1]
        if (last?.kind === 'text') last.text += b.text
        else out.push({ kind: 'text', text: b.text })
      } else if (b.type === 'tool') {
        const last = out[out.length - 1]
        const t = { tool: b.tool, args: b.args, status: b.status, partId: b.partId, messageId: b.messageId }
        if (last?.kind === 'tools') last.tools.push(t)
        else out.push({ kind: 'tools', tools: [t] })
      } else if (b.type === 'reasoning') {
        const last = out[out.length - 1]
        if (last?.kind === 'reasoning') last.text += b.text
        else out.push({ kind: 'reasoning', text: b.text })
      }
    }
    return out
  })()

  // "Thinking" pulses only while reasoning is the frontier (no later segment
  // has started yet); once text/tools follow, it's a finished thought.
  $: reasoningLive = segments.length > 0 && segments[segments.length - 1].kind === 'reasoning'
  let thinkOpen = false
</script>

<div class="card streaming">
  {#each segments as seg}
    {#if seg.kind === 'text'}
      {#if seg.text.trim()}<div class="text"><MarkdownView src={seg.text} throttle streaming /></div>{/if}
    {:else if seg.kind === 'tools'}
      <ToolCallList tools={seg.tools} sessionId={card.sessionId} />
    {:else if seg.text.trim()}
      <div class="think">
        <button class="think-head" on:click={() => (thinkOpen = !thinkOpen)} aria-expanded={thinkOpen}>
          {#if reasoningLive}<span class="think-dot" aria-hidden="true"></span>{/if}
          <span class="think-label">{reasoningLive ? '思考中…' : '思考过程'}</span>
          <svg class="think-caret" class:open={thinkOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        {#if thinkOpen}<pre class="think-body">{seg.text}</pre>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .card {
    align-self: stretch;
    width: 100%;
    padding: 4px 2px 8px;
    margin: 6px 0 18px;
  }
  /* In-progress streaming reads as muted "thinking"; the finalized answer
     (CardAssistant) renders full-size in normal text. */
  .text { color: var(--text-2); font-size: 13px; line-height: 1.6; }
  .text :global(.md) { font-size: 13px; color: var(--text-2); line-height: 1.6; }
  .text + .text { margin-top: 8px; }

  /* Live reasoning — quiet, collapsible, clearly secondary to the answer. */
  .think { margin: 2px 0 10px; }
  .think-head {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 2px 0;
    color: var(--text-3);
    cursor: pointer;
    font-size: 12px;
  }
  .think-head:hover { color: var(--text-2); }
  .think-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .think-label { font-style: italic; }
  .think-caret { width: 12px; height: 12px; transition: transform .15s ease; }
  .think-caret.open { transform: rotate(90deg); }
  .think-body {
    margin: 6px 0 0;
    padding: 8px 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
  }
</style>
