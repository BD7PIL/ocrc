<!-- src/lib/components/PlanHud.svelte — mobile plan orb (≤820px).
     The orb IS the ocrc enso mark: the ink ring (fixed 310° arc, gap top-right)
     plus the persimmon dot — except the dot GROWS with plan progress: at 0%
     it is exactly the logo's dot nested in the gap, at 100% the orange wraps
     the full ring over the ink. Tap to expand into the grouped plan card.
     Subagent (child-session) progress rides along (badge + card list).
     Read-only: opencode has no todo write API. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api/client.js'
  import { feeds, sessionList } from '$lib/stores/sessions.js'
  import { can } from '$lib/stores/capabilities.js'
  import { inspectorOpen } from '$lib/stores/ui.js'
  import { summarizeTodos, type TodoSummary } from '$lib/inspector/summarizeTodos.js'

  export let sessionId: string
  /** Jump target — the page owns navigation (goto), the HUD stays $app-free. */
  export let onJump: (id: string) => void = () => {}

  const KEY = 'ocrc.planHud'
  const INLINE_PENDING = 5
  // A plain progress ring — the honest design at 38px (logo-mark experiments
  // with brand arc + gauge + dot + count all read as clutter; the brand lives
  // in the titlebar/favicon). Dim full track + accent arc from 12 o'clock
  // (classic rotate -90°, real-unit dasharray, no pathLength/offset tricks).
  const R = 16
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
  $: if (tick) { void refresh(sessionId); void refreshSubs(sessionId) }
  onDestroy(() => clearTimeout(timer))

  $: session = $sessionList.find((r) => r.id === sessionId)
  $: title = session?.title ?? ''

  $: doneItems = sum.items.filter((i) => i.status === 'done')
  $: runningItems = sum.items.filter((i) => i.status === 'running')
  $: pendingItems = sum.items.filter((i) => i.status === 'pending')
  $: restCount = Math.max(0, pendingItems.length - INLINE_PENDING)
  $: pct = sum.total ? sum.done / sum.total : 0
  $: dismissed = hud.dismissed?.includes(sessionId) ?? false

  // ── Subagents (child sessions): fetched on session switch and alongside
  // every debounced tick — the badge must be live WITHOUT expanding (user
  // ask) and the card must not pop in empty on expand. Rows jump into the
  // child session (ZCode parity); the parent link is stashed so the child
  // card can offer a way back. Guarded against request pileup.
  interface SubRow { id: string; title: string; done: number; total: number }
  let subs: SubRow[] = []
  let subsFor: string | undefined
  let subsBusy = false
  async function refreshSubs(sid: string) {
    if (subsBusy) return
    subsBusy = true
    try {
      const r = await api.subagents(sid)
      if (sid !== sessionId) return
      subs = r.subagents ?? []
      subsFor = sid
    } catch { subs = [] } finally { subsBusy = false }
  }
  $: if (expanded && sessionId && subsFor !== sessionId) void refreshSubs(sessionId)

  // Breadcrumb: when THIS session is a subagent that was reached via the HUD,
  // the stashed parent gives the card a "back to parent" row (and keeps the
  // card renderable even if the child has no todos of its own).
  const SUB_PARENT_KEY = (id: string) => `ocrc.subparent.${id}`
  let breadcrumb: string | undefined
  function readBreadcrumb(sid: string) {
    try { breadcrumb = sessionStorage.getItem(SUB_PARENT_KEY(sid)) ?? undefined } catch { breadcrumb = undefined }
  }
  readBreadcrumb(sessionId)
  $: if (sessionId) readBreadcrumb(sessionId)
  function jumpToSub(s: SubRow) {
    try { sessionStorage.setItem(SUB_PARENT_KEY(s.id), sessionId) } catch { /* private mode */ }
    menuOpen = false
    onJump(s.id)
  }
  function jumpToParent() {
    const p = breadcrumb
    breadcrumb = undefined
    if (p) onJump(p)
  }

  // Per-session reset of group/menu state.
  let groupSid: string | undefined
  let showDone = false
  let showRest = false
  let menuOpen = false
  $: if (sessionId !== groupSid) { groupSid = sessionId; showDone = false; showRest = false; menuOpen = false }

  function toggleExpanded() {
    expanded = !expanded
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

{#if loadedFor === sessionId && (sum.total > 0 || subs.length > 0 || breadcrumb) && !dismissed && $can('todos')}
  {#if expanded}
    <div class="plan-card" bind:this={cardEl}>
      <div class="hd">
        <span class="label">计划</span>
        <span class="title">{title || '…' + sessionId.slice(-8)}</span>
        <button
          class="dots"
          bind:this={dotsEl}
          aria-label="Plan menu"
          on:click|stopPropagation={() => (menuOpen = !menuOpen)}
        >⋯</button>
        <button class="close" aria-label="收起计划" on:click={toggleExpanded}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
      </div>

      {#if menuOpen}
        <div class="menu" bind:this={menuEl} role="menu">
          <button role="menuitem" on:click={openTasks}>打开任务面板</button>
          <button role="menuitem" on:click={hide}>本会话隐藏</button>
        </div>
      {/if}

      <div class="body">
        {#if breadcrumb}
          <button class="crumb" on:click={jumpToParent}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            <span>返回父会话 …{breadcrumb.slice(-8)}</span>
          </button>
        {/if}
        <div class="prog mono">任务 {sum.done}/{sum.total}</div>

        {#if doneItems.length}
          <button class="grp" aria-expanded={showDone} on:click={() => (showDone = !showDone)}>
            <svg class="caret" class:open={showDone} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            <span>已完成 {doneItems.length}</span>
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
            <span>待处理 {restCount}</span>
          </button>
          {#if showRest}
            {#each pendingItems.slice(INLINE_PENDING) as it (it.text)}
              <div class="row pending"><span class="box"></span><span class="tx">{it.text}</span></div>
            {/each}
          {/if}
        {/if}

        {#if subs.length}
          <div class="grp static"><span class="sub-label">子代理 · {subs.length}</span></div>
          {#each subs as s (s.id)}
            <button class="row sub jump" on:click={() => jumpToSub(s)} title="打开子代理会话">
              {#if s.total > 0}<span class="sub-count mono">{s.done}/{s.total}</span>{/if}
              <span class="tx">{s.title || '…' + s.id.slice(-6)}</span>
              <svg class="go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <button
    class="ball"
    bind:this={ballEl}
    aria-label={`计划 ${sum.done}/${sum.total} — ${expanded ? '收起' : '展开'}`}
    aria-expanded={expanded}
    on:click={toggleExpanded}
  >
    <!-- Progress ring: dim full track + accent arc from 12 o'clock. -->
    <svg class="ring" viewBox="0 0 38 38" aria-hidden="true">
      <circle class="track" cx="19" cy="19" r={R} />
      <circle
        class="arc"
        cx="19" cy="19" r={R}
        stroke-dasharray={`${Math.max(CIRC * pct, CIRC * 0.02)} ${CIRC}`}
        transform="rotate(-90 19 19)"
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

  /* ── The orb IS the enso mark: ink ring (theme-tracked) + persimmon dot that
     grows along the ring with plan progress. Same proportions as the favicon
     and the titlebar brand mark. Center X still aligned to the send button
     (right = composer 12 + box 8 + half-send 22 − half-orb 19 = 23px). ── */
  .ball {
    position: fixed;
    right: 23px;
    bottom: calc(var(--composer-h, 120px) + var(--kb, 0px) + 8px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-hud);
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid var(--border-2);
    border-radius: 50%;
    background: var(--bg-elev);
    box-shadow: 0 6px 18px rgba(0, 0, 0, .22);
    cursor: pointer;
    place-items: center;
    transition: transform .15s var(--ease, ease);
    animation: ocrc-pop .22s var(--ease-out, ease-out) backwards;
  }
  .ball:active { transform: scale(.92); }
  .ring { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ring circle { fill: none; stroke-linecap: round; }
  .track { stroke: var(--border); stroke-width: 3.5; }
  .arc {
    stroke: var(--accent);
    stroke-width: 3.5;
    transition: stroke-dasharray .4s var(--ease, ease);
  }
  .ball-count {
    position: relative;
    font-size: 9.5px;
    color: var(--text);
    letter-spacing: -.02em;
  }
  .ball-count i { font-style: normal; color: var(--text-3); padding: 0 1px; }
  /* Bottom-right of the orb — top-right is the enso gap where the sun arc
     lives; a badge there covered the mark's focal point. */
  /* Parked fully OUTSIDE the ring (bottom-right per user, past the edge) so
     it never covers the track/arc; bg ring separates it from the track. */
  .badge {
    position: absolute;
    bottom: -8px;
    right: -9px;
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
    box-shadow: 0 0 0 2px var(--bg); /* separates it from the ring underneath */
  }

  /* ── Expanded card: anchored above the ball; only the BODY scrolls (the card
     itself stays overflow:visible so the ⋯ menu can escape it) ── */
  .plan-card {
    position: fixed;
    right: 16px;
    bottom: calc(var(--composer-h, 120px) + var(--kb, 0px) + 54px + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-hud);
    width: min(86vw, 320px);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 10px 30px rgba(0, 0, 0, .2);
    overflow: visible;
    transform-origin: 85% 100%;
    animation: ocrc-pop .18s var(--ease-out, ease-out) backwards;
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
  .row.sub.jump {
    margin: 0;
    padding: 3px 2px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    align-items: center;
  }
  .row.sub.jump:active { background: var(--bg-elev2); }
  .row.sub.jump .tx { flex: 1; min-width: 0; }
  .go { flex-shrink: 0; width: 12px; height: 12px; color: var(--text-3); }
  .crumb {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 9px 0 0;
    padding: 6px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    text-align: left;
  }
  .crumb svg { width: 12px; height: 12px; flex-shrink: 0; }
  .crumb:active { color: var(--text); border-color: var(--accent); }
  .sub-count {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 10.5px;
    color: var(--accent);
    min-width: 26px;
  }
</style>
