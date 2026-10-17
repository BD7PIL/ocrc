import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { RiArrowDownSLine, RiArrowRightSLine, RiCornerDownRightLine } from '@remixicon/react'
import { connectThemedHost } from '../shared/host-theme.js'
import { KitBadge, KitButton, KitEmpty, KitSpinner } from '../shared/kit.js'
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

/** What one tree node is doing, in one phrase ('' = nothing worth a badge).
 *  `outcome` is the host's vocabulary: `completed | failed | null`. */
function activityLabel(node: SessionNode): string {
  if (node.activity === 'running') return '运行中'
  if (node.outcome === 'completed') return '已完成'
  if (node.outcome === 'failed') return '失败'
  return ACTIVITY_LABEL[node.activity ?? ''] ?? ''
}

/** One tree row. A real `<button>` with the kit's row classes — the host's own
 *  row look with the semantics a clickable `<div>` never had (tab stop, Enter,
 *  `aria-selected`). */
function TreeRow(props: { depth: number; selected?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="oc-sdk oc-sdk-row"
      aria-selected={props.selected ? 'true' : 'false'}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function Panel() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [snap, setSnap] = useState<SnapshotLike>({ state: 'loading' })
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [err, setErr] = useState('')
  /** The session the `ocrc-omo-inspect` action ran on, when the panel was
   *  opened from a session menu rather than the rail icon. */
  const [focus, setFocus] = useState<string | null>(null)
  const boundDir = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    const h = (() => {
      try { return connectThemedHost() } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return null
      }
    })()
    if (!h) return

    let offSessions: (() => void) | null = null

    /** (Re)bind the session feed to one project. Called for the directory the
     *  host reports now and again on every project switch — the panel has to
     *  follow the user instead of freezing on whichever project was open at
     *  load. */
    const bind = async (directory: string | null) => {
      if (disposed || boundDir.current === directory) return
      boundDir.current = directory
      offSessions?.()
      offSessions = null
      setSnap({ state: 'loading' })
      try {
        const projects = await h.listProjects()
        const project = projects.projects.find((p) => p.directory === directory) ?? projects.projects[0]
        if (!project) {
          setSnap({ state: 'error' })
          setErr('无项目上下文——先在 openchamber 里打开一个项目。')
          return
        }
        if (disposed) return
        const snapshot = await h.listSessions(project.id)
        if (disposed) return
        setSnap({ state: snapshot.state, sessions: snapshot.sessions as unknown as SessionNode[] })
        const off = await h.onSessions(project.id, (s) => {
          if (!disposed) setSnap({ state: s.state, sessions: s.sessions as unknown as SessionNode[] })
        })
        offSessions = off
      } catch (e) {
        if (!disposed) { setSnap({ state: 'error' }); setErr(e instanceof Error ? e.message : String(e)) }
      }
    }

    unsubs.push(h.onReady((ctx) => { void bind(ctx.directory) }))
    unsubs.push(h.onDirectory((directory) => { boundDir.current = undefined; void bind(directory) }))
    unsubs.push(h.onItem((item) => {
      // The action carries the session it ran on; the tree then marks it, so
      // "查看编排" lands on the node the user pointed at.
      if (item && 'sessionId' in item && typeof item.sessionId === 'string') setFocus(item.sessionId)
    }))
    setHost(h)

    return () => {
      disposed = true
      offSessions?.()
      for (const off of unsubs) { try { off() } catch { /* gone */ } }
    }
  }, [])

  const tree: TreeNode[] = snap.state === 'ready' && snap.sessions ? buildTree(snap.sessions) : []
  const subagents = snap.sessions ? countSubagents(snap.sessions) : 0
  // Opt-out, not opt-in: the tree is the whole point of this panel, so an
  // orchestrator arrives expanded and the user collapses what they are done
  // reading.
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // A focused session is inside exactly one root; open that root so the mark
  // is visible without a click.
  const rootsWithFocus = new Set<string>()
  if (focus) {
    for (const root of tree) {
      if (root.node.id === focus || flatten(root.children).some(({ node }) => node.id === focus)) rootsWithFocus.add(root.node.id)
    }
  }

  if (err) {
    return (
      <div className="oc-page">
        <KitEmpty title="未能读取会话快照" body={err} />
      </div>
    )
  }

  if (snap.state !== 'ready') {
    return (
      <div className="oc-page">
        <KitSpinner label="读取会话快照…" />
      </div>
    )
  }

  if (tree.length === 0) {
    return (
      <div className="oc-page">
        <KitEmpty title="本项目暂无会话" body="新建一个会话后，omo-slim 编排出的子代理会在这里成树。" />
      </div>
    )
  }

  if (subagents === 0) {
    return (
      <div className="oc-page">
        <KitEmpty title="暂无编排会话" body="omo-slim 的子代理会话会在这里成树——它们带 parentId（fork 出来的子会话）。" />
      </div>
    )
  }

  return (
    <div className="oc-page">
      <div className="oc-row">
        <strong>omo 编排</strong>
        <KitBadge label={`${subagents} 个子代理`} tone="primary" />
        <span className="oc-push" />
        <KitButton
          label={collapsed.size > 0 ? '全部展开' : '全部收起'}
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(collapsed.size > 0 ? new Set() : new Set(tree.filter((r) => r.children.length > 0).map((r) => r.node.id)))}
        />
      </div>

      {tree.map((root) => {
        const isOrchestrator = root.children.length > 0
        const open = !collapsed.has(root.node.id) || rootsWithFocus.has(root.node.id)
        return (
          <div key={root.node.id} className="oc-col" style={{ gap: 1 }}>
            <TreeRow
              depth={0}
              selected={focus === root.node.id}
              title={root.node.title}
              onClick={() => (isOrchestrator ? toggle(root.node.id) : void host?.openSession(root.node.id))}
            >
              {isOrchestrator
                ? <span className="oc-icon oc-sdk-muted">{open ? <RiArrowDownSLine size={16} /> : <RiArrowRightSLine size={16} />}</span>
                : <span className="oc-icon oc-sdk-muted">·</span>}
              <span className="oc-sdk-row-main">
                <span className="oc-sdk-row-title">{root.node.title}</span>
              </span>
              <KitBadge
                label={activityLabel(root.node)}
                tone={root.node.activity === 'running' ? 'success' : 'neutral'}
              />
            </TreeRow>

            {open && flatten(root.children).map(({ node, depth }) => (
              <TreeRow
                key={node.id}
                depth={depth + 1}
                selected={focus === node.id}
                title={node.title}
                onClick={() => void host?.openSession(node.id)}
              >
                <span className="oc-icon oc-sdk-muted"><RiCornerDownRightLine size={14} /></span>
                <span className="oc-sdk-row-main">
                  <span className="oc-sdk-row-title">{node.title}</span>
                </span>
                <KitBadge
                  label={activityLabel(node)}
                  tone={node.activity === 'running' ? 'success' : node.outcome === 'failed' ? 'error' : node.outcome === 'completed' ? 'info' : 'neutral'}
                />
              </TreeRow>
            ))}
          </div>
        )
      })}

      <div className="oc-sdk-muted oc-xs">点击行跳转会话；数据只读自 openchamber 的会话快照。</div>
    </div>
  )
}
