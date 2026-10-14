import { useCallback, useEffect, useState } from 'react'
import { connectHost, type HostClient } from '@openchamber/sdk'
import { buildTree, countSubagents, flatten, type SessionNode, type TreeNode } from '../shared/tree.js'

interface SnapshotLike {
  state: 'loading' | 'ready' | 'error'
  sessions?: SessionNode[]
}

const ACTIVITY_LABEL: Record<string, string> = {
  running: '运行中',
  idle: '空闲',
  'waiting-permission': '等审批',
  'waiting-question': '等回答',
  retrying: '重试',
  unknown: '',
}

export function Panel() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [snap, setSnap] = useState<SnapshotLike>({ state: 'loading' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [err, setErr] = useState('')

  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    void (async () => {
      try {
        const h = connectHost()
        // HostReadyContext has no project — resolve it via listProjects by
        // matching the ready directory (the project the panel is scoped to).
        await h.onReady((ctx) => {
          if (disposed) return
          void (async () => {
            const projects = await h.listProjects()
            const dir = ctx.directory
            const project = projects.projects.find((p) => p.directory === dir) ?? projects.projects[0]
            if (!project) { setSnap({ state: 'error' }); setErr('无项目上下文'); return }
            setSnap({ state: 'loading' })
            const snap = await h.listSessions(project.id)
            if (!disposed) setSnap({ state: snap.state, sessions: snap.sessions as unknown as SessionNode[] })
            const off = await h.onSessions(project.id, (s) => { if (!disposed) setSnap({ state: s.state, sessions: s.sessions as unknown as SessionNode[] }) })
            unsubs.push(off)
          })()
        })
        if (disposed) return
        setHost(h)
      } catch (e) {
        if (!disposed) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { disposed = true; for (const off of unsubs) { try { off() } catch { /* gone */ } } }
  }, [])

  const tree: TreeNode[] = snap.state === 'ready' && snap.sessions ? buildTree(snap.sessions) : []
  const subagents = snap.sessions ? countSubagents(snap.sessions) : 0
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (err) return <div style={{ padding: 12 }} className="muted">{err}</div>
  if (snap.state !== 'ready') return <div style={{ padding: 12 }} className="muted">omo 编排：加载中…</div>
  if (tree.length === 0) return <div style={{ padding: 12 }} className="muted">本项目暂无会话。</div>
  if (subagents === 0) return <div style={{ padding: 12 }} className="muted">暂无编排会话（omo-slim 的子代理会话会在这里成树）。</div>

  return (
    <div style={{ padding: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>omo 编排</strong>
        <span className="pill">{subagents} 个子代理</span>
      </div>
      {tree.map((root) => {
        const isOrchestrator = (root.node.agent ?? '').includes('orchestrator') || root.children.length > 0
        const open = expanded.has(root.node.id) || !isOrchestrator
        return (
          <div key={root.node.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ cursor: isOrchestrator ? 'pointer' : 'default' }} onClick={() => toggle(root.node.id)}>
              <span>{isOrchestrator ? (open ? '▾' : '▸') : '·'}</span>
              <strong style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{root.node.title}</strong>
              <span className="muted">{root.node.agent ?? ''}</span>
              <span className={`pill ${root.node.activity === 'running' ? 'ok' : ''}`}>{ACTIVITY_LABEL[root.node.activity ?? ''] ?? ''}</span>
            </div>
            {open && root.children.length > 0 && (
              <div style={{ margin: '4px 0 0 20px', display: 'grid', gap: 4 }}>
                {flatten(root.children).map(({ node, depth }) => (
                  <div
                    key={node.id}
                    className="row"
                    style={{ paddingLeft: depth * 14, cursor: 'pointer' }}
                    onClick={() => void host?.openSession(node.id)}
                    title={node.title}
                  >
                    <span className="muted">└</span>
                    <span style={{ maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.title}</span>
                    <span className="pill">{node.agent ?? 'subagent'}</span>
                    <span className={`pill ${node.activity === 'running' ? 'ok' : node.outcome === 'failed' ? 'err' : ''}`}>
                      {node.activity === 'running' ? '运行中' : node.outcome === 'succeeded' ? '✓' : node.outcome === 'failed' ? '✗' : ACTIVITY_LABEL[node.activity ?? ''] ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>点击子代理跳转会话；数据只读自 openchamber 的会话快照。</div>
    </div>
  )
}
