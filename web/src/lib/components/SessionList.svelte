<script lang="ts">
  import { goto } from '$app/navigation'
  import { sessionList, feeds } from '../stores/sessions.js'
  import { pinnedSessions } from '../stores/pins.js'
  import { activeWorkspace } from '../stores/workspaces.js'
  import { archivedSessions } from '../stores/archive.js'
  import { filterByWorkspace } from '../nav/workspaceFilter.js'
  import { matchesQuery, groupByProject, partitionTime, type RailGroupMode } from '../nav/railModel.js'
  import { connection } from '../stores/connection.js'
  import { api } from '../api/client.js'
  import { onDestroy } from 'svelte'
  import type { SessionSummary } from '../api/types.js'

  // PWA passes activeId from $page.params and relies on <a href> for routing.
  // Extension passes onSelect (and no <a href> navigation happens).
  export let activeId: string | undefined = undefined
  export let onSelect: ((id: string) => void) | undefined = undefined
  // v2: the list shows only the selected agent's sessions.
  export let agentId: string | undefined = undefined
  export let agentName: string | undefined = undefined

  const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000
  function isOnline(lastActiveAt: number, conn: string): boolean {
    return conn === 'connected' && Date.now() - lastActiveAt < ACTIVE_WINDOW_MS
  }

  // "Busy" = any live thinking/streaming card in the feed — a queued user
  // message appended after the streaming card must not flip it to idle.
  function isBusy(sid: string, all: typeof $feeds): boolean {
    const f = all[sid]
    if (!f || f.order.length === 0) return false
    return f.order.some((id) => {
      const k = f.byId[id]?.kind
      return k === 'thinking' || k === 'streaming' || k === 'think-stream'
    })
  }

  // A session is "waiting" if the tail of its feed is an unresolved approval card.
  function isWaiting(sid: string, all: typeof $feeds): boolean {
    const f = all[sid]
    if (!f || f.order.length === 0) return false
    const last = f.byId[f.order[f.order.length - 1]]
    return last?.kind === 'approval'
  }

  type Status = 'busy' | 'wait' | 'idle' | 'offline'
  function statusFor(s: SessionSummary, all: typeof $feeds, conn: string): Status {
    if (isBusy(s.id, all)) return 'busy'
    if (isWaiting(s.id, all)) return 'wait'
    if (isOnline(s.lastActiveAt, conn)) return 'idle'
    return 'offline'
  }

  $: statuses = new Map<string, Status>(
    $sessionList.map((s) => [s.id, statusFor(s, $feeds, $connection)]),
  )

  function formatTime(ts: number): string {
    const diff = Date.now() - ts
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'now'
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  }

  function shortId(id: string): string {
    const bare = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
    return bare.slice(-8)
  }

  // ── rail v2: view mode / search / archive ────────────────────────────────
  const MODE_KEY = 'ocrc.railGroup.v1'
  let mode: RailGroupMode = 'project'
  try { mode = localStorage.getItem(MODE_KEY) === 'time' ? 'time' : 'project' } catch { /* default */ }
  function setMode(m: RailGroupMode) {
    mode = m
    try { localStorage.setItem(MODE_KEY, m) } catch { /* ignore */ }
  }

  const COLLAPSE_KEY = 'ocrc.railCollapsed.v1'
  let collapsed = new Set<string>((() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')
      return Array.isArray(raw) ? (raw as string[]) : []
    } catch {
      return []
    }
  })())
  function toggleGroup(key: string) {
    const next = new Set(collapsed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    collapsed = next
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
  }

  let query = ''
  let showArchived = false
  const ARCHIVE_CAP = 20
  let archiveCap = ARCHIVE_CAP

  // Row actions ---------------------------------------------------------------
  function handleClick(e: MouseEvent, id: string) {
    if (onSelect) {
      e.preventDefault()
      onSelect(id)
    }
  }

  function togglePin(e: MouseEvent, id: string) {
    e.preventDefault()
    e.stopPropagation()
    pinnedSessions.toggle(id)
  }

  // Inline rename state.
  let editing: string | null = null
  let draft = ''
  let renaming: string | null = null

  function startRename(e: MouseEvent, s: SessionSummary) {
    e.preventDefault()
    e.stopPropagation()
    editing = s.id
    draft = s.title || ''
  }

  function cancelRename() {
    editing = null
    draft = ''
  }

  async function submitRename(id: string) {
    const title = draft.trim()
    if (!title || renaming) { cancelRename(); return }
    renaming = id
    try {
      await api.renameSession(id, title)
      sessionList.set(await api.sessions())
    } catch (err) {
      alert(`重命名失败：${(err as Error).message}`)
    } finally {
      renaming = null
      editing = null
      draft = ''
    }
  }

  function onRenameKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') { e.preventDefault(); submitRename(id) }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
  }

  function focusInput(node: HTMLInputElement) {
    node.focus()
    node.select()
  }

  let deleting: string | null = null
  // Mobile row menu: touch screens have no hover, and three 40px buttons
  // permanently ate ~1/3 of a 390px row (user report). One "⋯" opens an
  // inline menu with the same actions.
  let menuFor: string | null = null
  let menuEl: HTMLElement
  function toggleMenu(e: Event, id: string) {
    e.preventDefault()
    e.stopPropagation()
    menuFor = menuFor === id ? null : id
  }
  function menuAction(action: 'rename' | 'pin' | 'archive' | 'delete', id: string, session?: SessionSummary) {
    menuFor = null
    const fake = { preventDefault() {}, stopPropagation() {} } as MouseEvent
    if (action === 'pin') togglePin(fake, id)
    else if (action === 'archive') archivedSessions.toggle(id)
    else if (action === 'delete') deleteSession(fake, id)
    else if (session) startRename(fake, session)
  }
  function onMenuKey(e: KeyboardEvent) { if (e.key === 'Escape') menuFor = null }
  function onOutside(e: PointerEvent) {
    if (menuFor && menuEl && !menuEl.contains(e.target as Node)) menuFor = null
  }
  onDestroy(() => { menuFor = null })
  async function deleteSession(e: MouseEvent, id: string) {
    e.preventDefault()
    e.stopPropagation()
    if (deleting) return
    if (!confirm('Delete this session? This cannot be undone.')) return
    deleting = id
    try {
      await api.deleteSession(id)
      sessionList.set(await api.sessions())
      if (activeId === id) goto('/')
    } catch (err) {
      alert(`删除失败：${(err as Error).message}`)
    } finally {
      deleting = null
    }
  }

  // The session list shows only the selected agent's sessions (fallback for
  // legacy sessions with no backendId), then: query filter → archived split.
  // EXCEPTION — project mode is HUB semantics: it spans every backend so the
  // remote workspaces appear alongside local ones (the cloud/folder groups
  // ARE the local-vs-remote distinction); time mode keeps per-agent scoping.
  $: byAgent = agentId && mode === 'time'
    ? $sessionList.filter((s) => s.backendId === agentId || (!s.backendId && agentId === 'opencode'))
    : $sessionList
  $: workspaceScoped = filterByWorkspace(byAgent, $activeWorkspace)
  $: searched = workspaceScoped.filter((s) => matchesQuery(s, query))
  $: live = searched.filter((s) => !$archivedSessions.has(s.id))
  // the archive view lists ALL archived sessions — the toolbar query belongs
  // to the default view (a hidden input silently filtering a different view
  // was an OCR review finding)
  $: archivedRows = [...workspaceScoped.filter((s) => $archivedSessions.has(s.id))]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

  $: timeBuckets = partitionTime(live, $pinnedSessions)
  $: projectGroups = groupByProject(live)
</script>

<svelte:window on:pointerdown={onOutside} on:keydown={onMenuKey} />

<div class="sidebar">
  <!-- rail v2 toolbar: 项目/时间 toggle + archive switch (ZCode sidebar register) -->
  <div class="toolbar">
    <div class="modes" role="tablist" aria-label="分组方式">
      <button role="tab" aria-selected={mode === 'project'} class:on={mode === 'project'} on:click={() => setMode('project')}>项目</button>
      <button role="tab" aria-selected={mode === 'time'} class:on={mode === 'time'} on:click={() => setMode('time')}>时间</button>
    </div>
    <button
      class="archbtn"
      class:on={showArchived}
      title={showArchived ? '关闭归档' : '归档'}
      aria-label={showArchived ? '关闭归档' : '归档'}
      on:click={() => { showArchived = !showArchived; archiveCap = ARCHIVE_CAP }}
    >
      {#if showArchived}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      {:else}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
      {/if}
    </button>
  </div>

  {#if !showArchived}
    <div class="searchbox">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input placeholder="搜索会话 / 项目 / 主机" bind:value={query} aria-label="搜索会话" />
      {#if query}<button class="clear" aria-label="清除搜索" on:click={() => (query = '')}>×</button>{/if}
    </div>
  {/if}

  {#if showArchived}
    <!-- 归档区：平铺 + 取消归档（ZCode WorkspaceArchivedTasksFlatSection 同款） -->
    <div class="group-header mono"><span class="gh-label">归档</span><span class="gh-line"></span><span class="gh-count">{archivedRows.length}</span></div>
    {#each archivedRows.slice(0, archiveCap) as s (s.id)}
      {@render row(s, true)}
    {/each}
    {#if archivedRows.length > archiveCap}
      <button class="more mono" on:click={() => (archiveCap += ARCHIVE_CAP)}>显示更多（还有 {archivedRows.length - archiveCap} 条）</button>
    {/if}
    {#if archivedRows.length === 0}
      <div class="empty mono">没有归档的会话</div>
    {/if}
  {:else if mode === 'project'}
    {#each projectGroups as g (g.key)}
      <button class="group-head" class:collapsed={collapsed.has(g.key)} on:click={() => toggleGroup(g.key)} aria-expanded={!collapsed.has(g.key)}>
        {#if g.remote}
          <svg class="gicon cloud" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-.42-8.98 6 6 0 0 0-11.7 1.62A3.5 3.5 0 0 0 6.5 19z"/></svg>
        {:else}
          <svg class="gicon folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg>
        {/if}
        <span class="gh-label">{g.label}</span>
        {#if g.remote}<span class="gh-host mono">{g.remoteHost}</span>{/if}
        <span class="gh-spacer"></span>
        <span class="gh-count">{g.rows.length}</span>
        <span class="gh-caret" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </button>
      {#if !collapsed.has(g.key)}
        {#each g.rows as s (s.id)}
          {@render row(s, false)}
        {/each}
      {/if}
    {/each}
    {#if live.length === 0}
      <div class="empty mono">{query ? '没有匹配的会话' : `no sessions on ${agentName ?? 'this agent'} yet`}</div>
    {/if}
  {:else}
    {#each [{ key: 'pinned', label: 'Pinned', rows: timeBuckets.pinned }, { key: 'recent', label: 'Recent', rows: timeBuckets.recent }] as group (group.key)}
      {#if group.rows.length}
        <div class="group-header mono">
          <span class="gh-label">{group.label}</span>
          <span class="gh-line" aria-hidden="true"></span>
          <span class="gh-count">{group.rows.length}</span>
        </div>
        {#each group.rows as s (s.id)}
          {@render row(s, false)}
        {/each}
      {/if}
    {/each}
    {#if live.length === 0}
      <div class="empty mono">{query ? '没有匹配的会话' : `no sessions on ${agentName ?? 'this agent'} yet`}</div>
    {/if}
  {/if}
</div>

{#snippet row(s: SessionSummary, archived: boolean)}
  <a
    href="/{s.id}/"
    class="session"
    class:active={activeId === s.id}
    class:busy={statuses.get(s.id) === 'busy'}
    on:click={(e) => handleClick(e, s.id)}
  >
    <div class="line1">
      <span class="dot {statuses.get(s.id) ?? 'offline'}"><span class="sr-only">{statuses.get(s.id) ?? 'offline'}</span></span>
      {#if editing === s.id}
        <input
          class="rename-input"
          bind:value={draft}
          disabled={renaming === s.id}
          placeholder="Session title"
          aria-label="Session title"
          use:focusInput
          on:click={(e) => e.preventDefault()}
          on:keydown={(e) => onRenameKey(e, s.id)}
          on:blur={() => submitRename(s.id)}
        />
      {:else}
        <span class="title">{s.title || 'Untitled session'}</span>
        {#if $pinnedSessions.includes(s.id)}<span class="pin-dot" aria-label="已钉住">●</span>{/if}
        <span class="actions">
          <button class="act rename" title="重命名会话" aria-label="重命名会话" on:click={(e) => startRename(e, s)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          </button>
          <button class="act pin" class:on={$pinnedSessions.includes(s.id)} title={$pinnedSessions.includes(s.id) ? '取消钉住' : '钉住'} aria-label="钉住会话" on:click={(e) => togglePin(e, s.id)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill={$pinnedSessions.includes(s.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><line x1="12" y1="15" x2="12" y2="21"/></svg>
          </button>
          <button class="act arch" title={archived ? '取消归档' : '归档'} aria-label={archived ? '取消归档' : '归档'} on:click={(e) => { e.preventDefault(); e.stopPropagation(); archivedSessions.toggle(s.id) }}>
            {#if archived}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
            {/if}
          </button>
          <button class="act trash" title="删除会话" aria-label="删除会话" disabled={deleting === s.id} on:click={(e) => deleteSession(e, s.id)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
          <button
            class="act mmore"
            class:on={menuFor === s.id}
            title="会话操作"
            aria-label="会话操作"
            aria-expanded={menuFor === s.id}
            on:click={(e) => toggleMenu(e, s.id)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
          </button>
          {#if menuFor === s.id}
            <span class="rowmenu" bind:this={menuEl} role="menu">
              <button role="menuitem" on:click|stopPropagation={() => menuAction('rename', s.id, s)}>重命名</button>
              <button role="menuitem" on:click|stopPropagation={() => menuAction('pin', s.id)}>{$pinnedSessions.includes(s.id) ? '取消钉住' : '钉住'}</button>
              <button role="menuitem" on:click|stopPropagation={() => menuAction('archive', s.id)}>{$archivedSessions.has(s.id) ? '取消归档' : '归档'}</button>
              <button role="menuitem" class="danger" on:click|stopPropagation={() => menuAction('delete', s.id)}>删除…</button>
            </span>
          {/if}
        </span>
      {/if}
    </div>
    <div class="meta mono">
      <span class="id">{shortId(s.id)}</span>
      {#if s.directory}<span class="sep">·</span><span class="repo">{s.directory.replace(/\/+$/, '').split('/').pop()}</span>{/if}
      <span class="sep">·</span><span>{formatTime(s.lastActiveAt)}</span>
      {#if s.additions || s.deletions}
        <span class="sep">·</span>
        {#if s.additions}<span class="add">+{s.additions}</span>{/if}
        {#if s.deletions}<span class="del">−{s.deletions}</span>{/if}
      {/if}
    </div>
    {#if statuses.get(s.id) === 'busy'}
      <div class="progress" aria-hidden="true"><span class="progress-fill"></span></div>
    {/if}
  </a>
{/snippet}

<style>
  .sidebar {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-panel);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 4px 8px 8px;
    gap: 2px;
  }

  /* rail v2 toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 4px 6px;
    flex-shrink: 0;
  }
  .modes {
    display: inline-flex;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 2px;
    gap: 2px;
  }
  .modes button {
    padding: 2px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-pill);
    color: var(--text-3);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: color .12s ease, background .12s ease;
  }
  .modes button:hover { color: var(--text-2); }
  .modes button.on { background: var(--bg-elev2); color: var(--text); }
  .archbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
    transition: color .12s ease, border-color .12s ease;
  }
  .archbtn:hover { color: var(--text); border-color: var(--border); }
  .archbtn.on { color: var(--accent); border-color: var(--accent); }

  .searchbox {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 2px 4px;
    padding: 5px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-4);
    flex-shrink: 0;
  }
  .searchbox:focus-within { border-color: var(--accent); color: var(--text-3); }
  .searchbox input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }
  .searchbox .clear {
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 13px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
  }
  .searchbox .clear:hover { color: var(--text); }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 6px;
    color: var(--text-4);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .16em;
  }
  .gh-label { flex-shrink: 0; }
  .gh-line {
    flex: 1;
    height: 1px;
    background: var(--border-2);
    opacity: .7;
  }
  .gh-count {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  /* project group header (folder/cloud + label + count + caret) */
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 8px 5px;
    background: transparent;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: color .12s ease;
  }
  .group-head:hover { color: var(--text); }
  .gicon { flex-shrink: 0; color: var(--text-3); }
  .gicon.cloud { color: var(--text-3); }
  .group-head .gh-label {
    font-size: 11.5px;
    font-weight: 600;
    color: inherit;
    text-transform: none;
    letter-spacing: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gh-host {
    font-size: 9.5px;
    color: var(--text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gh-spacer { flex: 1; }
  .group-head .gh-count { font-size: 10px; color: var(--text-4); }
  .gh-caret { display: inline-flex; color: var(--text-4); transition: transform .14s ease; }
  .group-head.collapsed .gh-caret { transform: rotate(-90deg); }

  .more {
    margin: 4px 8px;
    padding: 5px 8px;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    font-size: 10px;
    cursor: pointer;
  }
  .more:hover { color: var(--text); border-color: var(--text-4); }

  .session {
    position: relative;
    display: block;
    text-decoration: none;
    padding: 9px 12px 9px 16px;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    transition: background .12s ease;
  }
  .session:hover { background: var(--bg-elev); }
  /* Selected row = neutral fill + the orange edge bar carries the selection —
     a full-width peach fill read as a large orange area (user ruling: orange
     is an accent for key controls, never a surface). */
  .session.active {
    background: var(--bg-elev2);
  }
  .session.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 9px;
    bottom: 9px;
    width: 2.5px;
    border-radius: var(--radius-bar);
    background: var(--accent);
  }

  .line1 { display: flex; align-items: center; gap: 7px; }
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
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    flex-shrink: 0;
    box-sizing: border-box;
  }
  .dot.busy {
    background: var(--accent);
    border-color: var(--accent);
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .dot.wait {
    background: var(--warn);
    border-color: var(--warn);
  }
  /* idle is --ok (not --accent): busy/idle must differ by color alone, since
     reduced-motion removes the busy pulse. */
  .dot.idle {
    background: var(--ok);
    border-color: var(--ok);
  }
  .dot.offline {
    background: transparent;
    border: 1.5px solid var(--text-4);
  }

  .title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session.active .title { color: var(--text); }

  .pin-dot {
    flex-shrink: 0;
    font-size: 7px;
    color: var(--accent);
    line-height: 1;
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    /* 16px so renaming inline doesn't trigger iOS auto-zoom. */
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    outline: none;
    font-family: inherit;
  }
  .rename-input:disabled { opacity: .6; }

  .actions { display: inline-flex; gap: 1px; flex-shrink: 0; }
  .act {
    display: inline-flex;
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    padding: 2px;
    opacity: 0;
    transition: opacity .12s ease, color .12s ease;
  }
  .session:hover .act { opacity: .65; }
  /* Keyboard: row actions become visible when focus lands inside the row. */
  .session:focus-within .act { opacity: .65; }
  .act:hover { opacity: 1; }
  .act.pin:hover { color: var(--text); }
  .act.rename:hover { color: var(--accent); }
  .act.pin.on { opacity: 1; color: var(--accent); }
  .act.arch:hover { color: var(--accent); }
  .act.trash:hover { color: var(--err); }
  .act:disabled { opacity: .4; cursor: default; }
  /* Desktop: the mobile ⋯ button and its menu are hidden (hover buttons
     suffice). MUST precede the media block — same-specificity rules resolve
     by order, and a later hide would kill the mobile display (the PlanHud
     form-swap lesson). */
  .act.mmore, .rowmenu { display: none; }

  @media (hover: none) and (pointer: coarse), (max-width: 820px) {
    /* Touch screens: the hover buttons collapse into ONE "⋯" that opens a
       row menu — three 40px buttons ate a third of a 390px row (user
       report). ≥40px touch target preserved on the single control.
       hover:none alone is NOT enough: a desktop headless browser without
       hover capabilities reports hover:none at pointer:fine and would get
       the mobile row UI (CDP visual-audit lesson). */
    .act { opacity: .6; padding: 8px; min-width: 40px; min-height: 40px; align-items: center; justify-content: center; }
    .act.rename, .act.pin, .act.arch, .act.trash { display: none; }
    .act.mmore { display: inline-flex; opacity: .7; }
    .act.mmore.on { opacity: 1; color: var(--text); }
    .actions { gap: 2px; position: relative; }
    .rowmenu {
      position: absolute;
      right: 0;
      top: calc(100% + 2px);
      min-width: 140px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      box-shadow: 0 14px 36px rgba(0, 0, 0, .3);
      padding: 4px;
      z-index: var(--z-popover);
      display: flex;
      flex-direction: column;
      animation: ocrc-pop .14s var(--ease-out, ease-out);
    }
    .rowmenu button {
      display: block;
      width: 100%;
      padding: 9px 12px;
      background: transparent;
      border: none;
      border-radius: var(--radius-xs);
      color: var(--text-2);
      font: inherit;
      font-size: 12.5px;
      text-align: left;
      cursor: pointer;
    }
    .rowmenu button:hover { background: var(--bg-input); color: var(--text); }
    .rowmenu button.danger { color: var(--err); }
  }


  .meta {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    font-size: 10.5px;
    color: var(--text-3);
    margin: 4px 0 0 16px;
  }
  .sep { color: var(--border); }
  .id { color: var(--text-2); }
  .repo { color: var(--text-2); }
  .add { color: var(--ok); }
  .del { color: var(--err); }
  .empty { padding: 16px 12px; color: var(--text-3); font-size: 11px; }

  .progress {
    height: 3px;
    margin-top: 8px;
    background: var(--border-2);
    border-radius: var(--radius-bar);
    overflow: hidden;
  }
  .progress-fill {
    display: block;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%);
    background-size: 200% 100%;
    animation: ocrc-shimmer 1.4s linear infinite;
  }
</style>
