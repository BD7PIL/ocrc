<!-- Icon — single stroke-icon suite (B5 icon convergence).
     1.5px round-cap strokes on the 24-grid, inheriting currentColor so icons
     follow the theme and any per-agent accent like every other control. -->
<script lang="ts">
  const PATHS: Record<string, string> = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    'caret-down': '<path d="M6 9l6 6 6-6"/>',
    'caret-right': '<path d="M9 6l6 6-6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    refresh: '<path d="M20.5 15a9 9 0 1 1-2.2-9.5L21 8"/><path d="M21 3v5h-5"/>',
    alert: '<path d="M12 3l10 17H2L12 3z"/><path d="M12 10v4"/><path d="M12 17.6v.4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2 12h3M19 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
    bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
    // side-pane tab kinds (ZCode SidePaneTabIcon register)
    tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    files: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="12" cy="4" r="2"/><path d="M9 14h.01M15 14h.01"/><path d="M9 17h6"/>',
    skill: '<path d="M12 2l2.4 6.2L21 9l-5 4.4L17.5 21 12 17.6 6.5 21 8 13.4 3 9l6.6-.8z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .9-8.9A7 7 0 0 0 5 12.5 4 4 0 0 0 6.5 19z"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.5 6H14a4 4 0 0 1 4 4v0"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    terminal: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    tool: '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6l-2.8 2.8-2.2-2.2z"/>',
  }

  export let name = ''
  export let size = 16
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>{@html PATHS[name] ?? ''}</svg>
