<script lang="ts">
  import '$lib/theme.css'
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { page } from '$app/stores'
  import { afterNavigate } from '$app/navigation'
  import { api } from '$lib/api/client.js'
  import { createWsClient } from '$lib/ws/client.js'
  import { setWsSend } from '$lib/ws/send.js'
  import { sidePane } from '$lib/stores/sidePane.js'
  import { sessionList, feeds, upsertCard, setHistory, pruneFeeds, isSeqGap } from '$lib/stores/sessions.js'
  import { setViewedSession, noteSessionActivity } from '$lib/notify.js'
  import { capabilities, loadCapabilities, backends, loadBackends, viewedSessionId, applyAgentTheme } from '$lib/stores/capabilities.js'
  import { paletteOpen } from '$lib/stores/palette.js'
  import { leftPanelOpen, plusMenuOpen, newSessionOpen, inspectorOpen, feedResyncing, sessionBooting } from '$lib/stores/ui.js'
  import { auth } from '$lib/auth.js'
  import Titlebar from '$lib/components/Titlebar.svelte'
  import OfflineBanner from '$lib/components/OfflineBanner.svelte'
  import AgentPanel from '$lib/components/AgentPanel.svelte'
  import Inspector from '$lib/components/Inspector.svelte'
  import CommandPalette from '$lib/components/CommandPalette.svelte'
  import NewSessionModal from '$lib/components/NewSessionModal.svelte'
	import ChannelsModal from '$lib/components/ChannelsModal.svelte'
  import PlusMenu from '$lib/components/PlusMenu.svelte'
  import MobileFab from '$lib/components/MobileFab.svelte'
  import PairGate from '$lib/components/PairGate.svelte'
  // Auth state comes from the $auth store ($lib/auth.ts): 'pairing'/'rejected'
  // render the PairGate over the app; 'ready' boots the API/WS connection below.
  // Mobile off-canvas drawers (≤820px): ☰ opens sessions (left), ⓘ opens the
  // inspector (right). No effect on the desktop 3-pane layout.
  let drawerLeft = false
  let isMobile = false
  let appEl: HTMLElement // the 100vh app shell — its height is the full-screen reference for --kb
  let newButtonAnchor: HTMLElement | null = null
  function closeDrawers() { drawerLeft = false; inspectorOpen.set(false) }
  // The left rail drawer and the inspector sheet are mutually exclusive on mobile.
  function toggleLeft() { drawerLeft = !drawerLeft; inspectorOpen.set(false) }
  function toggleRight() { inspectorOpen.update((v) => !v); drawerLeft = false }
  function onGlobalKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); paletteOpen.set(true); return }
    // ⌘B / Ctrl+B — the convention toggle for the session rail (same affordance
    // as the strip and the divider double-click; three roads, one state).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); leftPanelOpen.update((v) => !v); return }
    if (e.key === 'Escape') {
      if (get(plusMenuOpen)) { plusMenuOpen.set(false); return }
      if (get(newSessionOpen)) { newSessionOpen.set(false); return }
      closeDrawers()
    }
  }

  let email = ''
  let wsClient: ReturnType<typeof createWsClient> | null = null

  // ── Resizable three-pane (desktop): draggable dividers adjust --rail-w /
  // --insp-w; sizes persist in localStorage. Mobile drawers ignore them
  // (the ≤820px media block overrides widths and hides the dividers). ──
  let railW = 264
  let inspW = 380
  let resizing: 'rail' | 'insp' | null = null
  try {
    railW = Math.max(180, Math.min(520, Number(localStorage.getItem('ocrc.railW')) || 264))
    inspW = Math.max(280, Math.min(560, Number(localStorage.getItem('ocrc.inspW')) || 380))
  } catch { /* private mode */ }
  function startResize(which: 'rail' | 'insp', e: PointerEvent) {
    if (window.matchMedia('(max-width: 820px)').matches) return
    e.preventDefault()
    resizing = which
    const startX = e.clientX
    const startW = which === 'rail' ? railW : inspW
    const move = (ev: PointerEvent) => {
      const d = which === 'rail' ? ev.clientX - startX : startX - ev.clientX
      const w = Math.max(which === 'rail' ? 180 : 220, Math.min(520, startW + d))
      if (which === 'rail') railW = w; else inspW = w
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      resizing = null
      try {
        localStorage.setItem('ocrc.railW', String(railW))
        localStorage.setItem('ocrc.inspW', String(inspW))
      } catch { /* private mode */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // PWA install affordance (Chromium fires beforeinstallprompt when installable).
  let installEvent: any = null
  async function install() {
    if (!installEvent) return
    installEvent.prompt()
    await installEvent.userChoice
    installEvent = null
  }
  let lastLoaded: string | null = null

  // A torn feed (replay couldn't bridge a long disconnect, or a seq gap
  // slipped through) can't be repaired by more replay: refetch the REST
  // snapshot and re-subscribe from its lastSeq. Latched so concurrent
  // triggers (replayEnd + gap timer) collapse into one fetch.
  let resyncInFlight = false
  let lastResyncAt = 0
  let gapTimer: ReturnType<typeof setTimeout> | undefined
  async function resyncViaRest(id: string) {
    if (resyncInFlight || Date.now() - lastResyncAt < 2000) return
    resyncInFlight = true
    lastResyncAt = Date.now()
    try {
      const { cards, lastSeq } = await api.history(id)
      // The replacement re-keys history cards — suppress the stream's
      // :last-child entrance for one beat (a resync IS history, rule 1).
      feedResyncing.set(true)
      setHistory(id, cards, lastSeq)
      setTimeout(() => feedResyncing.set(false), 350)
      wsClient?.send({ type: 'subscribe', sessionId: id, sinceSeq: lastSeq })
    } catch (err) {
      console.warn('[layout] resync failed', err)
    } finally {
      resyncInFlight = false
    }
  }

  function loadSession(id: string | undefined) {
    // No API traffic until the connection is authed (a 401 in pairing state
    // would misroute to the legacy CF reload path).
    if (get(auth) !== 'ready') return
    // Capability gating keys off the viewed session's backend.
    viewedSessionId.set(id)
    setViewedSession(id)
    // Only the viewed session is subscribed, so evict every other feed —
    // visited sessions' histories must not accumulate in memory forever.
    // Leaving the viewed session evicts EVERYTHING and must also clear the
    // load latch: otherwise returning to the same session hits the
    // `id === lastLoaded` skip below with an evicted (empty) feed — the
    // "refresh shows a blank session" bug.
    if (!id) {
      pruneFeeds(undefined)
      lastLoaded = null
      return
    }
    pruneFeeds(id)
    const feedEmpty = !(get(feeds)[id]?.order?.length)
    if (id === lastLoaded && !feedEmpty) return
    lastLoaded = id
    sessionBooting.set(true)
    api.history(id)
      .then(({ cards, lastSeq }) => {
        setHistory(id, cards, lastSeq)
        sessionBooting.set(false)
        // Subscribe with sinceSeq so the WS replays only cards published after
        // this snapshot — no gap, no duplicate.
        wsClient?.send({ type: 'subscribe', sessionId: id, sinceSeq: lastSeq })
      })
      .catch((err) => {
        console.warn('[layout] history failed', err)
        // An empty feed — NOT a missing one: a missing feed keeps the
        // "loading" state alive forever and reads as flicker on the page.
        setHistory(id, [], 0)
        sessionBooting.set(false)
        wsClient?.send({ type: 'subscribe', sessionId: id })
      })
  }

  // API/WS boot — runs on EVERY transition into 'ready'. The first boot can
  // happen with a token the server then rejects (→ gate → re-pair), so the
  // latch must not survive a rejection: re-pairing must start a fresh
  // connection, not find a half-dead one.
  function bootConnection() {
    if (wsClient) { wsClient.close(); wsClient = null }

    api.me().then((m) => { email = m.email }).catch(() => {})
    api.sessions().then((list) => { sessionList.set(list) }).catch(() => {})
    loadCapabilities()
    loadBackends()

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // Right-pane live tabs send their own subscribe/unsubscribe through here.
    setWsSend((msg) => wsClient?.send(msg))
    wsClient = createWsClient({
      url: `${protocol}//${location.host}/ws`,
      // On reconnect, re-subscribe with the feed's current lastSeq so the WS
      // replays only what we missed while disconnected.
      onReconnect: () => {
        if (lastLoaded) {
          const sinceSeq = get(feeds)[lastLoaded]?.lastSeq ?? 0
          wsClient?.send({ type: 'subscribe', sessionId: lastLoaded, sinceSeq })
        }
      },
      onMessage: (msg) => {
        if (msg.type === 'card' && msg.card) {
          const sid = (msg.card as { sessionId?: string }).sessionId
          const lastSeq = sid ? get(feeds)[sid]?.lastSeq ?? 0 : 0
          upsertCard(msg.card)
          // Gap safety net: a skipped seq on a live socket means missed frames.
          // Debounced — a burst of gapless cards after the gapped one must not
          // stack multiple resyncs.
          if (sid && isSeqGap(lastSeq, msg.card)) {
            clearTimeout(gapTimer)
            gapTimer = setTimeout(() => { void resyncViaRest(sid) }, 500)
          }
        }
        // hello (on connect) and sessions (live updates) both carry the list.
        if ((msg.type === 'hello' || msg.type === 'sessions') && msg.sessions) {
          sessionList.set(msg.sessions)
          // B1: background-completion notifications (title flash) — feed the
          // same broadcast; non-viewed activity raises the counter.
          noteSessionActivity(msg.sessions)
        }
        // replayEnd with complete=false: the server's ring buffer no longer
        // reaches back to our snapshot — replay cannot heal this feed.
        if (msg.type === 'replayEnd' && msg.complete === false && typeof msg.sessionId === 'string') {
          void resyncViaRest(msg.sessionId)
        }
      },
    })

    // afterNavigate doesn't fire for the first page load — handle it here.
    loadSession($page.params.sessionId)
  }

  onMount(() => {
    // Boot the connection once auth is ready — immediately on load with a
    // token, or later, reactively, after an in-app pairing (no reload).
    const unsubAuth = auth.subscribe((s) => { if (s === 'ready') bootConnection() })

    const onBeforeInstall = (e: Event) => { e.preventDefault(); installEvent = e }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    // Track the mobile breakpoint so AgentPanel can render in drawer mode
    // (panel-only, no spine toggle).
    const mq = window.matchMedia('(max-width: 820px)')
    isMobile = mq.matches
    const onMq = (e: MediaQueryListEvent) => { isMobile = e.matches; if (!e.matches) closeDrawers() }
    mq.addEventListener('change', onMq)

    // (B) Keyboard / toolbar follow by PINNING THE APP SHELL to the visual
    // viewport. The previous scheme kept .app at a constant 100vh and translated
    // the composer by --kb (= occluded height); it broke on Android browsers
    // that PAN the visual viewport when an input is focused (vv.offsetTop > 0):
    // the fixed app stayed painted at the layout top — the header slid off
    // screen and the composer stranded mid-air above a dead gap. Pinning is
    // unambiguous in every browser:
    //   app height     = vv.height    (the truly visible area)
    //   app transform  = vv.offsetTop (the visual viewport's pan)
    // The shell then ends exactly at the keyboard top; every --kb consumer
    // (composer translate, chat fade mask, footer/FAB/sheet insets) resolves
    // to its 0px fallback, which is precisely correct — nothing is occluded.
    const vv = window.visualViewport
    const setKb = () => {
      if (!vv || !appEl) return
      // iOS Safari auto-scrolls the page to reveal a focused input; undo it so
      // the fixed app stays pinned.
      if (window.scrollY !== 0) window.scrollTo(0, 0)
      appEl.style.height = `${Math.round(vv.height)}px`
      appEl.style.transform = vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : ''
    }
    setKb()
    vv?.addEventListener('resize', setKb)
    vv?.addEventListener('scroll', setKb)
    const onOrient = () => setTimeout(setKb, 300)
    window.addEventListener('orientationchange', onOrient)

    // (C) iOS fires only sparse visualViewport sizes during the keyboard
    // animation, so after a focus change re-run setKb every frame for a short
    // window — coalesced, and guaranteed to land on the final --kb (the transform
    // transition smooths the steps; we never get stuck mid-animation).
    let settleUntil = 0
    let settleRAF = 0
    const settleLoop = () => {
      setKb()
      if (Date.now() < settleUntil) settleRAF = requestAnimationFrame(settleLoop)
      else settleRAF = 0
    }
    const startSettle = () => {
      settleUntil = Date.now() + 650
      if (!settleRAF) settleRAF = requestAnimationFrame(settleLoop)
    }
    window.addEventListener('focusin', startSettle)
    window.addEventListener('focusout', startSettle)

    return () => {
      unsubAuth()
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      mq.removeEventListener('change', onMq)
      vv?.removeEventListener('resize', setKb)
      vv?.removeEventListener('scroll', setKb)
      window.removeEventListener('focusin', startSettle)
      window.removeEventListener('focusout', startSettle)
      window.removeEventListener('orientationchange', onOrient)
      if (settleRAF) cancelAnimationFrame(settleRAF)
      clearTimeout(gapTimer)
      wsClient?.close()
    }
  })

  // Keep the chrome accent in sync with the active agent.
  $: if ($backends && typeof document !== 'undefined') {
    applyAgentTheme($backends.activeId)
  }

  // v2 mobile dual-screen: no active session → the Sessions screen (agent panel)
  // fills the viewport; selecting one navigates to the Chat screen. ☰ re-opens it.
  $: hasSession = !!$page.params.sessionId

  // afterNavigate runs after each client-side navigation completes,
  // so it never collides with the navigation's own page-store updates
  // (which used to cause an effect-update loop in the previous design).
  afterNavigate((nav) => {
    closeDrawers() // selecting a session in the drawer closes it
    loadSession(nav.to?.params?.sessionId)
  })
</script>

<svelte:window on:keydown={onGlobalKey} />

<div class="app" bind:this={appEl} style="--rail-w:{railW}px; --insp-w:{inspW}px">
  <!-- On mobile the chat screen has its own header (back + agent + title + inspector),
       so the global titlebar only shows on desktop and on the mobile Sessions screen. -->
  {#if !(isMobile && hasSession)}
    <Titlebar
      {email}
      onPalette={() => paletteOpen.set(true)}
      {installEvent}
      onInstall={install}
      {drawerLeft}
      drawerRight={$inspectorOpen}
      onToggleLeft={toggleLeft}
      onToggleRight={toggleRight}
      bind:newButtonAnchor
    />
  {/if}
  <OfflineBanner />
  <div class="body">
    {#if drawerLeft || $inspectorOpen}
      <button class="backdrop" aria-label="Close" on:click={closeDrawers}></button>
    {/if}
    {#if !$leftPanelOpen && !isMobile}
      <!-- Collapsed-rail strip: the restore affordance is a permanent fixture
           at the screen edge (VS Code activity-bar register), not a hidden
           chevron — "collapsed" must never mean "lost" (user report). -->
      <button class="rail-strip" on:click={() => leftPanelOpen.set(true)} title="展开会话栏 (⌘B)" aria-label="展开会话栏">
        <svg class="strip-mark" viewBox="0 0 64 64" fill="none" stroke-width="8" stroke-linecap="round" aria-hidden="true">
          <path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)"/>
          <circle cx="49" cy="20" r="6" fill="var(--accent)" stroke="none"/>
        </svg>
        <svg class="strip-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    {/if}
    <div class="rail-wrap" class:collapsed={!$leftPanelOpen && !isMobile} class:open={drawerLeft || (isMobile && !hasSession)}>
      <AgentPanel activeId={$page.params.sessionId} drawer={isMobile} {email} />
    </div>
    <div
      class="divider"
      class:resizing={resizing === 'rail'}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会话栏宽度（双击收起/展开）"
      on:pointerdown={(e) => startResize('rail', e)}
      on:dblclick={() => leftPanelOpen.update((v) => !v)}
    ></div>
    <main><slot /></main>
    {#if $sidePane.tabs.length > 0}
      <div
        class="divider"
        class:resizing={resizing === 'insp'}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整检查器宽度"
        on:pointerdown={(e) => startResize('insp', e)}
      ></div>
    {/if}
    <div class="inspector-wrap" class:open={$inspectorOpen}>
      <Inspector sessionId={$page.params.sessionId} />
    </div>
  </div>
</div>
<CommandPalette open={$paletteOpen} on:close={() => paletteOpen.set(false)} />
<PlusMenu anchor={newButtonAnchor} />
<NewSessionModal />
<ChannelsModal />
{#if !hasSession}<MobileFab />{/if}
{#if $auth !== 'ready'}<PairGate status={$auth === 'rejected' ? 'rejected' : 'pairing'} />{/if}

<style>
  /* position:fixed + JS visualViewport sizing pins the app to the visible area,
     keeping the composer above the iOS keyboard. Inline height/transform from JS
     win; the 100dvh here is the no-visualViewport fallback. */
  /* height:100vh ONLY — NOT 100dvh. On iOS standalone PWAs 100dvh is mis-sized on
     cold start (reports the screen MINUS the safe areas → a dark strip below the
     app), whereas 100vh fills the true screen and lets viewport-fit=cover give
     real env(safe-area-inset-*) values. JS overrides height only when the
     keyboard is open. */
  .app { position: fixed; top: 0; left: 0; right: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg); }
  .body { display: flex; flex: 1; overflow: hidden; position: relative; }
  /* Content canvas: the chat pane is the near-white sheet (MiMo structure) —
     the warm --bg stays as the frame (rails/titlebar). Rounded top corners so
     the sheet reads as a surface over the frame. */
  main {
    position: relative; flex: 1; overflow: hidden;
    display: flex; flex-direction: column; min-width: 0;
    background: var(--bg-canvas, var(--bg));
    border-radius: var(--radius) var(--radius) 0 0;
  }
  /* Drawer wrappers hold the left panel on desktop and become off-canvas drawers on mobile. */
  .rail-wrap {
    display: block;
    width: var(--rail-w, 250px);
    flex-shrink: 0;
    overflow: hidden;
    /* Slide on the GPU (transform) instead of animating width — a width
       transition reflows the chat on every frame. The negative margin hands
       the rail's flex space to <main> instantly while the rail slides out. */
    position: relative;
    z-index: 1;
    transition: transform .22s ease;
  }
  .rail-wrap.collapsed {
    transform: translateX(-100%);
    margin-right: calc(-1 * var(--rail-w, 250px));
    /* The strip pushes the rail's origin right by 44px, so the translated-out
       box still covers the strip's zone — without this, the invisible rail
       swallows the strip's clicks (found by the click-through test). */
    pointer-events: none;
  }
  .inspector-wrap { display: contents; }
  /* Collapsed-rail strip — the always-present restore handle at the screen's
     left edge. Mobile hides it (drawers have their own toggles). */
  .rail-strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 44px;
    flex-shrink: 0;
    padding: 14px 0 10px;
    background: var(--bg-panel);
    border: none;
    border-right: 1px solid var(--border-2);
    color: var(--text-3);
    cursor: pointer;
    transition: color .12s ease, background .12s ease;
  }
  .rail-strip:hover { color: var(--text); background: var(--bg-elev2); }
  .rail-strip .strip-mark { width: 22px; height: 22px; flex-shrink: 0; }
  .rail-strip .strip-caret { width: 14px; height: 14px; }
  .divider {
    width: 6px;
    flex-shrink: 0;
    margin: 0 -3px;
    z-index: 5;
    cursor: col-resize;
    background: transparent;
    transition: background .15s ease;
  }
  .divider:hover, .divider.resizing { background: color-mix(in srgb, var(--accent) 35%, transparent); }
  .backdrop { display: none; }

  @media (max-width: 820px) {
    /* v2 dual-screen: the agent panel is a FULL-SCREEN Sessions screen, shown when
       there's no active session (or ☰), and slid away to reveal the Chat screen. */
    .rail-wrap {
      display: block;
      position: absolute; top: 0; bottom: 0; left: 0; z-index: var(--z-drawer);
      width: 100%;
      overflow: hidden;
      margin-right: 0;
      transition: transform .24s var(--ease, ease);
      transform: translateX(-100%);
    }
    .rail-wrap.open { transform: translateX(0); }

    /* Inspector = bottom sheet (rises over a scrim) per v2 mobile. Lifted by
       --kb so in-browser toolbars don't cover its bottom rows. */
    .inspector-wrap {
      display: block;
      position: absolute; left: 0; right: 0; bottom: var(--kb, 0px); top: auto; z-index: var(--z-sheet);
      width: 100%; height: min(82vh, 580px);
      overflow: hidden;
      transition: transform .24s ease;
      /* Hidden = fully below the visible bottom, INCLUDING the --kb toolbar lift. */
      transform: translateY(calc(100% + var(--kb, 0px)));
      border-radius: var(--radius) var(--radius) 0 0;
      box-shadow: 0 -10px 44px rgba(0,0,0,.55);
    }
    .inspector-wrap.open { transform: translateY(0); }

    .rail-wrap :global(.agent-panel), .rail-wrap :global(.panel) { width: 100%; }
    .rail-strip { display: none; }
    .inspector-wrap :global(.inspector) { width: 100%; height: 100%; }
    /* MUST sit below the rail (--z-drawer) AND the inspector sheet (--z-sheet)
       so taps on an open drawer hit the drawer, not the backdrop. It only dims
       the content behind. */
    .backdrop {
      display: block; position: absolute; inset: 0; z-index: var(--z-backdrop);
      background: var(--scrim); border: none; padding: 0; cursor: default;
      animation: fade .18s ease;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  }
</style>
