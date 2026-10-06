// components/shell/Sidebar.tsx — the left rail (ZCode WorkspaceSidebar
// register): action rows with in-place shortcut hints, view pills, grouped /
// timeline / archived task views, 1.5px status dots, footer. Data: live
// session summaries (WS hello) + local pins/archive.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router'
import {
  MessageCirclePlus, Search, Folder, Cloud, Archive, ArchiveRestore,
  Pin, PinOff, SunMoon, CircleDashed, CalendarClock, Bot, Settings as SettingsIcon,
} from 'lucide-react'
import { useUi } from '../../lib/stores/ui.js'
import { usePins } from '../../lib/stores/pins.js'
import { useSessions, sessionStatus } from '../../lib/stores/sessions.js'
import { api } from '$lib/api/client.js'
import { bindingLabel } from '$lib/shortcuts/bindings.js'
import {
  groupByProject, partitionTime, isRemoteSession,
} from '$lib/nav/railModel.js'
import type { SessionSummary } from '$lib/api/types.js'

type ViewMode = 'project' | 'time'

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 90_000) return '刚刚'
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时`
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)} 天`
  return new Date(ts).toLocaleDateString()
}

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { activeSessionId, setActiveSession, setNewSessionOpen, setPalette, toggleLeftPanel, setChannelsOpen } = useUi()
  const { list, loaded, busy } = useSessions()
  const { pins, archived, togglePin } = usePins()
  const [view, setView] = useState<ViewMode>('project')
  const [showArchive, setShowArchive] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => { void api.version().then((v) => setVersion(`${v.version}${v.commit ? ` · ${v.commit.slice(0, 7)}` : ''}`)).catch(() => {}) }, [])

  const active = useMemo(() => new Set(showArchive ? archived : list.map((s) => s.id)), [showArchive, archived, list])
  const visible = useMemo(
    () => (showArchive ? list.filter((s) => active.has(s.id)) : list.filter((s) => !archived.includes(s.id))),
    [showArchive, archived, list, active],
  )
  const pinned = useMemo(() => visible.filter((s) => pins.includes(s.id)), [visible, pins])

  const groups = useMemo(() => {
    const unpinned = visible.filter((s) => !pins.includes(s.id))
    if (view === 'time') {
      const t = partitionTime(unpinned, [])
      return [{ key: '@recent', name: '最近', icon: 'recent' as const, sessions: t.recent }]
    }
    return groupByProject(unpinned).map((g) => ({
      key: g.key,
      name: g.remote && g.remoteHost ? `@${g.remoteHost}` : g.label,
      icon: (g.remote ? 'cloud' : 'folder') as 'cloud' | 'folder',
      sessions: g.rows,
    }))
  }, [visible, view, pins])

  const openSession = (s: SessionSummary) => {
    setActiveSession(s.id)
    void navigate(`/session/${s.id}`)
  }

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--bg-panel)' }}>
      {/* action rows — the row IS the shortcut's discoverability ad slot */}
      <div className="flex flex-col gap-0.5 px-2 pt-3">
        <button type="button" className="rail-row" onClick={() => setNewSessionOpen(true)}>
          <MessageCirclePlus size={16} strokeWidth={1.75} />
          <span>新建任务</span>
          <kbd className="rail-kbd">{bindingLabel('Ctrl+N')}</kbd>
        </button>
        <button type="button" className="rail-row" onClick={() => setPalette(true)}>
          <Search size={16} strokeWidth={1.75} />
          <span>搜索</span>
          <kbd className="rail-kbd">{bindingLabel('Ctrl+K')}</kbd>
        </button>
        <button
          type="button"
          className="rail-row"
          aria-pressed={location.pathname === '/automations'}
          style={{ color: location.pathname === '/automations' ? 'var(--text)' : undefined, background: location.pathname === '/automations' ? 'var(--bg-elev2)' : undefined }}
          onClick={() => { void navigate('/automations') }}
        >
          <CalendarClock size={16} strokeWidth={1.75} />
          <span>自动化</span>
        </button>
        <button type="button" className="rail-row" onClick={() => setChannelsOpen(true)}>
          <Bot size={16} strokeWidth={1.75} />
          <span>机器人</span>
        </button>
        <button
          type="button"
          className="rail-row"
          aria-pressed={location.pathname === '/settings'}
          style={{ color: location.pathname === '/settings' ? 'var(--text)' : undefined, background: location.pathname === '/settings' ? 'var(--bg-elev2)' : undefined }}
          onClick={() => { void navigate('/settings') }}
        >
          <SettingsIcon size={16} strokeWidth={1.75} />
          <span>设置</span>
        </button>
      </div>

      {/* view pills + archive toggle */}
      <div className="mt-3 flex items-center gap-1 px-3">
        <div className="flex gap-0.5 rounded-full p-0.5" style={{ background: 'var(--bg-input)' }}>
          <Pill active={view === 'project'} onClick={() => setView('project')}>项目</Pill>
          <Pill active={view === 'time'} onClick={() => setView('time')}>时间</Pill>
        </div>
        <button
          type="button"
          className="ml-auto rounded-md p-1.5 transition-colors"
          style={{ color: showArchive ? 'var(--accent)' : 'var(--text-3)' }}
          aria-pressed={showArchive}
          title={showArchive ? '返回会话列表' : '归档'}
          onClick={() => setShowArchive((v) => !v)}
        >
          {showArchive ? <ArchiveRestore size={15} strokeWidth={1.75} /> : <Archive size={15} strokeWidth={1.75} />}
        </button>
      </div>

      {/* list */}
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded && (
          <div className="px-2 py-6 text-center" style={{ color: 'var(--text-3)', fontSize: 'var(--ui-sm)' }}>加载中…</div>
        )}
        {loaded && visible.length === 0 && (
          <div className="px-2 py-6 text-center" style={{ color: 'var(--text-3)', fontSize: 'var(--ui-sm)' }}>
            {showArchive ? '暂无归档会话' : '还没有会话——新建一个任务吧'}
          </div>
        )}

        {pinned.length > 0 && !showArchive && (
          <>
            <GroupHeader name="置顶" icon="pin" count={pinned.length} />
            {pinned.map((s) => (
              <SessionRow key={s.id} s={s} active={activeSessionId === s.id} isBusy={sessionStatus(s, busy) === 'busy'} pinned
                onOpen={() => openSession(s)} onPin={() => togglePin(s.id)} />
            ))}
          </>
        )}

        {groups.map((g) => (
          <div key={g.key}>
            {g.sessions.length > 0 && <GroupHeader name={g.name} icon={g.icon} count={g.sessions.length} />}
            {g.sessions.map((s) => (
              <SessionRow key={s.id} s={s} active={activeSessionId === s.id} isBusy={sessionStatus(s, busy) === 'busy'}
                onOpen={() => openSession(s)} onPin={() => togglePin(s.id)} />
            ))}
          </div>
        ))}
      </div>

      {/* footer */}
      <div className="flex items-center gap-2 border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
        <CircleDashed size={12} strokeWidth={1.75} style={{ color: 'var(--text-4)' }} aria-hidden />
        <span className="mono truncate" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }} title={version}>
          {version || 'ocrc'}
        </span>
        <button
          type="button"
          className="ml-auto rounded-md p-1.5"
          style={{ color: 'var(--text-3)' }}
          title="切换主题（跟随系统→浅色→深色）"
          onClick={() => {
            const cur = localStorage.getItem('ocrc-theme')
            const next = cur === 'light' ? 'dark' : cur === 'dark' ? null : 'light'
            if (next) { localStorage.setItem('ocrc-theme', next); document.documentElement.setAttribute('data-theme', next) }
            else { localStorage.removeItem('ocrc-theme'); document.documentElement.removeAttribute('data-theme') }
          }}
        >
          <SunMoon size={14} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5"
          style={{ color: 'var(--text-3)' }}
          title="折叠左栏 (Ctrl+B)"
          onClick={toggleLeftPanel}
        >
          <PanelCollapse />
        </button>
      </div>
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-0.5 transition-colors"
      style={{
        fontSize: 'var(--ui-xs)',
        background: active ? 'var(--bg-elev2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-3)',
      }}
    >
      {children}
    </button>
  )
}

function GroupHeader({ name, icon, count }: { name: string; icon: 'folder' | 'cloud' | 'pin' | 'recent'; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 px-2 pb-1 pt-3" style={{ background: 'var(--bg-panel)' }}>
      {icon === 'folder' && <Folder size={12} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} aria-hidden />}
      {icon === 'cloud' && <Cloud size={12} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} aria-hidden />}
      {icon === 'pin' && <Pin size={12} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} aria-hidden />}
      <span className="label">{name}</span>
      <span className="mono ml-auto" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{count}</span>
    </div>
  )
}

function SessionRow({ s, active, isBusy, pinned, onOpen, onPin }: {
  s: SessionSummary
  active: boolean
  isBusy: boolean
  pinned?: boolean
  onOpen: () => void
  onPin: () => void
}) {
  const remote = isRemoteSession(s)
  return (
    <div
      className="group flex cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 transition-colors"
      style={{ background: active ? 'var(--accent-2)' : undefined }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
    >
      {/* status dot: busy = accent pulse / idle = ok / empty ring = unknown */}
      <span
        className={`size-1.5 shrink-0 rounded-full ${isBusy ? 'ocrc-pulse-dot' : ''}`}
        style={
          isBusy
            ? { background: 'var(--accent)' }
            : s.unread || !s.lastActiveAt
              ? { border: '1.5px solid var(--text-4)' }
              : { background: 'var(--ok)' }
        }
        aria-hidden
      />
      {remote && <Cloud size={11} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} aria-hidden title="远程" />}
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-sm)', color: active ? 'var(--text)' : 'var(--text-2)' }}>
        {s.title || '(未命名)'}
      </span>
      <span
        className="mono shrink-0 group-hover:hidden"
        style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}
      >
        {relTime(s.lastActiveAt)}
      </span>
      <button
        type="button"
        className="hidden shrink-0 rounded p-1 group-hover:block"
        style={{ color: pinned ? 'var(--accent)' : 'var(--text-3)' }}
        title={pinned ? '取消置顶' : '置顶'}
        onClick={(e) => { e.stopPropagation(); onPin() }}
      >
        {pinned ? <PinOff size={12} strokeWidth={1.75} /> : <Pin size={12} strokeWidth={1.75} />}
      </button>
    </div>
  )
}

function PanelCollapse() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ color: 'var(--text-3)' }}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
