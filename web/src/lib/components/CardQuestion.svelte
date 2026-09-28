<!-- src/lib/components/CardQuestion.svelte — M10: interactive question tool.
     One card per QuestionRequest; option chips (multi-select when
     `multiple`), free-text when `custom`, or decline. The plugin republishes
     the same card id with `resolved` when answered elsewhere (TUI/Telegram)
     — the upsert swaps this component's content in place. -->
<script lang="ts">
  import type { ExtractStructuredCard } from '../api/types.js'
  import { api } from '../api/client.js'
  import { can } from '../stores/capabilities.js'
  export let card: ExtractStructuredCard<'question'>

  type Q = ExtractStructuredCard<'question'>['questions'][number]

  // Selection state: option indexes per question (arrays keep Svelte reactivity).
  let sel: Record<number, number[]> = {}
  let custom: Record<number, string> = {}
  let done: '' | 'replied' | 'rejected' | 'stale' | 'error' = ''

  $: resolved = card.resolved ?? (done === 'replied' || done === 'rejected' ? done : undefined)
  $: stale = done === 'stale'
  $: answerable = $can('questions')

  function toggle(qi: number, oi: number, multiple: boolean | undefined) {
    const cur = sel[qi] ?? []
    if (multiple) {
      sel = { ...sel, [qi]: cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi] }
    } else {
      sel = { ...sel, [qi]: cur.includes(oi) ? [] : [oi] }
    }
  }

  $: complete = (card.questions ?? []).every((q: Q, qi: number) => {
    if ((custom[qi] ?? '').trim()) return true
    return (sel[qi] ?? []).length > 0
  })

  async function submit() {
    const answers = (card.questions ?? []).map((q: Q, qi: number) => {
      const text = (custom[qi] ?? '').trim()
      if (text) return [text]
      return (sel[qi] ?? []).map((i) => q.options[i]?.label).filter((l): l is string => !!l)
    })
    try {
      const r = await api.answerQuestion(card.sessionId, card.requestId, answers)
      done = r?.stale ? 'stale' : r?.ok ? 'replied' : 'error'
    } catch { done = 'error' }
  }

  async function decline() {
    try {
      const r = await api.rejectQuestion(card.sessionId, card.requestId)
      done = r?.stale ? 'stale' : r?.ok ? 'rejected' : 'error'
    } catch { done = 'error' }
  }

  const RESOLVED_LABEL: Record<string, string> = {
    replied: '已回答',
    rejected: '已取消',
    stale: '已在其他界面回答',
    error: '提交失败',
  }
</script>

{#if resolved || stale}
  <div class="qcard resolved" class:fresh={done !== ''} class:rej={resolved === 'rejected' || stale || done === 'error'}>
    <span class="mark" aria-hidden="true">{resolved === 'replied' ? '✓' : '✕'}</span>
    <span class="rlabel">{RESOLVED_LABEL[resolved ?? done] ?? ''}</span>
    <span class="rttl mono">{card.requestId.slice(0, 12)}</span>
  </div>
{:else}
  <div class="qcard pending">
    <div class="header">
      <span class="q-dot" aria-hidden="true"></span>
      <span class="label">需要你的回答</span>
      <span class="rule" aria-hidden="true"></span>
      {#if !answerable}<span class="mono warn-note">当前后端不支持 Web 回答</span>{/if}
    </div>
    {#each card.questions as q, qi (qi)}
      <div class="q">
        {#if q.header}<div class="qhead mono">{q.header}</div>{/if}
        <div class="qtext">{q.question}</div>
        <div class="opts">
          {#each q.options as opt, oi (oi)}
            <button
              class="opt"
              class:on={(sel[qi] ?? []).includes(oi)}
              title={opt.description ?? opt.label}
              on:click={() => toggle(qi, oi, q.multiple)}
            >{opt.label}</button>
          {/each}
        </div>
        {#if q.custom}
          <input
            class="custom mono"
            placeholder="或输入自定义回答…"
            value={custom[qi] ?? ''}
            on:input={(e) => (custom = { ...custom, [qi]: (e.currentTarget as HTMLInputElement).value })}
          />
        {/if}
        {#if q.multiple}<div class="hint">可多选</div>{/if}
      </div>
    {/each}
    <div class="acts">
      <button class="a send" disabled={!answerable || !complete || done === 'error'} on:click={submit}>提交回答</button>
      <span class="spacer"></span>
      <button class="a rej" disabled={!answerable} on:click={decline}>取消</button>
    </div>
  </div>
{/if}

<style>
  .qcard {
    align-self: stretch;
    width: 100%;
    margin: 6px 0 14px;
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    border: 1px solid var(--accent-line);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-bottom: 1px solid var(--border-2);
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  }
  .q-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent); flex-shrink: 0;
  }
  .label {
    font-size: 10px; font-weight: 650; letter-spacing: .08em;
    color: var(--accent);
  }
  .rule { flex: 1; height: 1px; background: var(--border-2); opacity: .7; }
  .warn-note { font-size: 10.5px; color: var(--warn); }

  .q { padding: 10px 12px 2px; }
  .qhead {
    font-size: 10px; letter-spacing: .08em; color: var(--text-3);
    text-transform: uppercase; margin-bottom: 2px;
  }
  .qtext { font-size: 13px; color: var(--text); line-height: 1.45; margin-bottom: 8px; }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt {
    padding: 7px 12px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border-2);
    background: var(--bg-input);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
    transition: background .15s var(--ease, ease), border-color .15s var(--ease, ease), color .15s var(--ease, ease);
  }
  .opt:hover { border-color: var(--accent-line); color: var(--text); }
  .opt.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .custom {
    margin-top: 8px;
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-2);
    background: var(--bg-input);
    color: var(--text);
    font-size: 12px;
  }
  .custom:focus { outline: none; border-color: var(--accent-line); }
  .hint { margin-top: 6px; font-size: 10.5px; color: var(--text-3); }

  .acts {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px 12px;
  }
  .spacer { flex: 1; }
  .a {
    min-height: 38px;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-2);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .a.send {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .a.send:disabled { opacity: .45; cursor: default; }
  .a.rej { background: transparent; border-color: var(--border-2); color: var(--text-3); }
  .a.rej:hover { color: var(--err); border-color: var(--err); }

  .qcard.resolved {
    display: flex; align-items: baseline; gap: 6px;
    padding: 6px 12px;
    background: transparent; border: none;
    font-size: 12px; color: var(--text-3);
  }
  /* Soften the pending→resolved swap for LOCALLY triggered resolutions only —
     a republished resolved card (answered elsewhere) mounts without it
     (rule 1: replay/history mounts instantly). */
  .qcard.resolved.fresh { animation: ocrc-fade 150ms var(--ease-out, ease-out); }
  .qcard.resolved .mark { color: var(--accent); font-weight: 700; }
  .qcard.resolved.rej .mark { color: var(--err); }
  .qcard.resolved .rlabel { color: var(--text-2); font-weight: 600; }
  .qcard.resolved .rttl { color: var(--text-3); }
</style>
