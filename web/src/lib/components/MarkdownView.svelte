<script lang="ts">
  import { onDestroy } from 'svelte'
  import { renderMarkdown, setStreamHighlight } from '../markdown/sanitize.js'

  export let src: string
  /** Streaming cards set this so re-parses coalesce to one per animation frame. */
  export let throttle = false
  /** Show a blinking caret at the end of the final paragraph. */
  export let streaming = false

  let html = ''
  let lastApplied: string | undefined
  let raf = 0
  let pending = ''

  function langOf(codeEl: HTMLElement): string {
    const cls = Array.from(codeEl.classList).find((c) => c.startsWith('language-'))
    return cls ? cls.slice(9) : ''
  }

  function transformCodeBlocks(markup: string): string {
    if (typeof document === 'undefined') return markup
    const wrap = document.createElement('div')
    wrap.innerHTML = markup
    const blocks = Array.from(wrap.querySelectorAll('pre > code')) as HTMLElement[]
    blocks.forEach((code) => {
      const pre = code.parentElement
      if (!pre) return
      const lang = langOf(code)
      const block = document.createElement('div')
      block.className = 'code-block'
      const header = document.createElement('div')
      header.className = 'code-header'
      const square = document.createElement('span')
      square.className = 'code-square'
      square.setAttribute('aria-hidden', 'true')
      const tag = document.createElement('span')
      tag.className = 'code-lang mono'
      tag.textContent = lang
      header.appendChild(square)
      header.appendChild(tag)
      // Copy affordance lives in the header; the click is handled by delegation
      // on the .md wrapper (the markup is injected via {@html}).
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'code-copy mono'
      copy.textContent = 'Copy'
      header.appendChild(copy)
      block.appendChild(header)
      pre.parentNode?.insertBefore(block, pre)
      block.appendChild(pre)
    })
    return wrap.innerHTML
  }

  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  function onMdClick(e: MouseEvent) {
    const btn = (e.target as HTMLElement).closest?.('.code-copy') as HTMLElement | null
    if (!btn) return
    const code = btn.closest('.code-block')?.querySelector('pre code, pre')
    if (!code) return
    navigator.clipboard
      ?.writeText((code as HTMLElement).innerText)
      .then(() => {
        // Inline confirmation state (baseline: copy without feedback is invisible)
        btn.classList.add('copied')
        btn.textContent = '✓ Copied'
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => {
          btn.classList.remove('copied')
          btn.textContent = 'Copy'
        }, 1400)
      })
      .catch(() => {})
  }

  function insertStreamingCaret(wrap: HTMLElement) {
    const caret = document.createElement('span')
    caret.className = 'stream-caret'
    caret.setAttribute('aria-hidden', 'true')
    const paragraphs = Array.from(wrap.querySelectorAll('p'))
    if (paragraphs.length > 0) {
      const last = paragraphs[paragraphs.length - 1]
      last.appendChild(caret)
    } else {
      wrap.appendChild(caret)
    }
  }

  function apply(text: string) {
    if (text === lastApplied) return // memoize — skip re-parse of unchanged text
    lastApplied = text
    // Streaming renders skip auto-highlight (the per-tick CPU sink); the final
    // non-streaming pass always renders with full highlighting.
    setStreamHighlight(streaming)
    let rendered = renderMarkdown(text)
    rendered = transformCodeBlocks(rendered)
    if (streaming && typeof document !== 'undefined') {
      const wrap = document.createElement('div')
      wrap.innerHTML = rendered
      insertStreamingCaret(wrap)
      rendered = wrap.innerHTML
    }
    html = rendered
  }

  // Streaming parses are throttled to one per gap ms (a time window, not
  // every animation frame — long outputs re-tokenize on each parse, and 60fps
  // reparsing starves low-end phones). The gap SCALES with text length: a
  // 200KB stream re-tokenizes O(n) per parse, so 45ms would spend most of the
  // CPU budget on markdown. The final render is immediate.
  let lastParsedAt = 0
  let gapTimer: ReturnType<typeof setTimeout> | undefined
  const parseGap = (text: string) => (text.length > 100_000 ? 250 : text.length > 40_000 ? 120 : 45)

  function schedule(text: string) {
    if (!throttle || typeof requestAnimationFrame === 'undefined') {
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = undefined }
      setStreamHighlight(streaming)
      apply(text)
      return
    }
    pending = text
    if (raf || gapTimer) return
    const wait = Math.max(0, parseGap(text) - (Date.now() - lastParsedAt))
    if (wait === 0) {
      raf = requestAnimationFrame(() => { raf = 0; lastParsedAt = Date.now(); apply(pending) })
    } else {
      gapTimer = setTimeout(() => {
        gapTimer = undefined
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; lastParsedAt = Date.now(); apply(pending) })
      }, wait)
    }
  }

  $: schedule(src)

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf)
    if (copiedTimer) clearTimeout(copiedTimer)
  })
</script>

<!-- presentation: the click is pure event delegation for the injected Copy
     buttons (real <button>s below — natively keyboard-operable); the wrapper
     itself carries no semantics. -->
<div class="md" class:streaming role="presentation" on:click={onMdClick}>{@html html}</div>

<style>
  .md {
    font-family: var(--font-sans);
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.65;
    word-break: break-word;
  }
  .md :global(p) { margin: 0.55em 0; }
  .md :global(p:first-child) { margin-top: 0; }
  .md :global(p:last-child) { margin-bottom: 0; }

  .md :global(.code-block) {
    background: var(--bg-code);
    border: 1px solid var(--border-2);
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin: 0.7em 0;
  }
  .md :global(.code-header) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 11px;
    background: rgba(255,255,255,.025);
    border-bottom: 1px solid var(--border-2);
  }
  .md :global(.code-square) {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-bar);
    background: var(--hl-cyan);
  }
  .md :global(.code-lang) {
    font-size: 11px;
    color: var(--hl-cyan);
    text-transform: lowercase;
  }
  .md :global(.code-copy) {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-3);
    font-size: 10.5px;
    padding: 2px 8px;
    cursor: pointer;
    transition: color .12s var(--ease, ease), border-color .12s var(--ease, ease);
  }
  .md :global(.code-copy:hover) { color: var(--text); border-color: var(--text-4); }
  .md :global(.code-copy.copied) { color: var(--ok); border-color: var(--ok); }
  .md :global(pre) {
    background: var(--bg-code);
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
    color: var(--text);
  }
  .md :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--bg-input);
    padding: 0.1em 0.3em;
    border-radius: var(--radius-xs);
    color: var(--hl-green);
  }
  .md :global(a) { color: var(--accent); }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) {
    margin: 0.75em 0 0.4em;
    color: var(--text);
    font-weight: 600;
  }
  .md :global(ul), .md :global(ol) {
    padding-left: 1.35em;
    margin: 0.5em 0;
  }
  .md :global(ul) { list-style: none; }
  .md :global(ul li) {
    position: relative;
    margin: 0.25em 0;
  }
  .md :global(ul li::before) {
    content: '▪';
    position: absolute;
    left: -1.1em;
    color: var(--accent);
    font-size: 0.85em;
  }
  .md :global(.raw) { color: var(--text-2); }

  .md :global(.stream-caret) {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: var(--accent);
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: ocrc-blink 1s step-end infinite;
  }

  /* GFM tables — marked emits real <table>; style it to match the TUI. */
  .md :global(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    border-collapse: collapse;
    margin: 0.6em 0;
    font-size: 13px;
    line-height: 1.5;
  }
  .md :global(th), .md :global(td) {
    border: 1px solid var(--border);
    padding: 5px 10px;
    text-align: left;
    vertical-align: top;
  }
  .md :global(thead th), .md :global(table tr:first-child th) {
    background: var(--bg-elev);
    color: var(--text);
    font-weight: 600;
  }
  .md :global(tbody tr:nth-child(even) td) { background: var(--bg-input); }
</style>
