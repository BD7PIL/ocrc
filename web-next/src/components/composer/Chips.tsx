// components/composer/Chips.tsx — the composer control cluster (ZCode
// V4ComposerModeControls register): h-7 ghost chips with popup menus, warn
// tint on the dangerous permission tier. Session-scoped APIs only (controls
// setMode/setModel); effort/variant rides sendMessage at send time (M2-5).
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Gauge, Zap } from 'lucide-react'
import { api } from '$lib/api/client.js'

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return ref
}

function Chip({ label, warn, open, onClick, title }: { label: string; warn?: boolean; open: boolean; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 shrink-0 items-center gap-1 rounded-[9px] px-2 transition-colors"
      style={{
        color: warn ? 'var(--warn)' : 'var(--text-2)',
        border: `1px solid ${open ? 'var(--accent-line)' : 'var(--border)'}`,
        background: open ? 'var(--bg-elev2)' : 'transparent',
        fontSize: 'var(--ui-xs)',
        maxWidth: 160,
      }}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown size={11} strokeWidth={2} className="shrink-0" />
    </button>
  )
}

function Menu({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute bottom-9 left-0 z-[var(--z-popover)] w-52 rounded-[9px] p-1 ocrc-pop"
      style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--elev-panel)' }}
      role="listbox"
    >
      {children}
    </div>
  )
}

function MenuItem({ selected, onClick, children }: { selected?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={!!selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left transition-colors"
      style={{ background: selected ? 'var(--accent-2)' : 'transparent', color: selected ? 'var(--text)' : 'var(--text-2)', fontSize: 'var(--ui-sm)' }}
    >
      {children}
    </button>
  )
}

// ── 权限四档 chip（ZCode V4ComposerModeControls 寄存器）：plan/build 走会
//    话原生模式；edit/yolo 是宿主审批路由策略（PRODUCT.md 权限四档），铺在
//    build 之上。yolo 选中时常驻 warning 黄（危险档示警）。──────────────
type Tier = 'plan' | 'build' | 'edit' | 'yolo'
const TIER_LABEL: Record<Tier, string> = { plan: '计划模式', build: '询问', edit: '自动编辑', yolo: '完全访问' }

export function ModeChip({ sessionId }: { sessionId: string }) {
  const [policy, setPolicyState] = useState<'default' | 'edit' | 'yolo'>('default')
  const [agent, setAgentState] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))

  useEffect(() => {
    void api.getOverrides().then((o) => setAgentState(o.agent ?? undefined)).catch(() => {})
    void api.getPolicy(sessionId).then((p) => setPolicyState(p.policy)).catch(() => {})
  }, [sessionId])

  const tier: Tier = policy === 'edit' || policy === 'yolo' ? policy : (agent === 'plan' ? 'plan' : 'build')

  const select = (t: Tier) => {
    setOpen(false)
    const nextAgent = t === 'plan' ? 'plan' : 'build'
    setAgentState(nextAgent)
    void api.setOverrides({ agent: nextAgent }).catch(() => {})
    const nextPolicy = t === 'edit' || t === 'yolo' ? t : 'default'
    setPolicyState(nextPolicy)
    void api.setPolicy(sessionId, nextPolicy).catch(() => {})
  }

  return (
    <div className="relative" ref={ref}>
      <Chip label={TIER_LABEL[tier]} warn={tier === 'yolo'} open={open} onClick={() => setOpen((v) => !v)} title="权限模式" />
      {open && (
        <Menu>
          {(['plan', 'build', 'edit', 'yolo'] as Tier[]).map((t) => (
            <div key={t}>
              <MenuItem selected={tier === t} onClick={() => select(t)}>
                <span style={{ color: t === 'yolo' ? 'var(--warn)' : undefined }}>{TIER_LABEL[t]}</span>
                {t === 'yolo' && <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>自动放行全部审批</span>}
              </MenuItem>
              {t === 'build' && <div className="mx-2.5 my-1 border-t" style={{ borderColor: 'var(--border-2)' }} />}
            </div>
          ))}
        </Menu>
      )}
    </div>
  )
}

// ── 模型 chip：overrides 管线（opencode backend 刻意不做 session 级切换 —
//    sessionControls:false；与旧壳 AgentChip/ModelChip 同一事实源）─────────
interface Catalog { id: string; name?: string; models: Array<{ id: string; name?: string }> }

export function ModelChip({ sessionId }: { sessionId: string }) {
  const [providers, setProviders] = useState<Catalog[]>([])
  const [current, setCurrent] = useState<{ providerID: string; modelID: string } | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))

  useEffect(() => {
    void Promise.all([api.models(), api.getOverrides()]).then(([catalog, o]) => {
      setProviders(catalog)
      setCurrent(o.model ?? null)
    }).catch(() => {})
  }, [sessionId])

  const label = current?.modelID ?? '模型'

  return (
    <div className="relative" ref={ref}>
      <Chip label={label} open={open} onClick={() => setOpen((v) => !v)} title="会话模型" />
      {open && (
        <Menu>
          {providers.length === 0 && <div className="px-2.5 py-1.5" style={{ color: 'var(--text-3)', fontSize: 'var(--ui-sm)' }}>暂无可选</div>}
          {providers.map((p) => (
            <div key={p.id}>
              <div className="px-2.5 pt-1.5 label">{p.id}</div>
              {p.models.map((m) => {
                const sel = current?.providerID === p.id && current?.modelID === m.id
                return (
                  <MenuItem
                    key={m.id}
                    selected={sel}
                    onClick={() => {
                      setOpen(false)
                      setCurrent({ providerID: p.id, modelID: m.id })
                      void api.setOverrides({ model: { providerID: p.id, modelID: m.id } }).catch(() => {})
                    }}
                  >
                    {m.name || m.id}
                  </MenuItem>
                )
              })}
            </div>
          ))}
          {current && (
            <MenuItem onClick={() => { setOpen(false); setCurrent(null); void api.setOverrides({ model: null }).catch(() => {}) }}>
              清除覆盖
            </MenuItem>
          )}
        </Menu>
      )}
    </div>
  )
}

// ── 思考深度 chip：本地选择，随 sendMessage 的 variant 下发（M2-5 接线）──
export function EffortChip({ variant, setVariant }: { variant: string | null; setVariant: (v: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  const LEVELS = ['high', 'medium', 'low'] as const
  const label = variant ?? '思考:默认'
  return (
    <div className="relative" ref={ref}>
      <Chip label={label} open={open} onClick={() => setOpen((v) => !v)} title="推理强度（随下一条消息生效）" />
      {open && (
        <Menu>
          <MenuItem selected={variant === null} onClick={() => { setVariant(null); setOpen(false) }}>默认</MenuItem>
          {LEVELS.map((l) => (
            <MenuItem key={l} selected={variant === l} onClick={() => { setVariant(l); setOpen(false) }}>
              <Zap size={12} strokeWidth={1.75} /> {l}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  )
}

// ── 上下文用量 chip：环形表 + 明细（估算分解走已迁移的 contextBreakdown）──
export function ContextChip({ usage }: { usage?: { used: number; max: number } }) {
  const [open, setOpen] = useState(false)
  const ref = useOutsideClose(open, () => setOpen(false))
  if (!usage || !usage.max) return null
  const { used: usedTokens, max: MAX } = usage
  const pct = Math.min(1, usedTokens / MAX)
  const R = 6.5
  const C = 2 * Math.PI * R
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-[9px] px-1.5"
        style={{ color: 'var(--text-3)', border: '1px solid var(--border)' }}
        title="上下文占用"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r={R} fill="none" stroke="var(--border)" strokeWidth="2.5" />
          <circle
            cx="8" cy="8" r={R} fill="none"
            stroke={pct > 0.9 ? 'var(--err)' : pct > 0.75 ? 'var(--warn)' : 'var(--accent)'}
            strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 8 8)"
          />
        </svg>
        <Gauge size={0} className="hidden" />
        <span className="mono" style={{ fontSize: 'var(--ui-2xs)' }}>{fmt(usedTokens)}</span>
      </button>
      {open && (
        <Menu>
          <div className="px-2.5 py-1.5" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>
            约 {usedTokens.toLocaleString()} / {MAX.toLocaleString()} tokens（{(pct * 100).toFixed(0)}%）
            <br />明细分解随 M3 右栏落地
          </div>
        </Menu>
      )}
    </div>
  )
}
