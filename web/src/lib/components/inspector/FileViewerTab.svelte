<!-- FileViewerTab.svelte — a dynamic pane tab: one file's full-height viewer
     (opened from the 文件 list). Markdown renders; other text goes through
     the same pipeline as one fenced block (language highlight + Copy). -->
<script lang="ts">
  import { api } from '$lib/api/client.js'
  import MarkdownView from '../MarkdownView.svelte'

  export let directory: string
  export let path: string

  /** opencode serves full content; don't hang the pane on a 10MB log.
     (MarkdownView itself degrades >20k chars to a raw pre.) */
  const MAX_CHARS = 200_000

  let content = ''
  let truncated = false
  let binary = false
  let failed = false
  let loading = false

  async function load() {
    loading = true
    failed = false
    try {
      const r = await api.fileContent(directory, path)
      if (r.type !== 'text') { binary = true; content = ''; return }
      binary = false
      truncated = r.content.length > MAX_CHARS
      content = truncated ? r.content.slice(0, MAX_CHARS) : r.content
    } catch { failed = true } finally { loading = false }
  }
  $: if (directory && path) { void directory, path, load() }

  $: isMd = /\.(md|markdown)$/i.test(path)
  $: ext = path.split('.').pop() ?? ''
  $: fenced = binary || failed ? '' : isMd ? content : '```' + ext + '\n' + content + '\n```'
</script>

<div class="fv">
  {#if truncated}<div class="trunc label">文件超过 {MAX_CHARS.toLocaleString()} 字符，已截断显示</div>{/if}
  <div class="body">
    {#if loading}
      <div class="hint label">…</div>
    {:else if failed}
      <div class="hint label">读取失败</div>
    {:else if binary}
      <div class="hint label">（二进制文件，无法预览）</div>
    {:else}
      <MarkdownView src={isMd ? content : fenced} />
    {/if}
  </div>
</div>

<style>
  .fv { font-size: 11.5px; }
  .label {
    text-transform: uppercase;
    letter-spacing: .16em;
    color: var(--text-3);
    font-size: 10px;
  }
  .trunc {
    padding: 4px 0;
    color: var(--warn);
    text-transform: none;
    letter-spacing: 0;
    font-size: 10.5px;
  }
  .body { overflow: visible; }
  .hint { padding: 10px 0; }
</style>
