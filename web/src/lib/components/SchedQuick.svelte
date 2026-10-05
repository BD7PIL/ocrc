<!-- SchedQuick.svelte — create a scheduled prompt without leaving the chat.
     Anchored above the composer's ⏰ hint button; ZCode lets you spawn a
     scheduled task from the conversation, this is that entry point. -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { api } from '$lib/api/client.js'
  import { sidePane } from '$lib/stores/sidePane.js'
  import { inspectorOpen } from '$lib/stores/ui.js'

  const dispatch = createEventDispatcher<{ close: void }>()

  let prompt = ''
  let kind: 'every' | 'daily' = 'daily'
  let minutes = 30
  let time = '09:00'
  let busy = false
  let error = ''
  let done = ''

  async function create() {
    if (!prompt.trim()) { error = '先写要执行的内容'; return }
    const spec = kind === 'every'
      ? { kind: 'every' as const, minutes: Math.max(1, Math.round(minutes || 30)) }
      : { kind: 'daily' as const, time: /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '09:00' }
    busy = true
    error = ''
    try {
      const res = await api.addSchedule({ prompt: prompt.trim(), spec, enabled: true })
      if (res.error) { error = res.error; return }
      done = '已创建'
      prompt = ''
      dispatch('close')
      inspectorOpen.set(true)
      sidePane.openHome('schedules')
    } catch (e) {
      error = `创建失败：${(e as Error).message}`
    } finally {
      busy = false
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') dispatch('close')
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void create()
  }
</script>

<div class="pop" role="dialog" tabindex="-1" aria-label="创建定时任务" on:keydown={onKey}>
  <div class="hd">新建定时任务</div>
  <textarea
    class="p"
    bind:value={prompt}
    placeholder="要定期执行的内容，如：巡检失败用例并汇总到群里"
    rows="2"></textarea>
  <div class="freq">
    <label class:sel={kind === 'daily'}>
      <input type="radio" bind:group={kind} value="daily" /> 每天
    </label>
    {#if kind === 'daily'}
      <input class="time mono" type="time" bind:value={time} />
    {/if}
    <label class:sel={kind === 'every'}>
      <input type="radio" bind:group={kind} value="every" /> 每隔
    </label>
    {#if kind === 'every'}
      <input class="min mono" type="number" min="1" max="10080" bind:value={minutes} /> 分钟
    {/if}
  </div>
  {#if error}<div class="err">{error}</div>{/if}
  <div class="acts">
    <span class="hint">⌘/Ctrl+↵ 创建 · Esc 关闭</span>
    <span class="sp"></span>
    <button class="btn" on:click={() => dispatch('close')}>取消</button>
    <button class="btn primary" disabled={busy || !prompt.trim()} on:click={create}>{busy ? '创建中…' : '创建'}</button>
  </div>
</div>

<style>
  .pop {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: calc(100% + 8px);
    z-index: 30;
    padding: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    border-radius: var(--radius);
    box-shadow: 0 6px 24px rgb(0 0 0 / .18);
  }
  .hd { font-size: 12.5px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
  .p {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 44px;
    padding: 7px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
  }
  .freq {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-2);
    flex-wrap: wrap;
  }
  .freq label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm); }
  .freq label.sel { color: var(--text); background: var(--bg-input); }
  .time, .min {
    width: 96px;
    padding: 3px 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 12px;
  }
  .min { width: 64px; }
  .err { margin-top: 6px; font-size: 11.5px; color: var(--err); }
  .acts { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .sp { flex: 1; }
  .hint { font-size: 10.5px; color: var(--text-3); }
  .btn {
    padding: 4px 12px;
    border: 1px solid var(--border-2);
    background: transparent;
    color: var(--text-2);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink, #fff); }
  .btn:disabled { opacity: .5; cursor: default; }
</style>
