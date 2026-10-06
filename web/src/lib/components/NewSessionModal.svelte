<script lang="ts">
  import { goto } from '$app/navigation'
  import Icon from './Icon.svelte'
  import { api } from '$lib/api/client.js'
  import { backends as backendsStore, backends, setActiveBackend, agentAccent, ACCENTS, ACCENT_HEX, ACCENT_BG, ACCENT_LINE, type Accent, type CapabilitiesSnapshot } from '$lib/stores/capabilities.js'
  import RemoteWizard from '$lib/components/RemoteWizard.svelte'
  import { workspaces } from '$lib/stores/workspaces.js'
  import { sessionList } from '$lib/stores/sessions.js'
  import { newSessionOpen } from '$lib/stores/ui.js'


  $: agents = $backends?.backends ?? []
  $: defaultAgentId = $backends?.activeId ?? agents[0]?.id ?? 'opencode'
  let selectedAgentId = ''
  $: selectedAgentId = selectedAgentId || defaultAgentId

  let directory = ''
  let branch = ''
  let creating = false
  let error: string | null = null
  let showRecents = false

  // ── DirectoryBrowser (ZCode register): step-by-step readdir with an `..`
  // up row and a hidden-dirs toggle — replaces blind path typing with a
  // graphical walk. api.browse lists one level at a time; "选择此目录" commits.
  let browserOpen = false
  let browserDir = '/'
  let browserEntries: Array<{ name: string; path: string }> = []
  let browserLoading = false
  let browserError: string | null = null
  let showHidden = false
  let browserSeq = 0
  async function openBrowser() {
    browserOpen = true
    showRecents = false
    const start = directory.trim()
    if (start.startsWith('/')) {
      // Resume INSIDE the typed dir (trailing slash semantics: list its children).
      browserDir = start.endsWith('/') ? start.slice(0, -1) || '/' : start
    } else {
      browserDir = agentRecents[0]?.directory ?? '/'
    }
    await loadBrowserDir()
  }
  async function loadBrowserDir() {
    const seq = ++browserSeq
    browserLoading = true
    browserError = null
    try {
      const res = await api.browse(browserDir, browserDir)
      if (seq !== browserSeq) return
      browserEntries = (res.files ?? [])
        .filter((f) => f.type === 'directory')
        .map((f) => {
          const name = f.path.split('/').filter(Boolean).pop() ?? ''
          return { name, path: `${browserDir === '/' ? '' : browserDir}/${name}` }
        })
        .filter((e) => e.name && (showHidden || !e.name.startsWith('.')))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (e) {
      if (seq === browserSeq) { browserEntries = []; browserError = (e as Error).message }
    } finally {
      if (seq === browserSeq) browserLoading = false
    }
  }
  function upBrowserDir() {
    if (browserDir === '/') return
    browserDir = browserDir.slice(0, browserDir.lastIndexOf('/')) || '/'
    void loadBrowserDir()
  }
  function intoBrowserDir(path: string) {
    browserDir = path
    void loadBrowserDir()
  }
  function commitBrowserDir() {
    directory = browserDir
    browserOpen = false
  }

  // ── Remote connect（修复#4：唯一添加入口 = 本页 → 共享向导下一级）。
  // 完成后刷新 backends 并自动选中新远程 chip。
  let remoteWizardOpen = false
  let addedRemoteId: string | undefined
  async function onWizardClose(e: CustomEvent<{ remoteId?: string; endState?: string }>) {
    remoteWizardOpen = false
    addedRemoteId = e.detail?.remoteId
    try {
      const snap = await api.backends()
      backendsStore.set(snap as any)
      const created = (snap.backends ?? []).find((b) => b.id === `remote:${addedRemoteId}`)
      if (created) selectedAgentId = created.id
      addedRemoteId = undefined
    } catch { /* chips refresh on next open */ }
  }
  $: if (addedRemoteId) {
    const created = agents.find((b) => b.id === `remote:${addedRemoteId}`)
    if (created) { selectedAgentId = created.id; addedRemoteId = undefined }
  }
  // Directory autocomplete: list sibling dirs of the typed path via /api/browse
  // (graphical suggestions, ZCode/opencode register — no blind typing).
  let dirSug: Array<{ name: string; path: string }> = []
  let dirSugSeq = 0
  async function fetchDirSug() {
    const seq = ++dirSugSeq
    const typed = directory.trim()
    if (!typed.startsWith('/')) { dirSug = []; return }
    // `/a/b/` (trailing slash) = list INSIDE b; `/a/b` = complete siblings of b.
    const parent = typed.endsWith('/') ? typed.slice(0, -1) : typed.slice(0, typed.lastIndexOf('/')) || '/'
    try {
      const res = await api.browse(parent, parent)
      if (seq !== dirSugSeq) return
      dirSug = (res.files ?? [])
        .filter((f) => f.type === 'directory')
        .map((f) => {
          const name = f.path.split('/').filter(Boolean).pop() ?? ''
          return { name, path: `${parent === '/' ? '' : parent}/${name}` }
        })
        .filter((e) => e.name)
        .slice(0, 6)
    } catch { if (seq === dirSugSeq) dirSug = [] }
  }
  function pickSug(path: string) {
    directory = path.endsWith('/') ? path : path + '/'
    dirSug = []
  }

  function glyphFrom(text: string): string {
    const words = text.split(/[\s\-_:./]+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    return text.slice(0, 2).toUpperCase()
  }
  function glyph(agent?: CapabilitiesSnapshot): string {
    return glyphFrom(agent?.name || agent?.id || 'OC')
  }

  function statusClass(status?: string): string {
    if (status === 'online' || status === 'connected') return 'online'
    if (status === 'connecting' || status === 'reconnecting') return 'connecting'
    if (status === 'offline') return 'offline'
    return 'online'
  }

  function close() {
    newSessionOpen.set(false)
    error = null
  }

  function pickRecent(dir: string) {
    directory = dir
    showRecents = false
  }

  // Per-agent recents: the distinct working directories of the SELECTED agent's own
  // sessions, most-recent first. (Browsing the phone's local folders is meaningless —
  // sessions run on the remote host, not the device.)
  $: selectedAgentName = $backends?.backends.find((b) => b.id === selectedAgentId)?.name ?? selectedAgentId
  $: agentRecents = (() => {
    const seen = new Set<string>()
    const out: { directory: string; name: string }[] = []
    for (const s of [...$sessionList].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
      const mine = s.backendId === selectedAgentId || (!s.backendId && selectedAgentId === 'opencode')
      if (!mine || !s.directory || seen.has(s.directory)) continue
      seen.add(s.directory)
      out.push({ directory: s.directory, name: s.directory.replace(/\/+$/, '').split('/').pop() || s.directory })
    }
    return out
  })()

  async function submit() {
    const dir = directory.trim()
    if (!dir) {
      error = '需要填写工作目录'
      return
    }
    if (creating) return
    creating = true
    error = null
    try {
      // backendId rides the create call directly — no setActiveBackend race
      // window where a failed create leaves the active backend switched.
      const res = await api.createSession({ directory: dir, backendId: selectedAgentId })
      sessionList.set(await api.sessions())
      workspaces.set(await api.workspaces())
      close()
      goto(`/${res.id}/`)
    } catch (e) {
      error = (e as Error).message
    } finally {
      creating = false
    }
  }

  async function reloadBackends() {
    try { backends.set(await api.backends() as any) } catch { /* next open retries */ }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { close(); return }
    if (e.key === 'Tab') trapTab(e)
  }

  // r7: the recents panel stayed open until a pick — close on any click
  // outside the recents list and the directory input row.
  function onWindowPointerdown(e: MouseEvent) {
    if (!showRecents) return
    const t = e.target as Node
    if (recentsEl?.contains(t) || dirRowEl?.contains(t)) return
    showRecents = false
  }
  let recentsEl: HTMLElement
  let dirRowEl: HTMLElement

  let modalEl: HTMLElement

  function focusableIn(node: HTMLElement): HTMLElement[] {
    return Array.from(
      node.querySelectorAll<HTMLElement>('button, input, [tabindex]'),
    ).filter((el) => !el.hasAttribute('disabled'))
  }

  // On mount: remember the trigger and move focus into the dialog. On destroy
  // (the modal closes) focus goes back to the trigger.
  function manageFocus(node: HTMLElement) {
    const trigger = document.activeElement as HTMLElement | null
    const first = node.querySelector<HTMLElement>('input:not([disabled])') ?? focusableIn(node)[0]
    first?.focus()
    return {
      destroy() {
        trigger?.focus?.()
      },
    }
  }

  // Lightweight focus trap: Tab wraps between the first and last focusable.
  function trapTab(e: KeyboardEvent) {
    if (!modalEl) return
    const items = focusableIn(modalEl)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }
</script>

<svelte:window on:keydown={onKey} on:pointerdown={onWindowPointerdown} />

{#if $newSessionOpen}
  <div class="overlay">
    <button class="backdrop" aria-label="关闭" on:click={close}></button>
    <div class="modal" role="dialog" aria-modal="true" aria-label="新建会话" bind:this={modalEl} use:manageFocus>
      <div class="header">
        <span class="title">New session</span>
        <button class="close" aria-label="关闭" on:click={close}><Icon name="close" size={14} /></button>
      </div>

      <div class="body">
        {#if agents.length === 0}
          <!-- r7: dead-end loading — a failed backend fetch never retried -->
          <div class="empty">
            正在加载 agent…
            <button type="button" class="retry" on:click={reloadBackends}>重新加载</button>
          </div>
        {:else}
          <div class="field">
            <span class="label">引擎 / 后端</span>
            <div class="agent-chips" role="radiogroup" aria-label="选择 agent">
              {#each agents as a (a.id)}
                {@const theme = agentAccent(a.id)}
                {@const selected = a.id === selectedAgentId}
                <button
                  class="agent-chip"
                  class:selected
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  on:click={() => { selectedAgentId = a.id }}
                >
                  <span
                    class="chip-tile"
                    style="background:{ACCENT_BG[theme]}; color:{ACCENT_HEX[theme]}; border-color:{ACCENT_LINE[theme]}"
                  >
                    {#if a.id.startsWith('remote:')}☁{:else}{glyph(a)}{/if}
                  </span>
                  <span class="chip-status {statusClass(a.status)}" style="--dot:{ACCENT_HEX[theme]}"><span class="sr-only">{statusClass(a.status)}</span></span>
                  <span class="chip-name">{a.id.startsWith('remote:') ? a.id.replace('remote:', '远程 · ') : (a.name ?? a.id)}</span>
                </button>
              {/each}
              <button
                class="agent-chip remote-add"
                type="button"
                aria-haspopup="dialog"
                on:click={() => { remoteWizardOpen = true }}
                title="连接远程主机（SSH / WSL / Docker）— 作为新建会话的下一级"
              >＋ 远程连接</button>
            </div>
          </div>
        {/if}

        <div class="field">
          <label class="label" for="new-session-dir">Working directory</label>
          <div class="dir-input" bind:this={dirRowEl}>
            <input
              id="new-session-dir"
              class="path mono"
              type="text"
              placeholder="/path/to/project"
              bind:value={directory}
              on:input={fetchDirSug}
              on:focus={() => { showRecents = true }}
            />
            <button class="browse" type="button" on:click={openBrowser} title="逐级浏览目录">浏览</button>
            <button class="browse" type="button" on:click={() => (showRecents = !showRecents)} title="该 agent 最近使用的目录">最近</button>
          </div>
          {#if browserOpen}
            <div class="dir-browser" role="dialog" aria-label="目录浏览器">
              <div class="db-head">
                <button class="db-up" type="button" on:click={upBrowserDir} disabled={browserDir === '/'} title="上一级">↑..</button>
                <span class="db-path mono">{browserDir}</span>
                <label class="db-hidden"><input type="checkbox" bind:checked={showHidden} on:change={loadBrowserDir} /> 隐藏</label>
              </div>
              <div class="db-list">
                {#if browserLoading}
                  <div class="db-note">读取中…</div>
                {:else if browserError}
                  <div class="db-note err">{browserError}</div>
                {:else if browserEntries.length === 0}
                  <div class="db-note">（没有子目录）</div>
                {:else}
                  {#each browserEntries as e (e.path)}
                    <button class="db-row" type="button" on:click={() => intoBrowserDir(e.path)} title={e.path}>
                      <span class="db-ico" aria-hidden="true">▸</span>
                      <span class="db-name">{e.name}</span>
                    </button>
                  {/each}
                {/if}
              </div>
              <div class="db-foot">
                <button class="btn secondary" type="button" on:click={() => (browserOpen = false)}>关闭</button>
                <button class="btn primary" type="button" on:click={commitBrowserDir}>选择此目录</button>
              </div>
            </div>
          {/if}
          {#if dirSug.length > 0}
            <div class="dir-sug" role="listbox">
              {#each dirSug as sug (sug.path)}
                <button class="dir-sug-item" type="button" role="option" aria-selected="false" on:click={() => pickSug(sug.path)} title={sug.path}>
                  <span class="recent-name">{sug.name}</span>
                  <span class="recent-dir mono">{sug.path}</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if agentRecents.length > 0}
            <div class="recents" class:open={showRecents} bind:this={recentsEl}>
              <span class="recents-label mono">recent · {selectedAgentName}</span>
              <div class="recents-list">
                {#each agentRecents as w (w.directory)}
                  <button class="recent" type="button" on:click={() => pickRecent(w.directory)} title={w.directory}>
                    <span class="recent-name">{w.name}</span>
                    <span class="recent-dir mono">{w.directory}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>


        {#if error}<div class="error">{error}</div>{/if}
      </div>

      <div class="footer">
        <button class="btn secondary" type="button" on:click={close} disabled={creating}>取消</button>
        <button class="btn primary" type="button" on:click={submit} disabled={creating || !directory.trim()}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if remoteWizardOpen}
  <RemoteWizard on:close={onWizardClose} />
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 84px;
    z-index: var(--z-modal);
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    border: none;
    padding: 0;
    margin: 0;
    cursor: default;
    animation: ocrc-fade var(--dur-1, 120ms) var(--ease-out, ease-out) backwards;
  }
  .modal {
    position: relative;
    z-index: 1;
    width: min(460px, 92vw);
    max-height: calc(100vh - 120px);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 24px 70px rgba(0,0,0,.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: ocrc-pop var(--dur-1, 120ms) var(--ease-out, ease-out);
  }
  @keyframes ocrc-pop {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .close {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
    font-size: 14px;
    transition: color .12s ease, background .12s ease, border-color .12s ease;
  }
  .close:hover { color: var(--text); background: var(--bg-elev2); border-color: var(--border); }

  .body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow-y: auto;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .12em;
    color: var(--text-3);
  }
  .optional {
    font-weight: 400;
    color: var(--text-4);
    text-transform: none;
    letter-spacing: normal;
  }

  .agent-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .agent-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 10px 5px 5px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    cursor: pointer;
    transition: border-color .12s ease, background .12s ease;
  }
  .agent-chip:hover { border-color: var(--accent); background: var(--bg-elev2); }
  .agent-chip.selected {
    background: var(--accent-2);
    border-color: var(--accent-line);
    color: var(--text);
  }
  .chip-tile {
    width: 22px;
    height: 22px;
    display: inline-grid;
    place-items: center;
    border-radius: var(--radius-xs);
    border: 1px solid transparent;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .chip-name {
    font-size: 12px;
    font-weight: 600;
  }
  .chip-status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  /* Visually hidden, still read by screen readers (text alternative for status dots). */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .chip-status.online { background: var(--dot, var(--ok)); border-color: var(--dot, var(--ok)); }
  .chip-status.connecting { background: var(--warn); border-color: var(--warn); animation: ocrc-pulse 1.2s ease-in-out infinite; }
  .chip-status.offline { background: transparent; border: 1.5px solid var(--text-4); }

  /* "+ 远程连接" — dashed affordance chip (ZCode add-account register). */
  .agent-chip.remote-add {
    border-style: dashed;
    color: var(--text-3);
    font-weight: 600;
  }
  .agent-chip.remote-add:hover { color: var(--text); border-color: var(--accent-line); }
  .remote-form {
    display: grid;
    grid-template-columns: 1fr 1fr 64px auto;
    gap: 6px;
    padding: 10px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .rf {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 13px;
    padding: 7px 9px;
    outline: none;
    min-width: 0;
  }
  .rf:focus { border-color: var(--accent); }
  .rf::placeholder { color: var(--text-4); }
  .rf-go { padding: 7px 12px; font-size: 12px; }

  /* DirectoryBrowser: step-by-step readdir (ZCode register). */
  .dir-browser {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    overflow: hidden;
  }
  .db-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-bottom: 1px solid var(--border);
  }
  .db-up {
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: var(--bg-input);
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 3px 7px;
    cursor: pointer;
  }
  .db-up:disabled { opacity: .4; cursor: default; }
  .db-up:hover:not(:disabled) { color: var(--text); border-color: var(--text-4); }
  .db-path {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .db-hidden {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-3);
    cursor: pointer;
    user-select: none;
  }
  .db-list {
    max-height: 210px;
    overflow-y: auto;
    padding: 3px;
  }
  .db-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .db-row:hover { background: var(--bg-elev); color: var(--text); }
  .db-ico { flex-shrink: 0; font-size: 9px; color: var(--text-4); }
  .db-name { font-family: var(--font-mono); }
  .db-note { padding: 12px 10px; font-size: 12px; color: var(--text-3); }
  .db-note.err { color: var(--err); }
  .db-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 9px;
    border-top: 1px solid var(--border);
  }
  .db-foot .btn { padding: 5px 11px; font-size: 12px; }

  .dir-input {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition: border-color .15s ease;
  }
  .dir-input:focus-within { border-color: var(--accent); }
  .dir-sug {
    margin-top: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    overflow: hidden; max-height: 180px; overflow-y: auto;
  }
  .dir-sug-item {
    display: flex; justify-content: space-between; gap: 10px; width: 100%;
    padding: 6px 10px; background: var(--bg-input); border: none;
    border-bottom: 1px solid var(--border); color: var(--text-2);
    font: inherit; font-size: 12px; cursor: pointer; text-align: left;
  }
  .dir-sug-item:hover { background: var(--bg-elev); color: var(--text); }
  .host-prefix {
    padding: 8px 0 8px 10px;
    font-size: 13px;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .path {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text);
    /* 16px: stop iOS Safari auto-zooming the page on focus (which left the modal oversized). */
    font-size: 16px;
    padding: 8px 10px;
    outline: none;
  }
  .path::placeholder { color: var(--text-4); }
  .browse {
    border: none;
    border-left: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
    padding: 0 12px;
    cursor: pointer;
    transition: color .12s ease, background .12s ease;
    flex-shrink: 0;
  }
  .browse:hover { color: var(--text); background: var(--bg-elev2); }

  .recents {
    display: none;
    flex-direction: column;
    gap: 6px;
  }
  .recents.open { display: flex; }
  .recents-label {
    font-size: 10px;
    color: var(--text-4);
    text-transform: uppercase;
    letter-spacing: .1em;
  }
  .recents-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 160px;
    overflow-y: auto;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .recent {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: background .12s ease;
  }
  .recent:hover { background: var(--bg-elev); }
  .recent-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .recent-dir {
    font-size: 11px;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
  }

  .error {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--err) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--err) 35%, transparent);
    border-radius: var(--radius-sm);
    color: var(--err);
    font-size: 12px;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .btn {
    padding: 7px 14px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
    transition: opacity .12s ease, transform .12s ease;
    border: none;
  }
  .btn:disabled { opacity: .5; cursor: default; }
  .secondary {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .secondary:hover:not(:disabled) { background: var(--bg-elev2); color: var(--text); }
  .primary {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .primary:hover:not(:disabled) { opacity: .9; }

  .empty {
    padding: 24px;
    text-align: center;
    color: var(--text-3);
    font-size: 14px;
  }
  .empty .retry {
    display: block;
    margin: 10px auto 0;
    padding: 5px 12px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
  }
  .empty .retry:hover { color: var(--text); border-color: var(--text-4); }

  @media (max-width: 820px) {
    .overlay {
      align-items: flex-end;
      /* Lift the bottom sheet above the on-screen keyboard (--kb is published by the
         layout's visualViewport tracker) so its inputs/buttons never sit behind it. */
      padding: 0 0 calc(env(safe-area-inset-bottom, 0px) + var(--kb, 0px));
      transition: padding-bottom .2s ease-out;
    }
    .modal {
      width: 100%;
      /* Shrink to the space left above the keyboard; the body scrolls if needed. */
      max-height: calc(86vh - var(--kb, 0px));
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      animation: sheetin var(--dur-3, 240ms) var(--ease-out, ease-out);
    }
    @keyframes sheetin {
      from { opacity: 0; transform: translateY(40px); }
      to { opacity: 1; transform: translateY(0); }
    }
  }
</style>
