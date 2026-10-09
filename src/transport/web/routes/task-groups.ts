import type { Hono } from 'hono'
import type { SessionState } from '../../../core/state.js'

/** N10: /z/ sidebar task groups — structure persistence (groups + membership +
 *  top-level view order). ocrc keeps the data plane in state.json (same slot
 *  pattern as pin/archive); the vendor sidebar joins these rows with session
 *  summaries client-side. Groups are GLOBAL — the sidebar already filters by
 *  workspace for display, groups are the user's own organization dimension.
 *
 *  One route, action-dispatched (same shape as settings routes):
 *    POST /api/task-groups {action:'create', title, color?}
 *                        {action:'rename', groupId, title}
 *                        {action:'color',  groupId, color}
 *                        {action:'delete', groupId}
 *                        {action:'order',  members[], topOrders[]}
 *    GET  /api/task-groups → full structure for the bridge's
 *        listGroupedTaskViewStructure. */
const GROUP_COLORS = new Set(['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'])

export function registerTaskGroups(app: Hono, state: SessionState) {
  app.get('/api/task-groups', (c) => {
    return c.json({
      groups: state.listTaskGroups(),
      members: state.listTaskGroupMembers(),
      topLevelOrders: state.listTaskGroupTopOrders(),
    })
  })
  app.post('/api/task-groups', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>
    const action = String(body.action ?? '')
    switch (action) {
      case 'create': {
        const title = String(body.title ?? '新分组').slice(0, 100) || '新分组'
        const color = GROUP_COLORS.has(body.color) ? body.color : 'gray'
        return c.json({ group: state.createTaskGroup(title, color) })
      }
      case 'rename': {
        const group = state.renameTaskGroup(String(body.groupId ?? ''), String(body.title ?? '').slice(0, 100))
        return group ? c.json({ group }) : c.json({ error: 'group not found' }, 404)
      }
      case 'color': {
        const color = String(body.color ?? '')
        if (!GROUP_COLORS.has(color)) return c.json({ error: 'bad color' }, 400)
        const group = state.updateTaskGroupColor(String(body.groupId ?? ''), color)
        return group ? c.json({ group }) : c.json({ error: 'group not found' }, 404)
      }
      case 'delete': {
        const ok = state.deleteTaskGroup(String(body.groupId ?? ''))
        return ok ? c.json({ ok: true }) : c.json({ error: 'group not found' }, 404)
      }
      case 'order': {
        const members = Array.isArray(body.members) ? body.members : []
        const topOrders = Array.isArray(body.topOrders) ? body.topOrders : []
        // Fail-fast shape validation (same discipline as patchMcpEntry): bad
        // shapes reject 400 rather than persisting garbage.
        for (const m of members) {
          if (typeof m?.groupId !== 'string' || typeof m?.taskId !== 'string' || typeof m?.workspaceKey !== 'string') {
            return c.json({ error: 'bad member shape' }, 400)
          }
        }
        for (const o of topOrders) {
          if (o?.type === 'group' && typeof o?.groupId !== 'string') return c.json({ error: 'bad order shape' }, 400)
          if (o?.type === 'task' && (typeof o?.taskId !== 'string' || typeof o?.workspaceKey !== 'string')) return c.json({ error: 'bad order shape' }, 400)
        }
        state.applyGroupedTaskView(
          members.map((m: any) => ({
            groupId: String(m.groupId),
            workspaceKey: String(m.workspaceKey),
            taskId: String(m.taskId),
            sortOrder: m.sortOrder === null || m.sortOrder === undefined ? null : Number(m.sortOrder),
            addedAt: Number(m.addedAt) || Date.now(),
          })),
          topOrders.map((o: any) => o.type === 'group'
            ? { type: 'group' as const, groupId: String(o.groupId), sortOrder: Number(o.sortOrder) || 0 }
            : { type: 'task' as const, workspaceKey: String(o.workspaceKey), taskId: String(o.taskId), sortOrder: Number(o.sortOrder) || 0 }),
        )
        return c.json({ ok: true })
      }
      default:
        return c.json({ error: 'unknown action' }, 400)
    }
  })
}
