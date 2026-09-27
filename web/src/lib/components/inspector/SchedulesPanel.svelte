<!-- src/lib/components/inspector/SchedulesPanel.svelte — P2b-M7c: the Inspector
     block over the cross-channel scheduler (same /api/schedules the TG wizard
     uses). List / create / enable-toggle / delete, kept MCP-panel compact. -->
<script lang="ts">
  import { api, type ScheduleRow, type ScheduleSpec } from '$lib/api/client.js'

  export let tick = 0

  let rows: ScheduleRow[] = []
  let creating = false
  let prompt = ''
  let kind: 'every' | 'daily' = 'every'
  let minutes = 30
  let time = '09:00'
  let error = ''
  // Two-step delete: the ✕ turns into a "sure?" arm for a short window.
  let armed: string | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    try {
      rows = (await api.schedules()).schedules ?? []
    } catch { /* keep last list */ }
  }
  $: load(), tick

  function specLabel(s: ScheduleSpec): string {
    if (s.kind === 'every') return s.minutes >= 60 && s.minutes % 60 === 0 ? `every ${s.minutes / 60}h` : `every ${s.minutes}m`
    return `daily ${s.time}`
  }
  function rowLabel(r: ScheduleRow): string {
    return r.name || r.prompt
  }

  async function create() {
    if (!prompt.trim()) return
    error = ''
    const spec: ScheduleSpec = kind === 'every' ? { kind: 'every', minutes: Math.max(1, Math.round(minutes)) } : { kind: 'daily', time }
    try {
      const res = await api.addSchedule({ prompt: prompt.trim(), spec })
      if (res.error) { error = res.error; return }
      prompt = ''
      creating = false
      await load()
    } catch (e) {
      error = (e as Error).message
    }
  }

  async function toggle(r: ScheduleRow) {
    rows = rows.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) // optimistic
    try {
      await api.setScheduleEnabled(r.id, !r.enabled)
      await load()
    } catch {
      await load() // snap back to server truth
    }
  }

  async function remove(id: string) {
    if (armed !== id) {
      armed = id
      clearTimeout(armTimer)
      armTimer = setTimeout(() => (armed = undefined), 3000)
      return
    }
    clearTimeout(armTimer)
    armed = undefined
    try {
      await api.deleteSchedule(id)
      await load()
    } catch { /* keep row on failure */ }
  }
</script>

<div class="schedules">
  <div class="hd">
    <div class="label">定时任务</div>
    <button class="add" on:click={() => (creating = !creating)} aria-label={creating ? '取消新建计划' : '新建计划'}>{creating ? '×' : '+'}</button>
  </div>

  <div class="list">
    {#each rows as r (r.id)}
      <div class="row" class:off={!r.enabled}>
        <button class="switch" class:on={r.enabled} on:click={() => toggle(r)} aria-pressed={r.enabled} aria-label={`${r.enabled ? '停用' : '启用'} ${rowLabel(r)}`}>
          <span class="dot" aria-hidden="true"></span>
        </button>
        <div class="txt">
          <div class="prompt">{rowLabel(r)}</div>
          <div class="spec mono">{specLabel(r.spec)}</div>
        </div>
        <button class="del" class:arm={armed === r.id} on:click={() => remove(r.id)} aria-label="删除 {rowLabel(r)}">{armed === r.id ? '确认?' : '✕'}</button>
      </div>
    {/each}
    {#if rows.length === 0 && !creating}<div class="label">暂无</div>{/if}
  </div>

  {#if creating}
    <div class="form">
      <textarea class="prompt-in" rows="2" placeholder="让 agent 做什么？" bind:value={prompt}></textarea>
      <div class="kind">
        <label class:sel={kind === 'every'}>
          <input type="radio" bind:group={kind} value="every" />
          每
          <input class="num" type="number" min="1" max="10080" bind:value={minutes} disabled={kind !== 'every'} /> 分钟
        </label>
        <label class:sel={kind === 'daily'}>
          <input type="radio" bind:group={kind} value="daily" />
          每天
          <input class="time" type="time" bind:value={time} disabled={kind !== 'daily'} />
        </label>
      </div>
      {#if error}<div class="err">{error}</div>{/if}
      <button class="go" on:click={create} disabled={!prompt.trim()}>创建</button>
    </div>
  {/if}
</div>

<style>
  .schedules { font-size: 11.5px; }
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .add {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  .add:hover { color: var(--text); border-color: var(--accent); }

  .list {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 8px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .switch {
    flex-shrink: 0;
    width: 22px;
    height: 14px;
    margin-top: 2px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    background: var(--bg-input);
    display: grid;
    align-items: center;
    cursor: pointer;
  }
  .switch .dot {
    width: 8px;
    height: 8px;
    margin: 0 2px;
    border-radius: 50%;
    background: var(--text-3);
    transition: transform .16s ease, background .16s ease;
  }
  .switch.on { border-color: var(--accent); }
  .switch.on .dot {
    background: var(--accent);
    transform: translateX(8px);
  }
  .txt { flex: 1; min-width: 0; }
  .prompt {
    font-size: 11.5px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.off .prompt { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--border); }
  .spec { font-size: 10px; color: var(--text-3); margin-top: 1px; }
  .del {
    flex-shrink: 0;
    margin-top: 1px;
    padding: 0 5px;
    min-width: 18px;
    height: 18px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
  }
  .del:hover { color: var(--err); }
  .del.arm { color: var(--err); border: 1px solid var(--err); }

  .form {
    margin-top: 10px;
    padding: 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .prompt-in {
    width: 100%;
    resize: vertical;
    padding: 6px 8px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    box-sizing: border-box;
  }
  .prompt-in:focus { outline: 1px solid var(--accent); }
  .kind {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-2);
  }
  .kind label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .kind input[type='radio'] { accent-color: var(--accent); margin: 0; }
  .num, .time {
    width: 62px;
    padding: 2px 5px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text);
    font: inherit;
    font-size: 11px;
  }
  .num:disabled, .time:disabled { opacity: .4; }
  .err { color: var(--err); font-size: 10.5px; }
  .go {
    align-self: flex-end;
    padding: 4px 12px;
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    color: var(--accent-ink);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .go:disabled { opacity: .45; cursor: default; }
</style>
