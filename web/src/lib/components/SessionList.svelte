<script lang="ts">
  import { goto } from '$app/navigation'
  import { sessionList, feeds } from '../stores/sessions.js'
  import { pinnedSessions } from '../stores/pins.js'
  import { activeWorkspace } from '../stores/workspaces.js'
  import { filterByWorkspace } from '../nav/workspaceFilter.js'
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

  // Reactive so statuses recompute when the feed/connection/list changes — a plain
  // function reading $stores in the template is NOT tracked by legacy Svelte.
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

  // Last 8 chars of the id, minus any "ses_"-style prefix.
  function shortId(id: string): string {
    const bare = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id
    return bare.slice(-8)
  }

  function repoName(dir?: string): string {
    if (!dir) return ''
    const parts = dir.replace(/\/+$/, '').split('/')
    return parts[parts.length - 1] || ''
  }

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
  // inline menu with the same three actions.
  let menuFor: string | null = null
  let menuEl: HTMLElement
  function toggleMenu(e: Event, id: string) {
    e.preventDefault()
    e.stopPropagation()
    menuFor = menuFor === id ? null : id
  }
  function menuAction(action: 'rename' | 'pin' | 'delete', id: string, session?: SessionSummary) {
    menuFor = null
    const fake = { preventDefault() {}, stopPropagation() {} } as MouseEvent
    if (action === 'pin') togglePin(fake, id)
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

  // The session list shows only the selected agent's sessions (fallback for legacy sessions with no backendId).
  $: byAgent = agentId
    ? $sessionList.filter((s) => s.backendId === agentId || (!s.backendId && agentId === 'opencode'))
    : $sessionList
  // Filter to the active workspace, then sort most-recent first and split pinned / recent.
  $: visible = filterByWorkspace(byAgent, $activeWorkspace)
  $: byRecent = [...visible].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  $: pinned = byRecent.filter((s) => $pinnedSessions.includes(s.id))
  $: recent = byRecent.filter((s) => !$pinnedSessions.includes(s.id))
  $: groups = [
    { key: 'pinned', label: 'Pinned', rows: pinned },
    { key: 'recent', label: 'Recent', rows: recent },
  ]
</script>

<svelte:window on:pointerdown={onOutside} on:keydown={onMenuKey} />

<div class="sidebar">
  {#each groups as group (group.key)}
    {#if group.rows.length}
      <div class="group-header mono">
        <span class="gh-label">{group.label}</span>
        <span class="gh-line" aria-hidden="true"></span>
        <span class="gh-count">{group.rows.length}</span>
      </div>
      {#each group.rows as s (s.id)}
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
                <!-- Desktop: hover-revealed inline buttons (unchanged). -->
                <button class="act rename" title="重命名会话" aria-label="重命名会话" on:click={(e) => startRename(e, s)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                </button>
                <button class="act pin" class:on={$pinnedSessions.includes(s.id)} title={$pinnedSessions.includes(s.id) ? '取消钉住' : '钉住'} aria-label="钉住会话" on:click={(e) => togglePin(e, s.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={$pinnedSessions.includes(s.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><line x1="12" y1="15" x2="12" y2="21"/></svg>
                </button>
                <button class="act trash" title="删除会话" aria-label="删除会话" disabled={deleting === s.id} on:click={(e) => deleteSession(e, s.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
                <!-- Mobile: one ⋅⋅⋅ opens the row menu (three 40px buttons
                     permanently ate a third of the row on touch screens). -->
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
                    <button role="menuitem" class="danger" on:click|stopPropagation={() => menuAction('delete', s.id)}>删除…</button>
                  </span>
                {/if}
              </span>
            {/if}
          </div>
          <div class="meta mono">
            <span class="id">{shortId(s.id)}</span>
            {#if repoName(s.directory)}<span class="sep">·</span><span class="repo">{repoName(s.directory)}</span>{/if}
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
      {/each}
    {/if}
  {/each}
  {#if visible.length === 0}
    <div class="empty mono">no sessions on {agentName ?? 'this agent'} yet</div>
  {/if}
</div>

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
    border: 0;
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
  .act.trash:hover { color: var(--err); }
  .act:disabled { opacity: .4; cursor: default; }
  /* Desktop: the mobile ⋯ button and its menu are hidden (hover buttons
     suffice). MUST precede the media block — same-specificity rules resolve
     by order, and a later hide would kill the mobile display (the PlanHud
     form-swap lesson). */
  .act.mmore, .rowmenu { display: none; }

  @media (hover: none), (max-width: 820px) {
    /* Touch screens: the three hover buttons collapse into ONE "⋯" that
       opens a row menu — three 40px buttons ate a third of a 390px row
       (user report). ≥40px touch target preserved on the single control. */
    .act { opacity: .6; padding: 8px; min-width: 40px; min-height: 40px; align-items: center; justify-content: center; }
    .act.rename, .act.pin, .act.trash { display: none; }
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
