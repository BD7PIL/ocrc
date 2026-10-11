// components/cards/CardView.tsx — StructuredCard dispatch (M2 core set).
// Interactive cards (approval/question) call the real APIs.
// M9 视觉复刻（ZCode ConversationRowView v4 register）：assistant 正文无壳
// 直排（w-full text-ui-base + hover 显现动作行）；用户气泡右对齐、
// rounded-xl rounded-tr-xs + bg-surface 叠层；审批/提问走 zai interaction
// 双 token（ask 深蓝面 / confirm 绿面）。
import { memo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { StructuredCard } from '$lib/api/types.js'
import { api } from '$lib/api/client.js'
import { useCurrentSessionId } from '../transcript/sessionContext.js'
import { useApprovals } from '../../lib/stores/approvals.js'
import { Blocks } from './Blocks.js'

export const CardView = memo(function CardView({ card }: { card: StructuredCard }) {
  switch (card.kind) {
    case 'user': return <UserCard card={card} />
    case 'streaming': return <AssistantShell><Blocks blocks={card.blocks} streaming /><StreamCaret /></AssistantShell>
    case 'assistant': return <AssistantCard card={card} />
    case 'thinking': return <ThinkingCard showStop={'showStop' in card ? card.showStop : false} />
    case 'think-stream': return <div className="flex items-center gap-2 px-4 py-1 text-ui-sm text-foreground-subtle"><Loader2 className="size-3.5 animate-spin" />思考…</div>
    case 'status': {
      const text = Object.entries(card.fields).map(([k, v]) => `${k}=${v}`).join(' · ')
      return <p className="mono px-4 py-0.5 text-ui-xs text-foreground-subtlest">{text}</p>
    }
    case 'error': return (
      <div className="mx-0 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
        {card.message}
      </div>
    )
    case 'info': return (
      <div className="px-4 py-1 text-ui-base">
        <p className="text-foreground">{card.title}</p>
        {card.sections.map((sec, i) => (
          <div key={i} className="mt-1 text-ui-sm text-foreground-subtle">
            {sec.heading && <span className="label">{sec.heading}</span>}
            <p>{sec.body}</p>
            {sec.code && <pre className="mono mt-1 overflow-x-auto rounded-lg bg-surface p-2.5 text-ui-2xs">{sec.code.content}</pre>}
          </div>
        ))}
      </div>
    )
    case 'approval': return <ApprovalCard card={card} />
    case 'question': return <QuestionCard card={card} />
    default: return null
  }
})

/** ZCode assistant row：无壳直排 + group/assistant-row hover 动作行。 */
function AssistantShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="group/assistant-row w-full text-ui-base">
      {children}
    </div>
  )
}

function UserCard({ card }: { card: Extract<StructuredCard, { kind: 'user' }> }) {
  return (
    <div className="flex flex-col items-end px-4 py-1">
      <div
        className="flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border border-border px-4 py-3 text-ui-base text-foreground"
        style={{ background: 'var(--user-bubble)', maxWidth: 'min(100%, 36rem)' }}
      >
        <p className="whitespace-pre-wrap">{card.text}</p>
        {card.origin && card.origin !== 'web' && (
          <p className="mono mt-1 text-ui-2xs text-foreground-subtlest">via {card.origin}</p>
        )}
      </div>
    </div>
  )
}

function AssistantCard({ card }: { card: Extract<StructuredCard, { kind: 'assistant' }> }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const copy = () => {
    const text = card.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n')
    // 非安全上下文（http://LAN）下 writeText 由 lib/insecure-context.ts 垫片补齐；
    // 这里仍守卫（垫片装不上时按钮不能无反应），失败给明确反馈。
    const write = navigator.clipboard?.writeText?.(text)
    if (!write) { setCopyError(true); setTimeout(() => setCopyError(false), 1500); return }
    write.then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => { setCopyError(true); setTimeout(() => setCopyError(false), 1500) })
  }
  return (
    <AssistantShell>
      <Blocks blocks={card.blocks} />
      {/* 动作行：桌面 hover 显现；触屏（hover:none）常驻——否则手机上不可发现。
          ZCode ConversationAssistantTextActions register；官方手机远控同语义。 */}
      <div className="mt-1 flex items-center gap-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover/assistant-row:opacity-100 [@media(hover:none)]:opacity-100">
        {card.meta?.model && <span className="mono text-ui-2xs text-foreground-subtlest">{card.meta.model}</span>}
        {typeof card.meta?.cost === 'number' && card.meta.cost > 0 && (
          <span className="mono text-ui-2xs text-foreground-subtlest">${card.meta.cost.toFixed(4)}</span>
        )}
        <button type="button" className="ml-auto text-ui-2xs text-foreground-subtle transition-colors hover:text-foreground" onClick={copy}>
          {copied ? <span className="text-success">已复制</span> : copyError ? <span className="text-destructive">复制失败</span> : '复制'}
        </button>
      </div>
    </AssistantShell>
  )
}

function ThinkingCard({ showStop }: { showStop: boolean }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1">
      <Loader2 className="size-3.5 animate-spin text-foreground-subtle" />
      <span className="text-ui-sm text-foreground-subtle">思考中…</span>
      {showStop && <StopButton />}
    </div>
  )
}

function StopButton() {
  const sessionId = useCurrentSessionId()
  return (
    <button
      type="button"
      className="rounded-lg border border-border px-2 py-0.5 text-ui-2xs text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
      onClick={() => { if (sessionId) void api.abort(sessionId) }}
    >
      停止
    </button>
  )
}

function StreamCaret() {
  return <span className="ocrc-blink-dot inline-block h-4 w-2 align-middle" style={{ background: 'var(--accent)' }} aria-hidden />
}

function ApprovalCard({ card }: { card: Extract<StructuredCard, { kind: 'approval' }> }) {
  const [done, setDone] = useState<string | null>(null)
  const decide = (d: 'once' | 'always' | 'reject') => {
    setDone(d)
    useApprovals.getState().markAnswered(card.requestId, d)
    void api.approve(card.sessionId, card.requestId, d).catch(() => setDone(null))
  }
  return (
    <div className="rounded-lg border p-3" style={{ background: 'var(--ask-surface)', borderColor: 'color-mix(in oklab, var(--ask-fg) 25%, transparent)' }}>
      <p className="text-ui-sm" style={{ color: 'var(--ask-fg)' }}>{card.title}</p>
      {card.args != null && (
        <pre className="mono mt-2 overflow-x-auto rounded-lg bg-surface p-2.5 text-ui-2xs text-foreground-subtle">
          {typeof card.args === 'string' ? card.args : JSON.stringify(card.args, null, 2).slice(0, 600)}
        </pre>
      )}
      {done ? (
        <p className="mt-2 rounded-lg px-2 py-1.5 text-ui-sm" style={{ background: 'var(--confirm-surface)', color: 'var(--confirm-fg)' }}>
          {done === 'reject' ? '已拒绝' : done === 'always' ? '已允许（本会话）' : '已允许（本次）'}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <BtnPrimary label="仅此一次" onClick={() => decide('once')} />
          <BtnOutline label="本会话允许" onClick={() => decide('always')} />
          <BtnOutline label="拒绝" danger onClick={() => decide('reject')} />
        </div>
      )}
    </div>
  )
}

function QuestionCard({ card }: { card: Extract<StructuredCard, { kind: 'question' }> }) {
  const [answered, setAnswered] = useState<string[][] | null>(card.answers ?? null)
  const q = card.questions[0]
  if (!q) return null
  const pick = async (label: string) => {
    setAnswered([[label]])
    useApprovals.getState().markAnswered(card.requestId, 'once')
    await api.answerQuestion(card.sessionId, card.requestId, [[label]]).catch(() => setAnswered(null))
  }
  const reject = async () => {
    setAnswered([])
    useApprovals.getState().markAnswered(card.requestId, 'skip')
    await api.rejectQuestion(card.sessionId, card.requestId).catch(() => setAnswered(null))
  }
  return (
    <div className="rounded-lg border p-3" style={{ background: 'var(--ask-surface)', borderColor: 'color-mix(in oklab, var(--ask-fg) 25%, transparent)' }}>
      <p className="text-ui-sm" style={{ color: 'var(--ask-fg)' }}>{q.question}</p>
      {answered ? (
        <p className="mt-2 rounded-lg px-2 py-1.5 text-ui-sm" style={{ background: 'var(--confirm-surface)', color: 'var(--confirm-fg)' }}>
          {answered.length === 0 ? '已跳过' : `已回答：${answered[0]?.join('、')}`}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {q.options.map((o) => (
            <BtnOutline key={o.label} label={o.label} onClick={() => void pick(o.label)} />
          ))}
          <BtnOutline label="跳过" danger onClick={() => void reject()} />
        </div>
      )}
    </div>
  )
}

/* zai 按钮族（shadcn Button register：h-8 rounded-lg text-ui-sm font-medium） */
function BtnPrimary({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="h-8 rounded-lg bg-primary px-3 text-ui-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function BtnOutline({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      className={`h-8 rounded-lg border px-3 text-ui-sm font-medium transition-colors ${
        danger
          ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
          : 'border-border text-foreground hover:bg-hover'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
