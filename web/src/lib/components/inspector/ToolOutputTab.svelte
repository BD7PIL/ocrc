<!-- ToolOutputTab.svelte — a dynamic pane tab: one tool call's full command
     and output, fetched from the raw message endpoint (output never rides
     the event stream — it appears on completion). While the tool is still
     running, poll every 2s so the output lands the moment the state flips. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api/client.js'

  export let sessionId: string
  export let messageId: string
  export let partId: string
  export let tick = 0

  let tool = ''
  let status = ''
  let command = ''
  let output = ''
  let error = ''
  let missing = false
  let loading = true

  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  function extractToolPart(parts: Array<Record<string, any>>): Record<string, any> | undefined {
    return parts.find((p) => p?.id === partId && p?.type === 'tool')
      ?? parts.find((p) => p?.type === 'tool' && p?.state?.callID != null && p?.id === partId)
  }

  async function load(): Promise<void> {
    try {
      const res = await api.messageRaw(sessionId, messageId)
      const part = extractToolPart(res?.parts ?? [])
      if (!part) { missing = true; return }
      missing = false
      tool = String(part.tool ?? '')
      const st = part.state ?? {}
      status = String(st.status ?? 'pending')
      const input = st.input ?? {}
      command = String(input.command ?? input.cmd ?? input.filePath ?? input.description ?? '')
      output = typeof st.output === 'string' ? st.output : ''
      error = typeof st.error === 'string' ? st.error : ''
    } catch {
      missing = true
    } finally {
      loading = false
      // Running tools have no output field yet (1.18.32): poll until the
      // state flips to completed/error so the output lands as soon as it exists.
      if (!destroyed && (status === 'running' || status === 'pending')) {
        clearTimeout(pollTimer)
        pollTimer = setTimeout(() => { if (!destroyed) void load() }, 2000)
      }
    }
  }

  $: if (sessionId && messageId) { void sessionId, messageId, load() }
  // Pane activity tick (1s after feed events) also refetches — cheap and
  // covers the completion edge when the SSE poll window drifts.
  $: if (!loading && tick) { void tick, load() }
  onDestroy(() => { destroyed = true; clearTimeout(pollTimer) })

  $: statusLabel = status === 'completed' || status === 'done' ? '完成'
    : status === 'error' ? '出错'
    : status === 'running' ? '运行中'
    : status || '…'
</script>

<div class="out">
  <div class="hd">
    <span class="tool mono">{tool || 'tool'}</span>
    <span class="st mono {status}">{statusLabel}</span>
  </div>
  {#if command}
    <div class="cmd mono">{command}</div>
  {/if}
  {#if loading}
    <div class="hint mono">…</div>
  {:else if missing}
    <div class="hint mono">（找不到该工具调用的原始数据）</div>
  {:else if error}
    <pre class="body mono err">{error}</pre>
  {:else if output}
    <pre class="body mono">{output}</pre>
  {:else}
    <div class="hint mono">{status === 'running' || status === 'pending' ? '运行中——输出将在完成时出现' : '（无输出）'}</div>
  {/if}
</div>

<style>
  .out { font-size: 11.5px; }
  .hd { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .tool { font-size: 12px; font-weight: 600; color: var(--text-2); }
  .st { font-size: 10px; color: var(--text-3); }
  .st.running, .st.pending { color: var(--warn); }
  .st.error { color: var(--err); }
  .st.completed, .st.done { color: var(--ok); }
  .cmd {
    padding: 6px 8px;
    background: var(--bg-input);
    border-radius: var(--radius-xs);
    color: var(--toolcmd);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 6px;
  }
  .body {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg-code);
    border-radius: var(--radius-xs);
    color: var(--toolout);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 60vh;
    overflow-y: auto;
  }
  .body.err { color: var(--err); }
  .hint { padding: 8px 0; color: var(--text-3); font-size: 11px; }
</style>
