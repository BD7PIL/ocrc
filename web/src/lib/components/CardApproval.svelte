<!-- src/lib/components/CardApproval.svelte -->
<script lang="ts">
  import type { ExtractStructuredCard } from '../api/types.js'
  import { api } from '../api/client.js'
  export let card: ExtractStructuredCard<'approval'>
  let done = ''
  async function decide(decision: 'once' | 'always' | 'reject') {
    try { await api.approve(card.sessionId, card.requestId, decision); done = decision } catch { done = 'error' }
  }
  const LABEL: Record<string, string> = {
    once: '已批准 — 已应用',
    always: '已设为自动允许',
    reject: '已拒绝 — 未应用',
    error: '失败',
  }
  $: resolved = !!done
  $: isReject = done === 'reject' || done === 'error'
  $: diffText = typeof card.args === 'string' ? card.args : JSON.stringify(card.args, null, 2)
</script>

{#if resolved}
  <div class="appr resolved" class:rej={isReject}>
    <span class="mark" aria-hidden="true">{isReject ? '✕' : '✓'}</span>
    <span class="rlabel">{LABEL[done] ?? done}</span>
    <span class="rttl">{card.title}</span>
  </div>
{:else}
  <div class="appr pending">
    <div class="header">
      <span class="warn-dot" aria-hidden="true"></span>
      <span class="label">需要审批</span>
      <span class="rule" aria-hidden="true"></span>
      <span class="tool mono">{card.title}</span>
    </div>
    <pre class="diff mono">{diffText}</pre>
    <div class="acts">
      <button class="a allow" on:click={() => decide('once')}>批准</button>
      <button class="a always" on:click={() => decide('always')}>总是允许</button>
      <span class="spacer"></span>
      <button class="a rej" on:click={() => decide('reject')}>拒绝</button>
    </div>
  </div>
{/if}

<style>
  .appr {
    align-self: stretch;
    width: 100%;
    margin: 6px 0 14px;
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
  }
  .appr.pending {
    border-color: var(--warn);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    background: color-mix(in srgb, var(--warn) 8%, transparent);
    border-bottom: 1px solid var(--border-2);
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  }
  .warn-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
    flex-shrink: 0;
  }
  .label {
    font-size: 10px;
    font-weight: 650;
    letter-spacing: .08em;
    color: var(--warn);
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--border-2);
    opacity: .7;
  }
  .tool {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
  }
  .diff {
    margin: 10px 12px;
    padding: 8px 10px;
    background: var(--bg-code);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 12px;
  }
  .spacer { flex: 1; }
  .a {
    min-height: 40px;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: background .15s ease, border-color .15s ease, color .15s ease;
  }
  .a.allow {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .a.allow:hover { opacity: .9; }
  .a.always {
    background: transparent;
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .a.always:hover { background: var(--accent-2); }
  .a.rej {
    background: transparent;
    border-color: var(--border-2);
    color: var(--text-3);
  }
  .a.rej:hover { color: var(--err); border-color: var(--err); }

  .appr.resolved {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: none;
    font-size: 12px;
    color: var(--text-3);
  }
  .appr.resolved .mark { color: var(--accent); font-weight: 700; }
  .appr.resolved.rej .mark { color: var(--err); }
  .appr.resolved .rlabel { color: var(--text-2); font-weight: 600; }
  .appr.resolved .rttl { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
