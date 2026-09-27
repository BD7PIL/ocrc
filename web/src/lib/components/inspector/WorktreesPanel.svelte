<!-- src/lib/components/inspector/WorktreesPanel.svelte — M8: experimental
     sandbox worktrees (beta). List / create / two-step delete. -->
<script lang="ts">
  import { api, type WorktreeRow } from '$lib/api/client.js'
  import { sessionList } from '$lib/stores/sessions.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  $: directory = $sessionList.find((s) => s.id === sessionId)?.directory ?? ''

  let rows: WorktreeRow[] = []
  let creating = false
  let name = ''
  let error = ''
  let armed: string | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    if (!directory) return
    try { rows = (await api.worktrees(directory)).worktrees ?? [] } catch { /* keep */ }
  }
  $: load(), tick, directory

  async function create() {
    if (!name.trim()) return
    error = ''
    try {
      const res = await api.createWorktree(directory, name.trim())
      if ((res as any).error) { error = (res as any).error; return }
      name = ''
      creating = false
      await load()
    } catch (e) { error = (e as Error).message }
  }

  async function remove(n: string) {
    if (armed !== n) {
      armed = n
      clearTimeout(armTimer)
      armTimer = setTimeout(() => (armed = undefined), 3000)
      return
    }
    clearTimeout(armTimer)
    armed = undefined
    try { await api.removeWorktree(directory, n); await load() } catch { /* keep */ }
  }
</script>

<div class="wt">
  <div class="hd">
    <div class="label">Worktrees · beta</div>
    <button class="add" on:click={() => (creating = !creating)} aria-label={creating ? '取消新建' : '新建 worktree'}>{creating ? '×' : '+'}</button>
  </div>

  <div class="list">
    {#each rows as w (w.name)}
      <div class="row">
        <span class="ico" aria-hidden="true">🌿</span>
        <span class="name">{w.name}</span>
        <button class="del" class:arm={armed === w.name} on:click={() => remove(w.name)} aria-label="删除 {w.name}">{armed === w.name ? '确认?' : '✕'}</button>
      </div>
    {/each}
    {#if rows.length === 0 && !creating}<div class="label">none</div>{/if}
  </div>

  {#if creating}
    <div class="form">
      <input class="name-in mono" placeholder="worktree 名称" bind:value={name} />
      {#if error}<div class="err">{error}</div>{/if}
      <button class="go" on:click={create} disabled={!name.trim()}>创建</button>
    </div>
  {/if}
</div>

<style>
  .wt { font-size: 11.5px; }
  .hd { display: flex; align-items: center; justify-content: space-between; }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .add {
    width: 20px; height: 20px;
    display: grid; place-items: center;
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
  .list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .ico { flex-shrink: 0; }
  .name { flex: 1; min-width: 0; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .del {
    flex-shrink: 0;
    padding: 0 5px;
    min-width: 18px; height: 18px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
    font-size: 11px;
    cursor: pointer;
  }
  .del:hover, .del.arm { color: var(--err); }
  .del.arm { border: 1px solid var(--err); }
  .form {
    margin-top: 8px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .name-in {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font: inherit;
    font-size: 11px;
    box-sizing: border-box;
  }
  .name-in:focus { outline: 1px solid var(--accent); }
  .err { color: var(--err); font-size: 10.5px; }
  .go {
    padding: 4px 10px;
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
