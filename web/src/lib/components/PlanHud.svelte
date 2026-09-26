<!-- src/lib/components/PlanHud.svelte — mobile plan orb (≤820px).
     An enso-style floating ball with the session's todo progress as a ring
     stroke around it; tap to expand into the grouped plan card. Fixed anchor
     above the composer (ZCode parity: not draggable). Also surfaces subagent
     (child-session) todo progress — ZCode shows this, our data plane is
     parentID + per-child todos. Read-only: opencode has no todo write API. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api/client.js'
  import { feeds, sessionList } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { inspectorOpen } from '$lib/stores/ui.js'
  import { summarizeTodos, type TodoSummary } from '$lib/inspector/summarizeTodos.js'

  export let sessionId: string

  const KEY = 'ocrc.planHud'
  const INLINE_PENDING = 5
  const R = 17
  const CIRC = 2 * Math.PI * R

  type HudState = { dismissed?: string[]; expanded?: boolean }
  function loadState(): HudState {
    if (typeof localStorage === 'undefined') return {}
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
      return { dismissed: s.dismissed, expanded: s.expanded }
    } catch { return {} }
  }
  let hud: HudState = loadState()
  let expanded = hud.expanded ?? false

  function save(next?: Partial<HudState>) {
    hud = { ...hud, ...next }
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(KEY, JSON.stringify(hud)) } catch { /* private mode */ }
  }

  // Data plane = the Inspector's: pull /api/session/:id/todo, immediately on
  // session switch and debounced ~1s after any feed event (todowrite always
  // rides a tool-call event, so plan updates arrive without a poll loop).
  let sum: TodoSummary = { total: 0, done: 0, items: [] }
  let loadedFor: string | undefined
  async function refresh(sid: string) {
    try {
      const todos = await api.todo(sid)
      if (sid !== sessionId) return // session switched mid-flight — drop stale
      loadedFor = sid
      sum = summarizeTodos(todos)
    } catch { /* keep last valid summary */ }
  }
  let loadedSid: string | undefined
  $: if (sessionId !== loadedSid) { loadedSid = sessionId; void refresh(sessionId) }
  let tick = 0
  let lastSeqSeen = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  $: seq = $feeds[sessionId]?.lastSeq ?? 0
  $: if (seq !== lastSeqSeen) { lastSeqSeen = seq; clearTimeout(timer); timer = setTimeout(() => (tick += 1), 1000) }
  $: if (tick) { void refresh(sessionId); if (expanded) void refreshSubs(sessionId) }
  onDestroy(() => clearTimeout(timer))

  $: session = $sessionList.find((r) => r.id === sessionId)
  $: title = session?.title ?? ''

  $: doneItems = sum.items.filter((i) => i.status === 'done')
  $: runningItems = sum.items.filter((i) => i.status === 'running')
  $: pendingItems = sum.items.filter((i) => i.status === 'pending')
  $: restCount = Math.max(0, pendingItems.length - INLINE_PENDING)
  $: pct = sum.total ? sum.done / sum.total : 0
  $: dismissed = hud.dismissed?.includes(sessionId) ?? false

  // ── Subagents (child sessions): fetched when the card opens and on feed
  // activity. Unsupported backends answer with an empty list.
  interface SubRow { id: string; title: string; done: number; total: number }
  let subs: SubRow[] = []
  let subsFor: string | undefined
  async function refreshSubs(sid: string) {
    try {
      const r = await api.subagents(sid)
      if (sid !== sessionId) return
      subs = r.subagents ?? []
      subsFor = sid
    } catch { subs = [] }
  }
  $: if (expanded && sessionId && subsFor !== sessionId) void refreshSubs(sessionId)

  // Per-session reset of group/menu state.
  let groupSid: string | undefined
  let showDone = false
  let showRest = false
  let menuOpen = false
  $: if (sessionId !== groupSid) { groupSid = sessionId; showDone = false; showRest = false; menuOpen = false }

  function toggleExpanded() {
    expanded = !expanded
    if (expanded) void refreshSubs(sessionId)
    save({ expanded })
  }

  function hide() {
    save({ dismissed: [...(hud.dismissed ?? []), sessionId].slice(-20) })
    menuOpen = false
  }
  function openTasks() {
    menuOpen = false
    inspectorOpen.set(true)
  }

  let dotsEl: HTMLElement
  let menuEl: HTMLElement
  let cardEl: HTMLElement
  let ballEl: HTMLElement

  // Auto-collapse: a tap anywhere outside the card and the orb closes the
  // card — one overlay at a time (opening a chip popover therefore collapses
  // the plan card, and vice versa via the chips' own outside-close).
  function onOutside(e: PointerEvent) {
    const t = e.target as Node
    if (menuOpen) {
      if (menuEl?.contains(t) || dotsEl?.contains(t)) return
      menuOpen = false
    }
    if (!expanded) return
    if (cardEl?.contains(t) || ballEl?.contains(t)) return
    expanded = false
    save({ expanded: false })
  }
</script>

<svelte:window on:pointerdown={onOutside} />

{#if loadedFor === sessionId && sum.total > 0 && !dismissed && $can('todos')}
  {#if expanded}
    <div class="plan-card" bind:this={cardEl}>
      <div class="hd">
        <span class="label">Plan</span>
        <span class="title">{title || '…' + sessionId.slice(-8)}</span>
        <button
          class="dots"
          bind:this={dotsEl}
          aria-label="Plan menu"
          on:click|stopPropagation={() => (menuOpen = !menuOpen)}
        >⋯</button>
        <button class="close" aria-label="Collapse plan" on:click={toggleExpanded}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
      </div>

      {#if menuOpen}
        <div class="menu" bind:this={menuEl} role="menu">
          <button role="menuitem" on:click={openTasks}>Open task panel</button>
          <button role="menuitem" on:click={hide}>Hide for this session</button>
        </div>
      {/if}

      <div class="body">
        <div class="prog mono">Progress {sum.done}/{sum.total}</div>

        {#if doneItems.length}
          <button class="grp" aria-expanded={showDone} on:click={() => (showDone = !showDone)}>
            <svg class="caret" class:open={showDone} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            <span>Completed {doneItems.length}</span>
          </button>
          {#if showDone}
            {#each doneItems as it (it.text)}
              <div class="row done"><span class="box"><span class="check">✓</span></span><span class="tx">{it.text}</span></div>
            {/each}
          {/if}
        {/if}

        {#each runningItems as it (it.text)}
          <div class="row running"><span class="box"><span class="dot"></span></span><span class="tx">{it.text}</span></div>
        {/each}

        {#each pendingItems.slice(0, INLINE_PENDING) as it (it.text)}
          <div class="row pending"><span class="box"></span><span class="tx">{it.text}</span></div>
        {/each}

        {#if restCount > 0}
          <button class="grp" aria-expanded={showRest} on:click={() => (showRest = !showRest)}>
            <svg class="caret" class:open={showRest} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            <span>Pending {restCount}</span>
          </button>
          {#if showRest}
            {#each pendingItems.slice(INLINE_PENDING) as it (it.text)}
              <div class="row pending"><span class="box"></span><span class="tx">{it.text}</span></div>
            {/each}
          {/if}
        {/if}

        {#if subs.length}
          <div class="grp static"><span class="sub-label">Subagents</span></div>
          {#each subs as s (s.id)}
            <div class="row sub">
              <span class="sub-count mono">{s.done}/{s.total}</span>
              <span class="tx">{s.title || '…' + s.id.slice(-6)}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <button
    class="ball"
    bind:this={ballEl}
    aria-label={`${expanded ? 'Collapse' : 'Expand'} plan (${sum.done}/${sum.total})`}
    aria-expanded={expanded}
    on:click={toggleExpanded}
  >
    <svg class="ring" viewBox="0 0 38 38" aria-hidden="true">
      <circle
        class="arc"
        cx="19" cy="19" r={R}
        stroke-dasharray={`${Math.max(CIRC * pct, CIRC * 0.04)} ${CIRC}`}
      />
    </svg>
    <span class="ball-count mono">{sum.done}<i>/</i>{sum.total}</span>
    {#if subs.length > 0}<span class="badge mono">{subs.length}</span>{/if}
  </button>
{/if}

<style>
  /* Mobile only — desktop keeps the always-visible Inspector task panel. */
  .ball, .plan-card { display: none; }
  @media (max-width: 820px) {
    .ball { display: grid; }
    .plan-card { display: block; }
  }

  /* ── The orb: enso mark as progress — a single accent arc (no track), fixed
     above the composer. Sized to the titlebar avatar so they read as kin. ── */
  .ball {
    position: fixed;
    right: 16px;
    bottom: calc(var(--composer-h, 120px) + var(--kb, 0px) + 18px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-hud);
    width: 38px;
    height: 38px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--bg-elev);
    box-shadow: 0 6px 18px rgba(0, 0, 0, .26);
    cursor: pointer;
    place-items: center;
    transition: transform .15s var(--ease, ease);
  }
  .ball:active { transform: scale(.92); }
  .ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
  .arc {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
    transition: stroke-dasharray .4s var(--ease, ease);
  }
  .ball-count {
    position: relative;
    font-size: 9.5px;
    color: var(--text);
    letter-spacing: -.02em;
  }
  .ball-count i { font-style: normal; color: var(--text-3); padding: 0 1px; }
  .badge {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-ink);
    border-radius: var(--radius-pill);
    font-size: 9px;
    font-weight: 700;
    box-sizing: border-box;
  }

  /* ── Expanded card: anchored above the ball; only the BODY scrolls (the card
     itself stays overflow:visible so the ⋯ menu can escape it) ── */
  .plan-card {
    position: fixed;
    right: 16px;
    bottom: calc(var(--composer-h, 120px) + var(--kb, 0px) + 76px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-hud);
    width: min(86vw, 320px);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px rgba(0, 0, 0, .2);
    overflow: visible;
  }

  .hd {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 10px 10px 12px;
  }
  .label {
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: .14em;
    color: var(--text-3);
    font-size: 9.5px;
    font-weight: 600;
  }
  .title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .dots, .close {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    margin: 0;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
  }
  .dots { font-size: 14px; line-height: 1; }
  .close svg { width: 15px; height: 15px; }
  .dots:active, .close:active { background: var(--bg-elev2); color: var(--text); }

  .menu {
    position: absolute;
    top: 40px;
    right: 8px;
    z-index: 1;
    min-width: 168px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
  }
  .menu button {
    margin: 0;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover, .menu button:active { background: var(--bg-elev); color: var(--text); }

  .body {
    padding: 2px 12px 12px;
    border-top: 1px solid var(--border-2);
    max-height: calc(52vh - 47px); /* card total ≤ ~52vh: header (47px) + body */
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .prog {
    padding: 9px 0 7px;
    font-size: 11px;
    color: var(--text-3);
  }
  .grp {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0;
    padding: 3px 0;
    background: transparent;
    border: none;
    color: var(--text-3);
    font-size: 11.5px;
    cursor: pointer;
  }
  .grp.static { cursor: default; }
  .sub-label {
    text-transform: uppercase;
    letter-spacing: .12em;
    font-size: 9.5px;
    font-weight: 600;
  }
  .caret {
    width: 12px;
    height: 12px;
    transition: transform .16s ease;
    transform: rotate(0deg);
  }
  .caret.open { transform: rotate(90deg); }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 3px 0;
  }
  .box {
    flex-shrink: 0;
    width: 13px;
    height: 13px;
    margin-top: 2px;
    border-radius: var(--radius-xs);
    display: grid;
    place-items: center;
    border: 1.5px solid var(--border);
  }
  .row.done .box { background: var(--accent); border-color: var(--accent); }
  .check { font-size: 9px; line-height: 1; color: var(--accent-ink); }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .row.running .box { border-color: var(--accent); }
  .tx {
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-2);
    min-width: 0;
  }
  .row.done .tx { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--border); }
  .row.running .tx { color: var(--text); font-weight: 500; }

  .row.sub { padding-left: 2px; }
  .sub-count {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 10.5px;
    color: var(--accent);
    min-width: 26px;
  }
</style>
