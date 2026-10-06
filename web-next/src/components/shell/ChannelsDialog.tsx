// components/shell/ChannelsDialog.tsx — the 机器人 channels dialog (ZCode
// BotsDialog register, ocrc channel runtime): left channel list with live
// dots + enable switches, right detail (allowUsers, reply granularity,
// write-only token with hint, two-step reset). Pairing itself lives in the
// PairGate / old shell until M4-3.
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api, type ChannelRow, type ChannelKind } from '$lib/api/client.js'
import { useUi } from '../../lib/stores/ui.js'

const KIND_LABEL: Record<ChannelKind, string> = {
  telegram: 'Telegram', wechat: '微信', lark: '飞书 · Lark', dingtalk: '钉钉',
}

export function ChannelsDialog() {
  // primitive selectors (object selector = React #185 loop, see StatusPanel)
  const channelsOpen = useUi((s) => s.channelsOpen)
  const setChannelsOpen = useUi((s) => s.setChannelsOpen)
  const [rows, setRows] = useState<ChannelRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const reload = () => {
    void api.channels().then((r) => {
      setRows(r.channels ?? [])
      setSelected((cur) => cur ?? r.channels?.[0]?.id ?? null)
    }).catch(() => {})
  }
  useEffect(() => { if (channelsOpen) reload() }, [channelsOpen])

  if (!channelsOpen) return null
  const sel = rows.find((r) => r.id === selected)

  const patch = (id: string, p: Parameters<typeof api.updateChannel>[1]) => {
    void api.updateChannel(id, p).then(reload)
  }

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setChannelsOpen(false)} />
      <div
        className="relative flex w-[min(94vw,760px)] overflow-hidden rounded-[14px]"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-palette)', height: 'min(70vh, 520px)' }}
      >
        {/* channel list */}
        <div className="w-56 shrink-0 overflow-y-auto border-r p-2" style={{ borderColor: 'var(--border-2)', background: 'var(--bg-panel)' }}>
          <div className="flex items-center justify-between px-2 py-2">
            <span className="label">机器人通道</span>
            <button type="button" className="rounded-[6px] p-1" style={{ color: 'var(--text-3)' }} onClick={() => setChannelsOpen(false)}>
              <X size={13} />
            </button>
          </div>
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left transition-colors"
              style={{ background: selected === r.id ? 'color-mix(in srgb, var(--text) 10%, transparent)' : 'transparent' }}
              onClick={() => { setSelected(r.id); setConfirmReset(false) }}
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: r.live?.connected ? 'var(--ok)' : 'var(--border)' }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
                {KIND_LABEL[r.channel] ?? r.channel}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={r.enabled}
                className="h-4 w-7 shrink-0 rounded-full transition-colors"
                style={{ background: r.enabled ? 'var(--accent)' : 'var(--border)' }}
                onClick={(e) => { e.stopPropagation(); patch(r.id, { enabled: !r.enabled }) }}
              >
                <span className="block h-3 w-3 rounded-full transition-transform" style={{ background: 'var(--bg-elev)', transform: r.enabled ? 'translateX(14px)' : 'translateX(2px)' }} />
              </button>
            </button>
          ))}
        </div>

        {/* detail */}
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {sel ? (
            <ChannelDetail row={sel} onPatch={(p) => patch(sel.id, p)} confirmReset={confirmReset} setConfirmReset={setConfirmReset} onReset={() => { void api.resetChannel(sel.id).then(reload) }} />
          ) : (
            <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>选择一个通道</p>
          )}
        </div>
      </div>
    </div>
  )
}

function ChannelDetail({ row, onPatch, confirmReset, setConfirmReset, onReset }: {
  row: ChannelRow
  onPatch: (p: Parameters<typeof api.updateChannel>[1]) => void
  confirmReset: boolean
  setConfirmReset: (v: boolean) => void
  onReset: () => void
}) {
  const [allowUsersDraft, setAllowUsersDraft] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')

  const saveAllowUsers = () => {
    if (allowUsersDraft === null) return
    const ids = allowUsersDraft.split(/[\s,，]+/).map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n !== 0)
    onPatch({ allowUsers: ids })
    setAllowUsersDraft(null)
  }

  return (
    <div className="flex flex-col gap-4" style={{ fontSize: 'var(--ui-sm)' }}>
      <div>
        <span className="label">状态</span>
        <p className="mt-1" style={{ color: row.live?.connected ? 'var(--ok)' : 'var(--text-3)' }}>
          {row.live?.connected ? `已连接 · ${row.live.username ?? ''}` : '未连接'}
          {row.enabled ? '' : '（已停用）'}
        </p>
      </div>

      <div>
        <span className="label">白名单用户 ID（数字，逗号分隔；空 = 用 config.env 的 ALLOWED_USER_IDS）</span>
        <div className="mt-1 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-[9px] px-2.5 py-1.5 outline-none"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
            placeholder="123456789, 987654321"
            value={allowUsersDraft ?? (row.allowUsers ?? []).join(', ')}
            onChange={(e) => setAllowUsersDraft(e.target.value)}
          />
          {allowUsersDraft !== null && (
            <button type="button" className="demo-btn" onClick={saveAllowUsers}>保存</button>
          )}
        </div>
      </div>

      <div>
        <span className="label">回复粒度</span>
        <div className="mt-1 flex gap-0.5 self-start rounded-full p-0.5" style={{ background: 'var(--bg-input)', width: 'fit-content' }}>
          {(['standard', 'detailed'] as const).map((g) => (
            <button
              key={g}
              type="button"
              className="rounded-full px-3 py-1"
              style={{ fontSize: 'var(--ui-xs)', background: row.replyGranularity === g ? 'var(--bg-elev2)' : 'transparent', color: row.replyGranularity === g ? 'var(--text)' : 'var(--text-3)' }}
              onClick={() => onPatch({ replyGranularity: g })}
            >
              {g === 'standard' ? '简洁' : '详细'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="label">凭据（write-only）</span>
        <div className="mt-1 flex gap-2">
          <input
            type="password"
            className="min-w-0 flex-1 rounded-[9px] px-2.5 py-1.5 outline-none"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
            placeholder={row.tokenHint ?? (row.hasToken ? '已配置 — 输入新值覆盖' : 'bot token')}
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          {tokenDraft && (
            <button type="button" className="demo-btn" onClick={() => { onPatch({ credentials: { token: tokenDraft } }); setTokenDraft('') }}>保存</button>
          )}
        </div>
      </div>

      <div>
        <span className="label">危险区</span>
        <div className="mt-1 flex items-center gap-2">
          {confirmReset ? (
            <>
              <button type="button" className="rounded-[9px] px-3 py-1.5" style={{ background: 'var(--err)', color: '#fff', fontSize: 'var(--ui-xs)' }} onClick={onReset}>
                确认重置（清空凭据与白名单）
              </button>
              <button type="button" className="demo-btn" onClick={() => setConfirmReset(false)}>取消</button>
            </>
          ) : (
            <button type="button" className="rounded-[9px] px-3 py-1.5" style={{ border: '1px solid var(--err)', color: 'var(--err)', fontSize: 'var(--ui-xs)' }} onClick={() => setConfirmReset(true)}>
              重置通道
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
