<!-- src/lib/components/PlanHud.svelte — mobile floating plan card (≤820px).
     ZCode-mobile-style draggable plan window: collapsed = one-line progress,
     expanded = grouped todo list. Read-only by design — opencode exposes no
     todo write API (TaskPanel's toggle is likewise a local visual state). -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api } from '$lib/api/client.js'
  import { feeds, sessionList } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { inspectorOpen } from '$lib/stores/ui.js'
  import { summarizeTodos, type TodoSummary } from '$lib/inspector/summarizeTodos.js'

  export let sessionId: string

  const KEY = 'ocrc.planHud'
  const PREVIEW_PENDING = 2

  type HudState = { pos?: { x: number; y: number }; dismissed?: string[]; expanded?: boolean }
  function loadState(): HudState {
    if (typeof localStorage === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {} } catch { return {} }
  }
  let hud: HudState = loadState()
  let expanded = hud.expanded ?? false
  let pos: { x: number; y: number } = hud.pos ?? { x: 12, y: 64 }

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
  $: if (tick) void refresh(sessionId)
  onDestroy(() => clearTimeout(timer))

  $: session = $sessionList.find((r) => r.id === sessionId)
  $: title = session?.title ?? ''

  $: doneItems = sum.items.filter((i) => i.status === 'done')
  $: runningItems = sum.items.filter((i) => i.status === 'running')
  $: pendingItems = sum.items.filter((i) => i.status === 'pending')
  $: pct = sum.total ? Math.round((sum.done / sum.total) * 100) : 0
  $: restCount = Math.max(0, pendingItems.length - PREVIEW_PENDING)
  $: dismissed = hud.dismissed?.includes(sessionId) ?? false

  // Group/menu state is per session — switching resets it.
  let groupSid: string | undefined
  let showDone = false
  let showRest = false
  let menuOpen = false
  $: if (sessionId !== groupSid) { groupSid = sessionId; showDone = false; showRest = false; menuOpen = false }

  function hide() {
    save({ dismissed: [...(hud.dismissed ?? []), sessionId].slice(-20) })
    menuOpen = false
  }
  function openTasks() {
    menuOpen = false
    inspectorOpen.set(true)
  }

  // ── Drag (pointer events, 6px threshold separates tap-to-expand from drag) ──
  let el: HTMLElement
  let dotsEl: HTMLElement
  let menuEl: HTMLElement
  let active = false
  let moved = false
  let dragging = false
  let suppressClick = false
  let startPx = 0
  let startPy = 0
  let startX = 0
  let startY = 0

  // Hidden elements have zero box — clamping against them would fling the card,
  // so skip until it's actually laid out (also true for desktop, where the HUD
  // is display:none and the Inspector panel is the plan surface anyway).
  function clampToViewport(x: number, y: number): { x: number; y: number } {
    if (!el || el.offsetWidth === 0) return { x, y }
    return {
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - el.offsetWidth - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - el.offsetHeight - 8)),
    }
  }
  // env() isn't readable from JS directly — measure it with a throwaway probe.
  function safeTop(): number {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    const v = probe.getBoundingClientRect().top
    probe.remove()
    return v
  }
  onMount(() => {
    if (!hud.pos) pos = { x: 12, y: safeTop() + 62 }
    pos = clampToViewport(pos.x, pos.y)
    const onResize = () => { pos = clampToViewport(pos.x, pos.y) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  function onDown(e: PointerEvent) {
    active = true
    moved = false
    startPx = e.clientX
    startPy = e.clientY
    startX = pos.x
    startY = pos.y
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* jsdom */ }
  }
  function onMove(e: PointerEvent) {
    if (!active) return
    const dx = e.clientX - startPx
    const dy = e.clientY - startPy
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; dragging = true }
    if (dragging) pos = clampToViewport(startX + dx, startY + dy)
  }
  function onUp() {
    if (dragging) { suppressClick = true; save({ pos }) }
    active = false
    dragging = false
  }
  function onCancel() { active = false; dragging = false }
  function onHeaderClick() {
    if (suppressClick) { suppressClick = false; return }
    expanded = !expanded
    save({ expanded })
  }

  function onOutside(e: PointerEvent) {
    if (!menuOpen) return
    const t = e.target as Node
    if (menuEl?.contains(t) || dotsEl?.contains(t)) return
    menuOpen = false
  }
</script>

<svelte:window on:pointerdown={onOutside} />

{#if loadedFor === sessionId && sum.total > 0 && !dismissed && $can('todos')}
  <div
    class="plan-hud"
    class:expanded
    class:dragging
    bind:this={el}
    style="left:{pos.x}px; top:{pos.y}px"
  >
    <div class="bar" aria-hidden="true"><div class="fill" style="transform:scaleX({pct / 100})"></div></div>

    <div
      class="hd"
      role="button"
      tabindex="0"
      aria-expanded={expanded}
      on:pointerdown={onDown}
      on:pointermove={onMove}
      on:pointerup={onUp}
      on:pointercancel={onCancel}
      on:click={onHeaderClick}
      on:keydown={(e) => e.key === 'Enter' && onHeaderClick()}
    >
      <span class="label">Plan</span>
      <span class="title">{title || '…' + sessionId.slice(-8)}</span>
      {#if !expanded}<span class="count mono">{sum.done}/{sum.total}</span>{/if}
      <button
        class="dots"
        bind:this={dotsEl}
        aria-label="Plan menu"
        on:click|stopPropagation={() => (menuOpen = !menuOpen)}
      >⋯</button>
      <svg class="chev" class:flip={expanded} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </div>

    {#if menuOpen}
      <div class="menu" bind:this={menuEl} role="menu">
        <button role="menuitem" on:click={openTasks}>Open task panel</button>
        <button role="menuitem" on:click={hide}>Hide for this session</button>
      </div>
    {/if}

    {#if expanded}
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

        {#each pendingItems.slice(0, PREVIEW_PENDING) as it (it.text)}
          <div class="row pending"><span class="box"></span><span class="tx">{it.text}</span></div>
        {/each}

        {#if restCount > 0}
          <button class="grp" aria-expanded={showRest} on:click={() => (showRest = !showRest)}>
            <svg class="caret" class:open={showRest} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            <span>Pending {restCount}</span>
          </button>
          {#if showRest}
            {#each pendingItems.slice(PREVIEW_PENDING) as it (it.text)}
              <div class="row pending"><span class="box"></span><span class="tx">{it.text}</span></div>
            {/each}
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Mobile only — desktop keeps the always-visible Inspector task panel. */
  .plan-hud {
    display: none;
    position: fixed;
    z-index: var(--z-hud);
    width: min(78vw, 240px);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px rgba(0, 0, 0, .2);
    transition: width .18s var(--ease, ease), box-shadow .15s ease;
    overflow: visible;
  }
  @media (max-width: 820px) {
    .plan-hud { display: block; }
  }
  .plan-hud.expanded { width: min(88vw, 320px); }
  .plan-hud.dragging {
    transition: none;
    box-shadow: 0 16px 44px rgba(0, 0, 0, .32);
  }

  /* Hairline progress along the card's top edge — visible even collapsed. */
  .bar {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: var(--radius) var(--radius) 0 0;
    overflow: hidden;
    background: transparent;
  }
  .fill {
    height: 100%;
    width: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform .3s ease;
  }

  .hd {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 10px 10px 12px;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    touch-action: none; /* the header is the drag surface */
  }
  .plan-hud.dragging .hd { cursor: grabbing; }
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
  .count {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--accent);
  }
  .dots {
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
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .dots:active { background: var(--bg-elev2); color: var(--text); }
  .chev {
    flex-shrink: 0;
    width: 15px;
    height: 15px;
    color: var(--text-3);
    transition: transform .18s ease;
  }
  .chev.flip { transform: rotate(180deg); }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
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
    animation: hud-menu .14s ease both;
  }
  @keyframes hud-menu { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
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
</style>
