<!-- src/lib/components/inspector/FilesPanel.svelte — M8: workspace file browser
     (GET /api/browse) + click-to-preview content (GET /api/file-content).
     Directory = the viewed session's workspace. -->
<script lang="ts">
  import { api, type FileEntryRow } from '$lib/api/client.js'
  import { sessionList } from '$lib/stores/sessions.js'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  $: directory = $sessionList.find((s) => s.id === sessionId)?.directory ?? ''

  let files: FileEntryRow[] = []
  let path = '.'
  let preview: { path: string; content: string } | null = null
  let binary = false
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
  async function open(f: FileEntryRow) {
    if (f.type === 'directory') {
      path = f.path
      await load()
      return
    }
    try {
      const r = await api.fileContent(directory, f.path)
      if (r.type !== 'text') { preview = { path: f.path, content: '（二进制文件，无法预览）' }; binary = true; return }
      binary = false
      preview = { path: f.path, content: r.content.length > 800 ? r.content.slice(0, 800) + '\n…' : r.content }
    } catch { preview = { path: f.path, content: '（读取失败）' }; binary = false }
  }
  function closePreview() { preview = null; binary = false }
</script>

<div class="files">
  <div class="label">Files</div>
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

  {#if preview}
    <div class="preview-scrim" on:click={closePreview} role="button" tabindex="0" on:keydown={(e) => e.key === 'Escape' && closePreview()}>
      <div class="preview" role="dialog" aria-label="File preview">
        <div class="p-hd"><span class="mono">{preview.path}</span>
          <button class="p-close" on:click={closePreview} aria-label="关闭预览">✕</button>
        </div>
        <pre class="p-body mono" class:binary>{preview.content}</pre>
      </div>
    </div>
  {/if}
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

  .preview-scrim {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    background: var(--scrim);
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .preview {
    width: min(92vw, 680px);
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-palette);
    animation: ocrc-pop .16s var(--ease-out, ease-out) backwards;
  }
  .p-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border-2);
    color: var(--text-2);
    font-size: 11px;
  }
  .p-close {
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
  }
  .p-body {
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .p-body.binary { color: var(--text-3); }
</style>
