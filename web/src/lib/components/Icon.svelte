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
