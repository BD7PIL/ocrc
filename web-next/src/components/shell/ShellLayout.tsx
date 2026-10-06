// components/shell/ShellLayout.tsx — the three-pane shell (ZCode
// WorkspaceShellLayout register): left rail (resizable, collapses fully away
// per the ocrc fix#2 ruling — no residual gutter), center column with
// sub-header, right pane container (tabs arrive in M3).
import { useRef } from 'react'
import { Outlet } from 'react-router'
import { PanelRight, SlidingPanelLeftHandle } from './icons.tsx'
import { Sidebar } from './Sidebar.js'
import { SidePane } from '../pane/SidePane.js'
import { useUi } from '../../lib/stores/ui.js'
import { useSessions } from '../../lib/stores/sessions.js'

export function ShellLayout() {
  const { leftPanelOpen, leftWidth, setLeftWidth, toggleLeftPanel, toggleInspector, inspectorOpen, activeSessionId } = useUi()
  const list = useSessions((s) => s.list)
  const active = list.find((s) => s.id === activeSessionId)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onDragStart = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startW: leftWidth }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    setLeftWidth(dragRef.current.startW + (e.clientX - dragRef.current.startX))
  }
  const onDragEnd = () => { dragRef.current = null }

  return (
    <div className="flex h-full overflow-hidden">
      {/* left rail — kept mounted so collapse animates (translate + negative
          margin, zero residual footprint); pointer-events none while hidden */}
      <aside
        className="relative h-full shrink-0 overflow-hidden"
        style={{
          width: leftWidth,
          marginLeft: leftPanelOpen ? 0 : -leftWidth,
          transition: 'margin-left var(--dur-2) var(--ease-out)',
          borderRight: '1px solid var(--border)',
          pointerEvents: leftPanelOpen ? 'auto' : 'none',
        }}
        aria-hidden={!leftPanelOpen}
      >
        <div className="h-full" style={{ width: leftWidth }}>
          <Sidebar />
        </div>
        {/* resize handle */}
        <div
          className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-[var(--accent)]"
          style={{ opacity: 0.001 }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          role="separator"
          aria-orientation="vertical"
        />
      </aside>

      {/* center column */}
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <header
          className="flex h-11 shrink-0 items-center gap-2 border-b px-3"
          style={{ background: 'var(--bg-panel)', borderColor: 'var(--border)' }}
        >
          {!leftPanelOpen && (
            <button
              type="button"
              className="rounded-md p-1.5"
              style={{ color: 'var(--text-3)' }}
              title="展开左栏 (Ctrl+B)"
              onClick={toggleLeftPanel}
            >
              <SlidingPanelLeftHandle />
            </button>
          )}
          <span className="min-w-0 truncate" style={{ fontSize: 'var(--ui-base)', color: 'var(--text)' }}>
            {active?.title || 'ocrc'}
          </span>
          {active?.directory && (
            <span className="mono hidden truncate md:inline" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>
              {active.directory}
            </span>
          )}
          <button
            type="button"
            className="ml-auto rounded-md p-1.5"
            style={{ color: inspectorOpen ? 'var(--accent)' : 'var(--text-3)' }}
            aria-pressed={inspectorOpen}
            title="右栏面板（M3）"
            onClick={toggleInspector}
          >
            <PanelRight />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      {/* right pane container — populated by the M3 SidePane tab family */}
      {inspectorOpen && (
        <aside
          className="h-full w-[40%] min-w-[320px] shrink-0 border-l"
          style={{ background: 'var(--bg-panel)', borderColor: 'var(--border)' }}
        >
          <SidePane />
        </aside>
      )}
    </div>
  )
}
