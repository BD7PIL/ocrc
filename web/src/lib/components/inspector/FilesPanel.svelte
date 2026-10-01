<!-- FilesPanel.svelte — 文件 pinned tab: the launcher list (workspace browser,
     GET /api/browse). Clicking a file opens a `file:<path>` dynamic pane tab
     with the full viewer; directories navigate in place. -->
<script lang="ts">
  import { api, type FileEntryRow } from '$lib/api/client.js'
  import { sessionList } from '$lib/stores/sessions.js'
  import { openPaneTab } from '$lib/stores/sidePane.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  $: directory = $sessionList.find((s) => s.id === sessionId)?.directory ?? ''

  let files: FileEntryRow[] = []
  let path = '.'
  let loading = false

  async function load() {
    if (!directory) return
    loading = true
    try { files = (await api.browse(directory, path)).files ?? [] } catch { files = [] } finally { loading = false }
  }
  $: if (directory) { void directory, path, tick, load() }

  function up() {
    const next = path.replace(/(^|\/)[^/]+\/?$/, '') || '.'
    path = next
    void load()
  }
  function open(f: FileEntryRow) {
    if (f.type === 'directory') {
      path = f.path
      void load()
      return
    }
    openPaneTab({ id: `file:${f.path}`, kind: 'file', title: f.name, path: f.path, directory })
  }
</script>

<div class="files">
  <div class="crumb mono">
    {#if path !== '.'}
      <button class="up" on:click={up} aria-label="上级目录">↰ {path}</button>
    {:else}
      <span class="mono">{directory.split('/').pop() || '/'}</span>
    {/if}
  </div>
  <div class="list">
    {#each files as f (f.path)}
      <button class="row" on:click={() => open(f)}>
        <span class="ico">{f.type === 'directory' ? '📁' : '📄'}</span>
        <span class="name">{f.name}</span>
      </button>
    {/each}
    {#if !loading && files.length === 0}<div class="label">empty</div>{/if}
    {#if loading}<div class="label">…</div>{/if}
  </div>
</div>

<style>
  .files { font-size: 11.5px; }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .crumb { margin-top: 6px; color: var(--text-3); font-size: 10.5px; }
  .up {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .list { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 3px 4px;
    margin: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover { background: var(--bg-input); color: var(--text); }
  .ico { flex-shrink: 0; width: 14px; text-align: center; }
  .name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
