// components/shell/CommandCenter.tsx — the ⌘K command center (ZCode
// CommandCenterDialog register, v1): commands + conversations sections over
// cmdk. Files section arrives with the M3 file APIs.
import { Command } from 'cmdk'
import { useNavigate } from 'react-router'
import { MessageCirclePlus, PanelLeftClose, SunMoon } from 'lucide-react'
import { useUi } from '../../lib/stores/ui.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { bindingLabel } from '$lib/shortcuts/bindings.js'

export function CommandCenter() {
  const navigate = useNavigate()
  const { paletteOpen, setPalette, setNewSessionOpen, toggleLeftPanel } = useUi()
  const list = useSessions((s) => s.list)

  const close = () => setPalette(false)
  const openSession = (id: string) => { close(); void navigate(`/session/${id}`) }

  const cycleTheme = () => {
    const cur = localStorage.getItem('ocrc-theme')
    const next = cur === 'light' ? 'dark' : cur === 'dark' ? null : 'light'
    if (next) { localStorage.setItem('ocrc-theme', next); document.documentElement.setAttribute('data-theme', next) }
    else { localStorage.removeItem('ocrc-theme'); document.documentElement.removeAttribute('data-theme') }
  }

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPalette}
      label="命令中心"
      className="cmdk-root"
      overlayClassName="cmdk-overlay"
      shouldFilter
    >
      <Command.Input autoFocus placeholder="搜索会话或命令…" className="cmdk-input" />
      <Command.List className="cmdk-list">
        <Command.Empty className="cmdk-empty">没有匹配项</Command.Empty>

        <Command.Group heading="命令" className="cmdk-group">
          <Item onSelect={() => { close(); setNewSessionOpen(true) }}>
            <MessageCirclePlus size={14} strokeWidth={1.75} /> 新建任务
            <kbd className="cmdk-kbd">{bindingLabel('Ctrl+N')}</kbd>
          </Item>
          <Item onSelect={() => { close(); toggleLeftPanel() }}>
            <PanelLeftClose size={14} strokeWidth={1.75} /> 折叠 / 展开左栏
            <kbd className="cmdk-kbd">{bindingLabel('Ctrl+B')}</kbd>
          </Item>
          <Item onSelect={() => { close(); cycleTheme() }}>
            <SunMoon size={14} strokeWidth={1.75} /> 切换主题
          </Item>
        </Command.Group>

        <Command.Group heading="会话" className="cmdk-group">
          {list.slice(0, 8).map((s) => (
            <Item key={s.id} onSelect={() => openSession(s.id)} value={`${s.title} ${s.id} ${s.directory ?? ''}`}>
              <span className="min-w-0 flex-1 truncate">{s.title || '(未命名)'}</span>
              {s.directory && (
                <span className="mono ml-2 shrink-0" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
                  {s.directory.split('/').pop()}
                </span>
              )}
            </Item>
          ))}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  )
}

function Item({ children, onSelect, value }: { children: React.ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item onSelect={onSelect} value={value} className="cmdk-item">
      {children}
    </Command.Item>
  )
}
