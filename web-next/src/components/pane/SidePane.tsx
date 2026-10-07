// components/pane/SidePane.tsx — the right pane (ZCode SidePaneTabTrigger +
// workspaceSidePane register): nothing permanently resident, every tab
// closable, idempotent ids, "+" menu reopens homes, drag reorders, empty
// state is a launcher. Tab strip: 28px, flex 1_1_156px shrinking to 60px,
// active = filled 10% ink block (never an underline), ✕ hover-revealed,
// title mask-fade.
import { useRef, useState, useMemo } from 'react'
import { Plus, X } from 'lucide-react'
import {
  useSidePane, openPaneTab, openHome, closePaneTab, activatePane, reorderPaneTab,
  HOMES, type PaneTab,
} from '$lib/stores/sidePane.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { useUi } from '../../lib/stores/ui.js'
import { TasksPanel, SubsPanel, SchedulesPanel, McpPanel, SkillsPanel } from './panels.js'
import { FileBrowse, FileViewer, GitPanel, ToolOutput, SubagentTranscript } from './deep.js'
import { BrowserPanel } from './BrowserPanel.js'

export function SidePane() {
  const { tabs, activeId } = useSidePane()
  const [plusOpen, setPlusOpen] = useState(false)
  const dragFrom = useRef<number | null>(null)
  const active = tabs.find((t) => t.id === activeId)

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg-panel)', containerType: 'inline-size' }}>
      {/* tab strip */}
      <div className="pane-tabs flex h-7 shrink-0 items-stretch gap-px overflow-x-auto px-1 pt-1" style={{ scrollbarWidth: 'none' }}>
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className="flex min-w-0"
            style={{ flex: '1 1 156px' }}
            draggable
            onDragStart={() => { dragFrom.current = i }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom.current !== null) reorderPaneTab(dragFrom.current, i); dragFrom.current = null }}
          >
            <TabTrigger tab={t} active={t.id === activeId} onActivate={() => activatePane(t.id)} onClose={() => closePaneTab(t.id)} />
          </div>
        ))}
        <div className="relative flex shrink-0 items-center">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-[6px]"
            style={{ color: 'var(--text-3)' }}
            title="打开面板"
            onClick={() => setPlusOpen((v) => !v)}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
          {plusOpen && (
            <div
              className="absolute right-0 top-7 z-[var(--z-popover)] w-44 rounded-[9px] p-1 ocrc-pop"
              style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--elev-panel)' }}
            >
              {HOMES.map((h) => (
                <button
                  key={h.homeId}
                  type="button"
                  className="flex w-full items-center rounded-[6px] px-2.5 py-1.5 text-left transition-colors"
                  style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}
                  onClick={() => { openHome(h.homeId); setPlusOpen(false) }}
                >
                  {h.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {active ? <PaneContent tab={active} /> : <Launcher />}
      </div>
    </div>
  )
}

function TabTrigger({ tab, active, onActivate, onClose }: { tab: PaneTab; active: boolean; onActivate: () => void; onClose: () => void }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter') onActivate() }}
      className="pane-tab group relative flex min-w-[60px] cursor-pointer items-center overflow-hidden"
      style={{
        background: active ? 'color-mix(in srgb, var(--text) 10%, transparent)' : 'transparent',
        borderRadius: '6px 6px 0 0',
      }}
    >
      <span className="pane-tab-title min-w-0 flex-1 px-2.5" style={{ fontSize: 'var(--ui-xs)', color: active ? 'var(--text)' : 'var(--text-3)' }}>
        {tab.title}
      </span>
      <button
        type="button"
        aria-label="关闭页签"
        className="pane-tab-x absolute right-1 flex h-4 w-4 items-center justify-center rounded-[4px]"
        style={{ color: 'var(--text-3)', opacity: 0, pointerEvents: 'none' }}
        onClick={(e) => { e.stopPropagation(); onClose() }}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  )
}

function PaneContent({ tab }: { tab: PaneTab }) {
  const activeSessionId = useUi((s) => s.activeSessionId)

  if (tab.kind === 'home') {
    switch (tab.homeId) {
      case 'tasks': return activeSessionId ? <TasksPanel sessionId={activeSessionId} /> : <SessionGate what="任务" />
      case 'subs': return activeSessionId ? <SubsPanel sessionId={activeSessionId} /> : <SessionGate what="子代理" />
      case 'schedules': return <SchedulesPanel />
      case 'mcp': return <McpPanel />
      case 'skills': return <SkillsPanel />
      case 'files': return activeSessionId ? <FilesHome sessionId={activeSessionId} /> : <SessionGate what="文件" />
      case 'browser': return <BrowserPanel />
      default: return null
    }
  }

  switch (tab.kind) {
    case 'file': return <FileViewer sessionId={activeSessionId ?? ''} directory={tab.directory} path={tab.path} />
    case 'tool': return <ToolOutput sessionId={tab.sessionId} messageId={tab.messageId} partId={tab.partId} />
    case 'subagent': return <SubagentTranscript childId={tab.childId} />
    case 'git': return activeSessionId ? <GitPanel sessionId={activeSessionId} /> : <SessionGate what="Git" />
    default: return null
  }
}

function SessionGate({ what }: { what: string }) {
  return (
    <p className="p-4 text-center" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
      {what}面板跟随当前会话——先在左栏选择一个会话
    </p>
  )
}

/** Files home: browse the ACTIVE session's directory; clicking a file opens
 *  a viewer tab (idempotent per path). */
function FilesHome({ sessionId }: { sessionId: string }) {
  const list = useSessions((s) => s.list)
  const directory = useMemo(() => list.find((x) => x.id === sessionId)?.directory, [list, sessionId])
  return (
    <FileBrowse
      sessionId={sessionId}
      directory={directory}
      onOpenFile={(path) => {
        if (directory) openPaneTab({ id: `file:${path}`, kind: 'file', title: path.split('/').pop() ?? path, path, directory })
      }}
    />
  )
}

function Launcher() {
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      {HOMES.map((h) => (
        <button
          key={h.homeId}
          type="button"
          className="rounded-[9px] px-3 py-4 text-left transition-colors"
          style={{ background: 'var(--bg-elev)', border: '1px solid var(--border-2)', color: 'var(--text-2)', fontSize: 'var(--ui-sm)' }}
          onClick={() => openHome(h.homeId)}
        >
          {h.title}
        </button>
      ))}
      <p className="col-span-2 mt-1 text-center" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
        右栏没有常驻内容——每个页签都可关闭，从这里或「+」重新打开
      </p>
    </div>
  )
}
