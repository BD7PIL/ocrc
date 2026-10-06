// components/shell/icons.tsx — tiny inline SVGs for the shell pieces that
// lucide doesn't model exactly (panel toggles). 16px grid, 1.2 stroke — the
// lucide register.
export function PanelRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export function SlidingPanelLeftHandle() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M9.5 8h3.5M11.2 6.2 13 8l-1.8 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
