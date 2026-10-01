<!-- GitTab.svelte — a dynamic pane tab: working-tree overview (branch, per-file
     status with adds/dels, expandable official patches from /vcs/diff).
     Honest bounds: no commit history (1.18.32 has no git-log endpoint). -->
<script lang="ts">
  import { api } from '$lib/api/client.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  interface StatusRow { file: string; additions?: number; deletions?: number; status?: string }

  let branch = ''
  let status: StatusRow[] = []
  let diffs: Map<string, string> = new Map()
  let expanded = new Set<string>()
  let loading = true
  let diffLoading: string | null = null

  async function load() {
    try {
      const v = await api.vcs(sessionId)
      branch = v?.branch ?? ''
      status = v?.status ?? []
    } catch { branch = ''; status = [] } finally { loading = false }
  }
  $: void tick, load()

  // Patches are per-file and lazy: a whole-tree diff is tens of MB on the
  // production worktree — one file at a time, capped server-side.
  async function loadPatch(file: string) {
    if (diffs.has(file) || diffLoading !== null) return
    diffLoading = file
    try {
      const r = await api.vcsDiff(sessionId, file)
      diffs = new Map([...diffs, [file, r?.patch ?? '']])
    } catch {
      diffs = new Map([...diffs, [file, '（patch 读取失败）']])
    } finally { diffLoading = null }
  }

  function toggle(file: string) {
    if (expanded.has(file)) { expanded = new Set([...expanded].filter((f) => f !== file)); return }
    expanded = new Set([...expanded, file])
    void loadPatch(file)
  }

  const statusLabel = (s?: string) =>
    s === 'added' ? '新增' : s === 'deleted' ? '删除' : s === 'modified' ? '修改' : s ?? ''
</script>

<div class="git">
  <div class="hd">
    <span class="branch mono">{branch || '…'}</span>
    {#if status.length}<span class="count mono">{status.length} 个文件</span>{/if}
  </div>

  {#each status as f (f.file)}
    <div class="file">
      <button class="row" on:click={() => toggle(f.file)} aria-expanded={expanded.has(f.file)}>
        <span class="badge {f.status}">{statusLabel(f.status)}</span>
        <span class="path mono">{f.file}</span>
        <span class="delta mono">
          {#if f.additions}<span class="add">+{f.additions}</span>{/if}
          {#if f.deletions}<span class="del">−{f.deletions}</span>{/if}
        </span>
      </button>
      {#if expanded.has(f.file)}
        {#if diffLoading === f.file}
          <div class="hint mono">…</div>
        {:else if diffs.get(f.file)}
          <pre class="patch mono">{diffs.get(f.file)}</pre>
        {:else}
          <div class="hint mono">（无改动内容）</div>
        {/if}
      {/if}
    </div>
  {:else}
    {#if !loading}<div class="hint">工作区干净</div>{/if}
  {/each}
  {#if loading}<div class="hint">…</div>{/if}
</div>

<style>
  .git { font-size: 11.5px; }
  .hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .branch { font-size: 12px; font-weight: 600; color: var(--text-2); }
  .count { font-size: 10px; color: var(--text-3); }
  .file { margin-bottom: 2px; }
  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 4px 4px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover { background: var(--bg-input); color: var(--text); }
  .badge {
    flex-shrink: 0;
    font-size: 9.5px;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border-2);
    color: var(--text-3);
  }
  .badge.added { color: var(--ok); border-color: var(--ok); }
  .badge.deleted { color: var(--err); border-color: var(--err); }
  .badge.modified { color: var(--warn); border-color: var(--warn); }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .delta { flex-shrink: 0; display: flex; gap: 5px; font-size: 10px; }
  .delta .add { color: var(--ok); }
  .delta .del { color: var(--err); }
  .patch {
    margin: 2px 0 6px;
    padding: 8px 10px;
    background: var(--bg-code);
    border-radius: var(--radius-xs);
    color: var(--toolout);
    font-size: 10.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 320px;
    overflow-y: auto;
  }
  .hint { padding: 6px 4px; color: var(--text-3); font-size: 11px; }
</style>
