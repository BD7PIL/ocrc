// components/hud/Whiteboard.tsx — the whiteboard (ZCode WhiteboardPane
// register, ocrc-simplified): canvas + color/width/eraser + undo/redo/clear
// + per-session local boards (localStorage) + 「发送到聊天」→ image part via
// sendMessage. Local-only by design: opencode has no whiteboard sync.
import { useEffect, useRef, useState } from 'react'
import { Eraser, Pencil, Redo2, Trash2, Undo2, X } from 'lucide-react'
import { api } from '$lib/api/client.js'

interface Stroke { color: string; width: number; erase: boolean; points: Array<{ x: number; y: number }> }
const W = 880
const H = 480
const COLORS = ['#f5f4f0', '#fb8b3c', '#6cc08b', '#4ec9b0', '#8ab4ff', '#b48cf0', '#f97066']

function storageKey(sessionId: string): string {
  return `ocrc.whiteboard.${sessionId}`
}

function loadStrokes(sessionId: string): Stroke[] {
  try { return JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? '[]') as Stroke[] } catch { return [] }
}
function saveStrokes(sessionId: string, strokes: Stroke[]) {
  try { localStorage.setItem(storageKey(sessionId), JSON.stringify(strokes)) } catch { /* quota */ }
}

export function Whiteboard({ sessionId, onClose }: {
  sessionId: string
  onClose: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [strokes, setStrokes] = useState<Stroke[]>(() => loadStrokes(sessionId))
  const [redoStack, setRedoStack] = useState<Stroke[]>([])
  const [color, setColor] = useState(COLORS[1]!)
  const [width, setWidth] = useState(3)
  const [erase, setErase] = useState(false)
  const [sent, setSent] = useState(false)
  const drawing = useRef<Stroke | null>(null)

  // redraw everything on strokes change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#101010'
    ctx.fillRect(0, 0, W, H)
    const all = drawing.current ? [...strokes, drawing.current] : strokes
    for (const s of all) {
      ctx.strokeStyle = s.erase ? '#101010' : s.color
      ctx.lineWidth = s.erase ? s.width * 4 : s.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      if (s.points.length === 1) ctx.lineTo(s.points[0]!.x + 0.5, s.points[0]!.y)
      ctx.stroke()
    }
  }, [strokes])

  // persist (debounced by React state batching — fine for local boards)
  useEffect(() => { saveStrokes(sessionId, strokes) }, [sessionId, strokes])

  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H }
  }

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = { color, width, erase, points: [pos(e)] }
    setStrokes((s) => [...s]) // redraw with the in-progress stroke
  }
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return
    drawing.current.points.push(pos(e))
    setStrokes((s) => [...s])
  }
  const up = () => {
    if (!drawing.current) return
    const done = drawing.current
    drawing.current = null
    setStrokes((s) => [...s, done])
    setRedoStack([])
  }

  const undo = () => { setStrokes((s) => { const c = [...s]; const last = c.pop(); if (last) setRedoStack((r) => [...r, last]); return c }) }
  const redo = () => { setRedoStack((r) => { const c = [...r]; const last = c.pop(); if (last) setStrokes((s) => [...s, last!]); return c }) }
  const clear = () => { setStrokes((s) => [...s, { color: '#101010', width: W, erase: true, points: [{ x: 0, y: 0 }, { x: W, y: H }] }]) }

  const send = async () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    await api.sendMessage({ sessionId, text: '🖼 白板', images: [{ data: dataUrl.split(',')[1]!, mimeType: 'image/png' }] })
    setSent(true)
    setTimeout(onClose, 600)
  }

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} />
      <div
        className="relative flex flex-col gap-2 rounded-[14px] p-3 ocrc-rise"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-palette)' }}
      >
        <div className="flex items-center gap-2">
          <span className="label">画板 · {sessionId.slice(-8)}</span>
          <button type="button" className="ml-auto rounded-[6px] p-1" style={{ color: 'var(--text-3)' }} onClick={onClose}><X size={14} /></button>
        </div>

        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="w-full touch-none rounded-[9px]"
          style={{ background: '#101010', border: '1px solid var(--border-2)', cursor: erase ? 'cell' : 'crosshair', aspectRatio: `${W} / ${H}` }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerLeave={up}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={`wb-tool ${!erase ? 'on' : ''}`} onClick={() => setErase(false)} title="画笔"><Pencil size={13} /></button>
          <button type="button" className={`wb-tool ${erase ? 'on' : ''}`} onClick={() => setErase(true)} title="橡皮"><Eraser size={13} /></button>
          <span className="mx-1 h-4 w-px" style={{ background: 'var(--border)' }} aria-hidden />
          {COLORS.map((c) => (
            <button key={c} type="button" className={`size-4 rounded-full ${color === c && !erase ? 'wb-swatch-on' : ''}`} style={{ background: c, border: '1px solid var(--border)' }} aria-label={`颜色 ${c}`} onClick={() => { setColor(c); setErase(false) }} />
          ))}
          <input type="range" min={1} max={12} value={width} className="ml-1 w-20" onChange={(e) => setWidth(Number(e.target.value))} title="笔宽" />
          <span className="mx-1 h-4 w-px" style={{ background: 'var(--border)' }} aria-hidden />
          <button type="button" className="wb-tool" onClick={undo} title="撤销"><Undo2 size={13} /></button>
          <button type="button" className="wb-tool" onClick={redo} title="重做" disabled={redoStack.length === 0} style={{ opacity: redoStack.length ? 1 : 0.4 }}><Redo2 size={13} /></button>
          <button type="button" className="wb-tool" onClick={clear} title="清空"><Trash2 size={13} /></button>
          <button
            type="button"
            className="ml-auto rounded-[9px] px-3 py-1.5"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-xs)' }}
            onClick={() => void send()}
          >
            {sent ? '已发送 ✓' : '发送到聊天'}
          </button>
        </div>
      </div>
    </div>
  )
}
