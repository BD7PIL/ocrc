// components/cards/CardView.tsx — StructuredCard dispatch (M2 core set).
// Interactive cards (approval/question) call the real APIs; the rich tool
// renderers / md-toggle tool output arrive with the M3 right pane.
import { memo, useState } from 'react'
import type { StructuredCard } from '$lib/api/types.js'
import { api } from '$lib/api/client.js'
import { useCurrentSessionId } from '../transcript/sessionContext.js'
import { Blocks } from './Blocks.js'

export const CardView = memo(function CardView({ card }: { card: StructuredCard }) {
  switch (card.kind) {
    case 'user': return <UserCard card={card} />
    case 'streaming': return <Shell><Blocks blocks={card.blocks} /><StreamCaret /></Shell>
    case 'assistant': return <AssistantCard card={card} />
    case 'thinking': return <ThinkingCard showStop={'showStop' in card ? card.showStop : false} />
    case 'think-stream': return <Shell><p className="mono" style={{ color: 'var(--text-3)', fontSize: 'var(--ui-sm)' }}>思考…</p></Shell>
    case 'status': {
      const text = Object.entries(card.fields).map(([k, v]) => `${k}=${v}`).join(' · ')
      return <p className="mono px-1 py-0.5" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>{text}</p>
    }
    case 'error': return (
      <Shell tint="var(--err)">
        <p style={{ color: 'var(--err)', fontSize: 'var(--ui-sm)' }}>{card.message}</p>
      </Shell>
    )
    case 'info': return (
      <Shell>
        <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{card.title}</p>
        {card.sections.map((sec, i) => (
          <div key={i} className="mt-1" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
            {sec.heading && <span className="label">{sec.heading}</span>}
            <p>{sec.body}</p>
            {sec.code && <pre className="mono mt-1 overflow-x-auto rounded-[9px] p-2" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)' }}>{sec.code.content}</pre>}
          </div>
        ))}
      </Shell>
    )
    case 'approval': return <ApprovalCard card={card} />
    case 'question': return <QuestionCard card={card} />
    default: return null
  }
})

function Shell({ children, tint }: { children: React.ReactNode; tint?: string }) {
  return (
    <div
      className="max-w-[720px] rounded-[14px] px-4 py-3"
      style={{ background: 'var(--bg-elev)', border: `1px solid ${tint ?? 'var(--border)'}` }}
    >
      {children}
    </div>
  )
}

function UserCard({ card }: { card: Extract<StructuredCard, { kind: 'user' }> }) {
  return (
    <div className="flex">
      <div
        className="max-w-[85%] rounded-[14px] rounded-tl-[4px] px-4 py-2.5"
        style={{ background: 'var(--user-bubble)', border: '1px solid var(--bubbleline)' }}
      >
        <p className="whitespace-pre-wrap" style={{ color: 'var(--user-ink)', fontSize: 'var(--ui-base)' }}>{card.text}</p>
        {card.origin && card.origin !== 'web' && (
          <p className="mono mt-1" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>via {card.origin}</p>
        )}
      </div>
    </div>
  )
}

function AssistantCard({ card }: { card: Extract<StructuredCard, { kind: 'assistant' }> }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    const text = card.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n')
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <Shell>
      <Blocks blocks={card.blocks} />
      <div className="mt-2 flex items-center gap-3 border-t pt-2" style={{ borderColor: 'var(--border-2)' }}>
        {card.meta?.model && <span className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{card.meta.model}</span>}
        {typeof card.meta?.cost === 'number' && card.meta.cost > 0 && (
          <span className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>${card.meta.cost.toFixed(4)}</span>
        )}
        <button type="button" className="ml-auto" style={{ fontSize: 'var(--ui-2xs)', color: copied ? 'var(--ok)' : 'var(--text-3)' }} onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </Shell>
  )
}

function ThinkingCard({ showStop }: { showStop: boolean }) {
  return (
    <Shell>
      <div className="flex items-center gap-2">
        <span className="ocrc-pulse-dot size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
        <span style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>思考中…</span>
        {showStop && <StopButton />}
      </div>
    </Shell>
  )
}

function StopButton() {
  const sessionId = useCurrentSessionId()
  return (
    <button
      type="button"
      className="rounded-md px-2 py-0.5"
      style={{ border: '1px solid var(--border)', color: 'var(--text-3)', fontSize: 'var(--ui-2xs)' }}
      onClick={() => { if (sessionId) void api.abort(sessionId) }}
    >
      停止
    </button>
  )
}

function StreamCaret() {
  return <span className="ocrc-blink-dot inline-block h-4 w-2" style={{ background: 'var(--accent)' }} aria-hidden />
}

function ApprovalCard({ card }: { card: Extract<StructuredCard, { kind: 'approval' }> }) {
  const [done, setDone] = useState<string | null>(null)
  const decide = (d: 'once' | 'always' | 'reject') => {
    setDone(d)
    void api.approve(card.sessionId, card.requestId, d).catch(() => setDone(null))
  }
  return (
    <Shell tint="var(--accent-line)">
      <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{card.title}</p>
      {card.args != null && (
        <pre className="mono mt-2 overflow-x-auto rounded-[9px] p-2" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)', color: 'var(--toolout)' }}>
          {typeof card.args === 'string' ? card.args : JSON.stringify(card.args, null, 2).slice(0, 600)}
        </pre>
      )}
      {done ? (
        <p className="mt-2" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>
          {done === 'reject' ? '已拒绝' : done === 'always' ? '已允许（本会话）' : '已允许（本次）'}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <DecisionBtn label="仅此一次" onClick={() => decide('once')} />
          <DecisionBtn label="本会话允许" onClick={() => decide('always')} />
          <DecisionBtn label="拒绝" danger onClick={() => decide('reject')} />
        </div>
      )}
    </Shell>
  )
}

function QuestionCard({ card }: { card: Extract<StructuredCard, { kind: 'question' }> }) {
  const [answered, setAnswered] = useState<string[][] | null>(card.answers ?? null)
  const q = card.questions[0]
  if (!q) return null
  const pick = async (label: string) => {
    setAnswered([[label]])
    await api.answerQuestion(card.sessionId, card.requestId, [[label]]).catch(() => setAnswered(null))
  }
  const reject = async () => {
    setAnswered([])
    await api.rejectQuestion(card.sessionId, card.requestId).catch(() => setAnswered(null))
  }
  return (
    <Shell tint="var(--accent-line)">
      <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{q.question}</p>
      {answered ? (
        <p className="mt-2" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>
          {answered.length === 0 ? '已跳过' : `已回答：${answered[0]?.join('、')}`}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {q.options.map((o) => (
            <DecisionBtn key={o.label} label={o.label} onClick={() => void pick(o.label)} />
          ))}
          <DecisionBtn label="跳过" danger onClick={() => void reject()} />
        </div>
      )}
    </Shell>
  )
}

function DecisionBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      className="rounded-[9px] px-3 py-1.5 transition-colors"
      style={{
        fontSize: 'var(--ui-sm)',
        border: `1px solid ${danger ? 'var(--err)' : 'var(--accent-line)'}`,
        color: danger ? 'var(--err)' : 'var(--text)',
        background: 'transparent',
      }}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
