// components/pane/SidePane.tsx — the right pane (ZCode SidePaneTabTrigger +
// AnimatedSidePanePanel register): nothing permanently resident, every tab
// closable, idempotent ids, "+" menu reopens homes, drag reorders, empty
// state is a launcher. M9 视觉复刻：48px 条（border-b border-border/50 发丝
// 线、透明底）+ 28px rounded-lg 浮起药丸页签（active=bg-selected、hover=
// bg-hover、✕ active 常驻/hover 显现、标题 mask 渐隐）——类串照抄 ZCode 实源。
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
    <div className="flex h-full flex-col bg-background">
      {/* tab strip — ZCode TabsList：48px、底部发丝线、透明底 */}
      <div className="pane-tabs flex h-12 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/50 px-2">
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
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:text-foreground"
            title="打开面板"
            onClick={() => setPlusOpen((v) => !v)}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
          {plusOpen && (
            <div
              className="ocrc-pop absolute right-0 top-7 z-50 w-44 rounded-lg border border-border bg-menu p-1 shadow-md"
            >
              {HOMES.map((h) => (
                <button
                  key={h.homeId}
                  type="button"
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-ui-sm text-foreground-subtle transition-colors hover:bg-menu-hover hover:text-foreground"
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

/** ZCode SidePaneTabTrigger：rounded-lg 浮起药丸；inactive hover=bg-hover，
    active=bg-selected + text-foreground；✕ active 常驻、inactive hover 显现；
    标题 mask 渐隐（--tab-fade-offset 随 ✕ 可见性放宽）。 */
function TabTrigger({ tab, active, onActivate, onClose }: { tab: PaneTab; active: boolean; onActivate: () => void; onClose: () => void }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() } }}
      className={`pane-tab group relative flex h-7 min-w-[60px] cursor-pointer items-center justify-start gap-1 overflow-hidden whitespace-nowrap rounded-lg border border-transparent px-1.5 pr-2 text-ui-base font-medium transition-all ${
        active ? 'bg-selected text-foreground' : 'text-foreground-subtle hover:bg-hover hover:text-foreground'
      }`}
    >
      <span
        className="pane-tab-title min-w-0 flex-1 overflow-hidden"
        style={{ ['--tab-fade-offset' as string]: active ? '1.25rem' : '0px' }}
      >
        {tab.title}
      </span>
      <button
        type="button"
        aria-label="关闭页签"
        className={`pane-tab-x absolute right-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-md text-foreground-subtle hover:text-foreground ${
          active ? '' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
        }`}
        onClick={(e) => { e.stopPropagation(); onClose() }}
      >
        <X className="size-3" strokeWidth={2} />
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
    <p className="p-4 text-center text-ui-sm text-foreground-subtle">
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
          className="rounded-lg border border-border bg-card px-3 py-4 text-left text-ui-sm text-foreground-subtle transition-colors hover:bg-menu-hover hover:text-foreground"
          onClick={() => openHome(h.homeId)}
        >
          {h.title}
        </button>
      ))}
      <p className="col-span-2 mt-1 text-center text-ui-2xs text-foreground-subtlest">
        右栏没有常驻内容——每个页签都可关闭，从这里或「+」重新打开
      </p>
    </div>
  )
}
