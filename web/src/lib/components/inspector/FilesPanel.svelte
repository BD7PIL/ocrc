<!-- src/lib/components/inspector/FilesPanel.svelte — workspace file browser
     (GET /api/browse) with a persistent dual-pane viewer on desktop: left
     directory list, right full-height preview (markdown rendered, code
     highlighted). Narrow panes keep the old modal preview. -->
<script lang="ts">
  import { api, type FileEntryRow } from '$lib/api/client.js'
  import { sessionList } from '$lib/stores/sessions.js'
  import MarkdownView from '../MarkdownView.svelte'

  export let sessionId: string | undefined = undefined
  export let tick = 0

  /** Side-by-side needs ~460px of pane; narrower desktop panes swap the whole
     pane to the viewer instead (modal stays mobile-sheet-only). */
  const WIDE_MIN = 460
  /** Viewer hard cap — opencode serves full content; don't hang the pane on a
     10MB log. (MarkdownView itself degrades >20k chars to a raw pre.) */
  const MAX_CHARS = 200_000

  $: directory = $sessionList.find((s) => s.id === sessionId)?.directory ?? ''

  let files: FileEntryRow[] = []
  let path = '.'
  let preview: { path: string; content: string; truncated: boolean; binary: boolean } | null = null
  let loading = false
  let panelW = 0
  let mobile = false
  try { mobile = window.matchMedia('(max-width: 820px)').matches } catch { /* ssr */ }
  $: wide = panelW >= WIDE_MIN && !mobile

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
      if (r.type !== 'text') {
        preview = { path: f.path, content: '（二进制文件，无法预览）', truncated: false, binary: true }
        return
      }
      const truncated = r.content.length > MAX_CHARS
      preview = { path: f.path, content: truncated ? r.content.slice(0, MAX_CHARS) : r.content, truncated, binary: false }
    } catch { preview = { path: f.path, content: '（读取失败）', truncated: false, binary: false } }
  }
  function closePreview() { preview = null }

  $: isMd = preview ? /\.(md|markdown)$/i.test(preview.path) : false
  // Non-markdown text renders through the same markdown pipeline as one fenced
  // code block — reuse gives language highlight + Copy for free. Language from
  // the extension, defaulting to plain text.
  $: ext = preview ? (preview.path.split('.').pop() ?? '') : ''
  $: fenced = preview && !isMd && !preview.binary
    ? '```' + ext + '\n' + preview.content + '\n```'
    : ''
</script>

<div class="files" bind:clientWidth={panelW}>
  {#if !(preview && !wide && !mobile)}
    <div class="list-pane">
      <div class="crumb mono">
        {#if path !== '.'}
          <button class="up" on:click={up} aria-label="上级目录">↰ {path}</button>
        {:else}
          <span class="mono">{directory.split('/').pop() || '/'}</span>
        {/if}
      </div>
      <div class="list">
        {#each files as f (f.path)}
          <button class="row" class:active={preview?.path === f.path} on:click={() => open(f)}>
            <span class="ico">{f.type === 'directory' ? '📁' : '📄'}</span>
            <span class="name">{f.name}</span>
          </button>
        {/each}
        {#if !loading && files.length === 0}<div class="label">empty</div>{/if}
        {#if loading}<div class="label">…</div>{/if}
      </div>
    </div>
  {/if}

  {#if preview && wide}
    <div class="view-pane">
      <div class="v-hd">
        <span class="v-path mono">{preview.path}</span>
        <button class="v-close" on:click={closePreview} aria-label="关闭预览">✕</button>
      </div>
      {#if preview.truncated}<div class="v-trunc label">文件超过 {MAX_CHARS.toLocaleString()} 字符，已截断显示</div>{/if}
      <div class="v-body">
        {#if preview.binary}
          <div class="v-empty label">{preview.content}</div>
        {:else if isMd}
          <MarkdownView src={preview.content} />
        {:else}
          <MarkdownView src={fenced} />
        {/if}
      </div>
    </div>
  {:else if preview && !mobile}
    <!-- Narrow desktop pane: swap the whole pane to the viewer (back returns
         to the list) — a modal at 280px would cover the whole inspector. -->
    <div class="view-pane full">
      <div class="v-hd">
        <button class="v-back" on:click={closePreview} aria-label="返回文件列表">← </button>
        <span class="v-path mono">{preview.path}</span>
      </div>
      {#if preview.truncated}<div class="v-trunc label">文件超过 {MAX_CHARS.toLocaleString()} 字符，已截断显示</div>{/if}
      <div class="v-body">
        {#if preview.binary}
          <div class="v-empty label">{preview.content}</div>
        {:else if isMd}
          <MarkdownView src={preview.content} />
        {:else}
          <MarkdownView src={fenced} />
        {/if}
      </div>
    </div>
  {:else if preview}
    <div class="preview-scrim" on:click={closePreview} role="button" tabindex="0" on:keydown={(e) => e.key === 'Escape' && closePreview()}>
      <div class="preview" role="dialog" aria-label="File preview" tabindex="-1">
        <div class="p-hd"><span class="mono">{preview.path}</span>
          <button class="p-close" on:click={closePreview} aria-label="关闭预览">✕</button>
        </div>
        {#if preview.binary}
          <pre class="p-body mono binary">{preview.content}</pre>
        {:else}
          <div class="p-body md-wrap"><MarkdownView src={isMd ? preview.content : fenced} /></div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .files { font-size: 11.5px; }
  @media (min-width: 821px) {
    .files { display: flex; gap: 10px; align-items: stretch; }
    .list-pane { width: 46%; min-width: 0; flex-shrink: 0; }
    .view-pane {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-2);
      border-radius: var(--radius-sm);
      background: var(--bg-elev);
      max-height: 480px;
      overflow: hidden;
    }
  }
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
  .row.active { background: var(--bg-input); color: var(--text); }
  .ico { flex-shrink: 0; width: 14px; text-align: center; }
  .name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Desktop viewer pane */
  .view-pane.full { flex: 1; min-width: 0; }
  .v-back {
    background: transparent;
    border: none;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 0 2px 0 0;
    flex-shrink: 0;
  }
  .v-hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border-2);
  }
  .v-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); font-size: 10.5px; }
  .v-close { background: transparent; border: none; color: var(--text-3); cursor: pointer; padding: 0 2px; }
  .v-close:hover { color: var(--text); }
  .v-trunc { padding: 4px 10px; color: var(--warn); text-transform: none; letter-spacing: 0; font-size: 10.5px; }
  .v-body { padding: 8px 10px; overflow: auto; min-height: 0; font-size: 11.5px; }
  .v-empty { padding: 12px 0; }

  /* Narrow modal preview (kept for <420px panes / mobile sheet) */
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
