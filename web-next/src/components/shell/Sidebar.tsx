// components/shell/Sidebar.tsx — the left rail (ZCode WorkspaceSidebar
// register): action rows with in-place shortcut hints, view pills, grouped /
// timeline / archived task views, leading status slot, footer. Data: live
// session summaries (WS hello) + local pins/archive.
// M9 视觉复刻：className 串照抄 ZCode 实源——NewTaskButtonGroup / TaskListItem /
// sticky-group-header / WorkspaceHeader TabsList；经 index.css @theme 桥落到
// zai 色值（bg-sidebar/bg-selected/bg-surface-hover/text-foreground-subtle…）。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router'
import {
  MessageCirclePlus, Search, Folder, Cloud, Archive, ArchiveRestore,
  Pin, PinOff, SunMoon, CircleDashed, CalendarClock, Bot, Settings as SettingsIcon,
  Loader2, ChevronDown,
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

/** ZCode TaskListItem leading slot 的前置指示器优先级：error > busy > unread > idle。 */
type Leading = 'error' | 'busy' | 'unread' | 'idle'

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

  const leadingOf = (s: SessionSummary): Leading => {
    if (sessionStatus(s, busy) === 'busy') return 'busy'
    if (s.error) return 'error'
    if (s.unread) return 'unread'
    return 'idle'
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar">
      {/* action rows — ZCode NewTaskButtonGroup register：行即快捷键的广告位 */}
      <div className="flex flex-col gap-1 px-2 py-3">
        <ActionRow icon={<MessageCirclePlus className="h-4 w-4 shrink-0" />} label="新建任务"
          kbd={bindingLabel('Ctrl+N')} onClick={() => setNewSessionOpen(true)} />
        <ActionRow icon={<Search className="h-4 w-4 shrink-0" />} label="搜索"
          kbd={bindingLabel('Ctrl+K')} onClick={() => setPalette(true)} />
        <ActionRow icon={<CalendarClock className="h-4 w-4 shrink-0" />} label="自动化"
          active={location.pathname === '/automations'}
          onClick={() => { void navigate('/automations') }} />
        <ActionRow icon={<Bot className="h-4 w-4 shrink-0" />} label="机器人"
          onClick={() => setChannelsOpen(true)} />
        <ActionRow icon={<SettingsIcon className="h-4 w-4 shrink-0" />} label="设置"
          active={location.pathname === '/settings'}
          onClick={() => { void navigate('/settings') }} />
      </div>

      {/* view pills — ZCode WorkspaceHeader TabsList register（bg-surface 圆胶囊 + 滑块） */}
      <div className="px-2.5 pb-1">
        <div className="flex items-center justify-between gap-2">
          <div className="relative flex h-7 w-fit shrink-0 items-center gap-1 overflow-hidden rounded-full bg-surface p-0.5">
            <ViewPill active={view === 'project'} onClick={() => setView('project')}>项目</ViewPill>
            <ViewPill active={view === 'time'} onClick={() => setView('time')}>时间</ViewPill>
          </div>
          <button
            type="button"
            aria-pressed={showArchive}
            title={showArchive ? '返回会话列表' : '归档'}
            className={`shrink-0 rounded-md p-1.5 transition-colors ${showArchive ? 'bg-hover text-foreground' : 'text-foreground-subtle hover:text-foreground'}`}
            onClick={() => setShowArchive((v) => !v)}
          >
            {showArchive ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* list — ZCode TaskList：留白 + item 自带圆角态（无 divide 分隔线） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!loaded && (
          <div className="px-3 py-2 text-ui-base text-foreground-subtle">加载中…</div>
        )}
        {loaded && visible.length === 0 && (
          <div className="px-3 py-2 text-ui-base text-foreground-subtle">
            {showArchive ? '暂无归档会话' : '还没有会话——新建一个任务吧'}
          </div>
        )}

        {pinned.length > 0 && !showArchive && (
          <>
            <GroupHeader name="置顶" icon="pin" count={pinned.length} />
            <ul className="space-y-0.5">
              {pinned.map((s) => (
                <SessionRow key={s.id} s={s} active={activeSessionId === s.id} leading={leadingOf(s)} pinned
                  onOpen={() => openSession(s)} onPin={() => togglePin(s.id)} />
              ))}
            </ul>
          </>
        )}

        {groups.map((g) => (
          <div key={g.key}>
            {g.sessions.length > 0 && <GroupHeader name={g.name} icon={g.icon} count={g.sessions.length} />}
            <ul className="space-y-0.5">
              {g.sessions.map((s) => (
                <SessionRow key={s.id} s={s} active={activeSessionId === s.id} leading={leadingOf(s)}
                  onOpen={() => openSession(s)} onPin={() => togglePin(s.id)} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <CircleDashed className="h-3 w-3 shrink-0 text-foreground-subtlest" aria-hidden />
        <span className="mono min-w-0 truncate text-ui-2xs text-foreground-subtlest" title={version}>
          {version || 'ocrc'}
        </span>
        <IconBtn title="切换主题（跟随系统→浅色→深色）" onClick={() => {
          const cur = localStorage.getItem('ocrc-theme')
          const next = cur === 'light' ? 'dark' : cur === 'dark' ? null : 'light'
          if (next) { localStorage.setItem('ocrc-theme', next); document.documentElement.setAttribute('data-theme', next) }
          else { localStorage.removeItem('ocrc-theme'); document.documentElement.removeAttribute('data-theme') }
        }}>
          <SunMoon className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="折叠左栏 (Ctrl+B)" onClick={toggleLeftPanel}>
          <PanelCollapse />
        </IconBtn>
      </div>
    </div>
  )
}

/** ZCode NewTaskButtonGroup 行：h-8 圆角行 + 前置图标 + truncate 标签 + 尾部 kbd。 */
function ActionRow({ icon, label, kbd, active, onClick }: {
  icon: React.ReactNode
  label: string
  kbd?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-2.5 pr-2.5 text-left transition-colors ${
        active ? 'bg-selected text-foreground' : 'text-foreground hover:bg-surface-hover hover:text-foreground'
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
        {icon}
        <span className="truncate">{label}</span>
        {kbd && <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">{kbd}</span>}
      </span>
    </button>
  )
}

/** ZCode WorkspaceHeader 视图切换 pill：h-6 圆角、active = bg-background 滑块 + 前景提亮。 */
function ViewPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative z-10 h-6 flex-none rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium transition-colors ${
        active ? 'bg-background text-foreground' : 'text-foreground-subtle hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

/** ZCode sticky-group-header：h-8 bg-background 边框卡 + bg-tag/50 计数徽章。 */
function GroupHeader({ name, icon, count }: { name: string; icon: 'folder' | 'cloud' | 'pin' | 'recent'; count: number }) {
  return (
    <div className="sticky top-0 z-10 bg-sidebar px-2 pb-1 pt-2">
      <div className="flex h-8 items-center gap-1 rounded-lg border border-border bg-background pl-1.5 pr-1 text-ui-base text-foreground shadow-sm">
        {icon === 'folder' && <Folder className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />}
        {icon === 'cloud' && <Cloud className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />}
        {icon === 'pin' && <Pin className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />}
        {icon === 'recent' && <ChevronDown className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />}
        <span className="min-w-0 max-w-full flex-1 truncate px-1 text-left">{name}</span>
        <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle">
          {count}
        </span>
      </div>
    </div>
  )
}

/** ZCode TaskListItem 行体：rounded-lg pl-2.5 pr-1 py-1 + active bg-selected +
    hover:bg-surface-hover；前置 size-4 槽承载状态点/旋转 loader。 */
function SessionRow({ s, active, leading, pinned, onOpen, onPin }: {
  s: SessionSummary
  active: boolean
  leading: Leading
  pinned?: boolean
  onOpen: () => void
  onPin: () => void
}) {
  const remote = isRemoteSession(s)
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 transition-colors ${
        active ? 'bg-selected' : 'hover:bg-surface-hover'
      }`}
    >
      <div className="relative flex size-4 shrink-0 items-center justify-center">
        {leading === 'error' ? (
          <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
        ) : leading === 'busy' ? (
          <Loader2 className="size-4 animate-spin text-foreground-subtle" />
        ) : leading === 'unread' ? (
          <span data-unread-indicator="true" className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--oc-unread-dot)' }} />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-border" />
        )}
      </div>
      {remote && <Cloud className="size-3.5 shrink-0 text-foreground-subtle" aria-label="远程" />}
      <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
        {s.title || '(未命名)'}
      </span>
      <span className="mono shrink-0 text-ui-2xs text-foreground-subtlest group-hover:hidden">
        {relTime(s.lastActiveAt)}
      </span>
      <button
        type="button"
        className="hidden shrink-0 text-foreground-subtle hover:text-foreground group-hover:block"
        title={pinned ? '取消置顶' : '置顶'}
        onClick={(e) => { e.stopPropagation(); onPin() }}
      >
        {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </button>
    </li>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="ml-auto shrink-0 rounded-md p-1.5 text-foreground-subtle transition-colors first:ml-0 hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function PanelCollapse() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}
