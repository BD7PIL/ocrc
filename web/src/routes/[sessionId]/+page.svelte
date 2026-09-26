<script lang="ts">
  import { page } from '$app/stores'
  import { goto } from '$app/navigation'
  import { tick, onMount, onDestroy } from 'svelte'
  import { feeds, cardsOf, sessionList } from '$lib/stores/sessions.js'
  import { leftPanelOpen, inspectorOpen, composerDraft, composerEmpty } from '$lib/stores/ui.js'
  import Suggestions from '$lib/components/Suggestions.svelte'
  import { api } from '$lib/api/client.js'
  import Card from '$lib/components/Card.svelte'
  import Composer from '$lib/components/Composer.svelte'
  import SessionSwitcher from '$lib/components/SessionSwitcher.svelte'
  import PlanHud from '$lib/components/PlanHud.svelte'

  let scrollEl: HTMLDivElement
  let composerEl: HTMLElement
  let lastSeen = ''
  let ro: ResizeObserver | undefined
  let vvCleanup: (() => void) | undefined
  let aborting = false
  // Running-timer state for the busy pill.
  let runStart = 0
  let runElapsed = 0
  let runTimer: ReturnType<typeof setInterval> | undefined
  // Whether the chat is scrolled to the bottom — gates the re-pin so the keyboard
  // opening/closing doesn't yank the view down while the user has scrolled up.
  let pinnedToBottom = true

  function pinBottom() {
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
  }
  function onChatScroll() {
    if (scrollEl) pinnedToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80
  }

  $: sessionId = $page.params.sessionId ?? ''
  $: feed = $feeds[sessionId]
  $: cards = cardsOf(feed)
  $: session = $sessionList.find((s) => s.id === sessionId)
  $: branch = session?.directory ? session.directory.replace(/\/+$/, '').split('/').pop() || '' : ''
  $: busy = (() => {
    if (!feed || feed.order.length === 0) return false
    const last = feed.byId[feed.order[feed.order.length - 1]]
    return last?.kind === 'thinking' || last?.kind === 'streaming' || last?.kind === 'think-stream'
  })()

  // Session the running-timer currently belongs to — jumping directly from one
  // busy session to another must restart the clock instead of keeping A's start.
  let runSession = ''

  $: if (busy) {
    if (runSession !== sessionId) {
      runSession = sessionId
      runStart = 0
    }
    if (!runStart && typeof window !== 'undefined') {
      runStart = Date.now()
      runElapsed = 0
      if (runTimer) clearInterval(runTimer)
      runTimer = setInterval(() => { runElapsed = Math.floor((Date.now() - runStart) / 1000) }, 1000)
    }
  } else {
    runStart = 0
    runElapsed = 0
    runSession = ''
    if (runTimer) { clearInterval(runTimer); runTimer = undefined }
  }

  function fmtRunTime(s: number): string {
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const r = s % 60
    return r === 0 ? `${m}m` : `${m}m ${r}s`
  }

  // ── Regenerate (C1) + suggestion chips (C2) ──
  $: lastCard = cards.length ? cards[cards.length - 1] : null
  function regenerateLast() {
    // opencode has no native regenerate — the honest minimal semantics is
    // re-sending the last user message as a fresh turn.
    retryLast()
  }

  const STARTERS = ['Summarize this project', 'What changed recently?', 'Run the checks']
  let chipsDismissed = false
  // Tier2 (model-generated) suggestions — fetched once per finished turn.
  let tier2: string[] = []
  let fetchedFor: string | undefined
  $: if (!busy && lastCard?.kind === 'assistant' && sessionId) fetchSuggestions(sessionId, lastCard.id)
  async function fetchSuggestions(sid: string, cid: string) {
    if (fetchedFor === cid) return
    fetchedFor = cid
    try {
      const r = await api.suggestions(sid)
      tier2 = r.suggestions ?? []
    } catch { tier2 = [] }
  }
  // dismissed-chips state is per session — switching sessions re-arms it
  let chipsForSid: string | undefined
  $: if (sessionId !== chipsForSid) { chipsForSid = sessionId; chipsDismissed = false }
  let suggestions: string[] = []
  $: {
    const chipGate = busy || chipsDismissed || !$composerEmpty
    if (chipGate) suggestions = []
    else if (tier2.length > 0) suggestions = tier2
    else if (cards.length === 0) suggestions = STARTERS
    else suggestions = []
  }

  function retryLast() {
    if (!sessionId) return
    const lastUser = [...cards].reverse().find((c) => c.kind === 'user')
    const text = (lastUser as any)?.text
    if (!text) return
    void api.sendMessage({ sessionId, text, clientId: `web_${Date.now()}` })
  }

  async function abort() {
    if (!sessionId || aborting) return
    aborting = true
    try { await api.abort(sessionId) } catch { /* ignore */ }
    finally { aborting = false }
  }

  // lastSeq increments on every card (including streaming upserts), so this
  // scrolls during streaming too — not only when the card count changes.
  $: scrollKey = `${sessionId}:${feed?.lastSeq ?? 0}:${cards.length}`
  $: if (scrollKey !== lastSeen) {
    lastSeen = scrollKey
    // Only re-pin if the user was already at the bottom — streaming deltas
    // must not yank the view down while they're scrolled up reading.
    tick().then(() => { if (pinnedToBottom) pinBottom() })
  }

  // The composer floats over the chat (mobile), so the chat reserves its height
  // (--composer-h) plus the keyboard inset (--kb) as bottom padding — otherwise
  // the latest messages sit hidden behind the box / keyboard.
  onMount(() => {
    ro = new ResizeObserver(() => {
      if (composerEl) {
        document.documentElement.style.setProperty('--composer-h', `${composerEl.offsetHeight}px`)
        if (pinnedToBottom) pinBottom() // keep latest pinned as the box grows
      }
    })
    if (composerEl) ro.observe(composerEl)

    // The keyboard/toolbar shifts the composer via --kb; re-pin the latest message
    // above it (only when already at the bottom, so scroll-up isn't fought).
    const vv = window.visualViewport
    const onVV = () => { if (pinnedToBottom) requestAnimationFrame(pinBottom) }
    vv?.addEventListener('resize', onVV)
    vvCleanup = () => vv?.removeEventListener('resize', onVV)
  })
  onDestroy(() => { ro?.disconnect(); vvCleanup?.(); if (runTimer) clearInterval(runTimer) })
</script>

<div class="chat" bind:this={scrollEl} on:scroll={onChatScroll}>
  <div class="sub-header">
    <div class="left">
      <!-- Mobile: back to the Sessions screen (dual-screen nav). -->
      <button class="back" on:click={() => goto('/')} aria-label="Back to sessions">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      {#if !$leftPanelOpen}
        <button class="expand" title="Expand left panel" aria-label="Expand left panel" on:click={() => leftPanelOpen.set(true)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      {/if}
      <SessionSwitcher activeId={sessionId} />
      {#if branch}<span class="branch mono">{branch}</span>{/if}
    </div>
    <div class="right">
      {#if busy}
        <span class="pill running mono">
          <span class="dot" aria-hidden="true"></span>
          running {fmtRunTime(runElapsed)}
        </span>
        <button class="abort" on:click={abort} disabled={aborting}>Abort</button>
      {:else}
        <span class="idle mono">idle</span>
      {/if}
      <!-- Mobile: open the inspector bottom sheet. -->
      <button class="inspect" on:click={() => inspectorOpen.update((v) => !v)} aria-label="Inspector">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>
      </button>
    </div>
  </div>
  <div class="stream conversation-emerald" aria-live="polite">
    {#each cards as card (card.id)}
      <Card
        {card}
        onRetry={retryLast}
        onRegenerate={card.id === lastCard?.id && card.kind === 'assistant' && !busy ? regenerateLast : undefined}
      />
    {/each}
    {#if cards.length === 0}
      <div class="empty">
        <svg class="empty-mark" viewBox="0 0 64 64" fill="none" stroke-width="8" stroke-linecap="round" aria-hidden="true">
          <path d="M46 15 A24 24 0 1 0 54 32" stroke="var(--text)" opacity=".85"/>
          <circle cx="49" cy="20" r="6" fill="var(--accent)" stroke="none"/>
        </svg>
        <p class="empty-title">What should the agent do?</p>
        <p class="empty-hint">Describe the task below — it runs in this project's directory. Attach an image if useful.</p>
      </div>
    {/if}
  </div>
</div>

{#if !pinnedToBottom && cards.length > 0}
  <button class="jump" on:click={pinBottom} aria-label="Jump to latest">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
    latest
  </button>
{/if}

<div class="composer-float" bind:this={composerEl}>
  <Suggestions
    {suggestions}
    onPick={(text) => composerDraft.set({ text, nonce: Date.now() })}
    onDismiss={() => { chipsDismissed = true; suggestions = [] }}
  />
  <Composer {sessionId} />
</div>

<!-- ZCode-mobile-style floating plan card — mobile only (inside the component). -->
<PlanHud {sessionId} />

<style>
  .jump {
    position: absolute;
    bottom: calc(var(--composer-h, 120px) + 14px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-sticky);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 13px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
    box-shadow: var(--shadow-card);
  }
  .jump:hover { color: var(--text); border-color: var(--text-4); }

  .chat {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  /* Mobile: instead of a frosted panel behind the input, fade the chat content to
     low-brightness as it scrolls down into the composer zone — text "passes under"
     the input and dims out. Pure mask, no blur/panel. The opaque region ends a bit
     above the composer top so the latest message stays fully bright. */
  @media (max-width: 820px) {
    .chat {
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - var(--kb, 0px) - var(--composer-h, 120px)), rgba(0,0,0,0.12) calc(100% - var(--kb, 0px)));
      mask-image: linear-gradient(to bottom, #000 calc(100% - var(--kb, 0px) - var(--composer-h, 120px)), rgba(0,0,0,0.12) calc(100% - var(--kb, 0px)));
    }
  }

  .sub-header {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 11px max(24px, calc((100% - 780px) / 2 + 24px));
    background: var(--bg);
    border-bottom: 1px solid var(--border-2);
  }
  .sub-header .left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .expand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: transparent;
    border: 1px solid var(--border-2);
    border-radius: var(--radius-pill);
    color: var(--text-3);
    cursor: pointer;
    flex-shrink: 0;
    transition: color .12s ease, border-color .12s ease, background .12s ease;
  }
  .expand:hover { color: var(--text); border-color: var(--accent); background: var(--accent-2); }
  /* Back + inspector buttons are mobile-only (the chat screen's own header). */
  .back, .inspect { display: none; }
  @media (max-width: 820px) {
    .expand { display: none; }
    .back, .inspect {
      display: inline-flex; align-items: center; justify-content: center;
      width: 44px; height: 44px; flex-shrink: 0;
      background: var(--bg-elev); border: 1px solid var(--border);
      border-radius: var(--radius-pill); color: var(--text-2); cursor: pointer;
    }
    .back:active, .inspect:active { background: var(--bg-elev2); }
  }
  .sub-header .branch {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--hl-purple);
    background: var(--bg-elev);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-pill);
    padding: 2px 8px;
  }
  .sub-header .right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: var(--radius-pill);
    background: var(--accent-2);
    color: var(--accent);
    font-size: 11px;
  }
  .pill .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: ocrc-pulse 1.2s ease-in-out infinite;
  }
  .idle {
    font-size: 11px;
    color: var(--text-3);
  }
  .abort {
    background: transparent;
    border: 1px solid var(--border-2);
    color: var(--text-3);
    border-radius: var(--radius-pill);
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: color .15s ease, border-color .15s ease;
  }
  .abort:hover { color: var(--err); border-color: var(--err); }
  .abort:disabled { opacity: .5; cursor: default; }

  .stream {
    max-width: 720px;
    margin: 0 auto;
    padding: 22px 24px 8px;
    display: flex;
    flex-direction: column;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
    padding: 18vh 24px 40px;
    color: var(--text-3);
    font-size: 14px;
  }
  .empty-mark {
    width: 40px;
    height: 40px;
    margin-bottom: 6px;
  }
  .empty-title {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 19px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: .01em;
  }
  .empty-hint {
    margin: 0;
    max-width: 420px;
    line-height: 1.6;
    font-size: 12.5px;
  }

  /* Desktop: composer is a normal in-flow bar at the bottom (unchanged). */
  /* Mobile: the input box just floats (its original form, Composer.svelte); no
     frosted panel. The dim effect comes from the .chat fade mask above. */
  @media (max-width: 820px) {
    .composer-float {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      /* Above the plan orb/card (--z-hud 8): this element is the stacking
         context for the chip popovers, so its z decides who paints on top. */
      z-index: var(--z-dropdown);
      background: transparent;
      /* (B) Follow the keyboard/toolbar by translating up --kb on the GPU — no app
         resize, no reflow. The transition makes the snap-back (and open) glide. */
      transform: translateY(calc(-1 * var(--kb, 0px)));
      transition: transform .25s ease-out;
      will-change: transform;
    }
    .composer-float :global(.composer) { background: transparent; }
    /* Reserve the floating composer's height + keyboard inset so the latest
       message clears it (otherwise it's hidden behind the box / keyboard). */
    .stream { padding: 14px 12px calc(var(--composer-h, 120px) + var(--kb, 0px) + 8px); }
    /* The titlebar is hidden on the mobile chat screen, so this header is now the top
       bar — clear the status bar / notch via the top safe-area inset. */
    .sub-header { padding: calc(10px + env(safe-area-inset-top, 0px)) 12px 10px; }
  }
</style>
