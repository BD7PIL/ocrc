#!/usr/bin/env node
/**
 * P4b gate — amend reuses the predecessor's finished asks instead of re-running them.
 *
 * Amend is a supersede (new runId, predecessor untouched, `resumedFrom` the only link), so
 * "the revision was cheap" is only observable in the new run's journal: an imported ask
 * settles straight from the record (`node-settled { cached: true }`) and is never
 * dispatched. That is exactly what this gate reads — the same signal the panel shows.
 *
 * The predecessor's asks must be **typed** for the engine to have a schema to validate the
 * cache against, so the three actors submit through `/api/workflow/submit` (the P3 gate's
 * technique) rather than through a model.
 *
 * Stack: the P4-1 one (host :4199 + engine :4295 + stub :4300), borrowed from
 * ../p4-projection/stack.mjs. Nothing is asked of the stub model.
 *
 * GATE_KEEP=1 leaves the stack running.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL, ROOT, cleanup, json, startStack, waitFor, waitValue } from '../p4-projection/stack.mjs'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const V = 'interface V { n: number }'
/** Three typed asks, sequential — the order is what makes the cache's actorSeq indexable. */
const BASE_SCRIPT = `
${V}
const a = await agent("alpha").ask<V>("Report the first number.");
const b = await agent("beta").ask<V>("Report the second number.");
const c = await agent("gamma").ask<V>("Report the third number.");
return { a, b, c };
`
/**
 * The revision changes ONE thing: a fourth actor. The first three asks are byte-identical,
 * so their inputHash matches the cache — which is the whole point of "amend one thing".
 */
const AMENDED_SCRIPT = `
${V}
const a = await agent("alpha").ask<V>("Report the first number.");
const b = await agent("beta").ask<V>("Report the second number.");
const c = await agent("gamma").ask<V>("Report the third number.");
const d = await agent("delta").ask<V>("Report the fourth number.");
return { a, b, c, d };
`

async function main() {
  const { token, auth } = await startStack({ log: check })
  const created = await json(`${PANEL}/api/session`, {
    method: 'POST', headers: auth, body: JSON.stringify({ directory: ROOT, title: 'p4b' }),
  })
  const sessionId = created.id

  const submit = async (actorSessionId, n) =>
    await json(`${PANEL}/api/workflow/submit`, {
      method: 'POST', headers: auth, body: JSON.stringify({ sessionId: actorSessionId, payload: { n } }),
    })

  /** Drive a run of `script` to completion by answering each actor's typed ask in order. */
  async function runScript(script, values) {
    const started = await json(`${PANEL}/api/workflow/runs`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ scriptText: script, cwd: ROOT, sessionId, name: 'p4b' }),
    })
    if (!started.runId) throw new Error(`submit failed: ${JSON.stringify(started)}`)
    const runId = started.runId
    const answered = new Map()
    for (const [index, value] of values.entries()) {
      const session = await waitValue(async () => {
        const view = await json(`${PANEL}/api/workflow/runs/${runId}`, { headers: auth })
        const fresh = (view.actors ?? []).find((a) => a.sessionId && !answered.has(a.sessionId))
        return fresh?.sessionId
      }, { tries: 60, delay: 500, label: `actor ${index + 1}'s session` })
      answered.set(session, true)
      const res = await submit(session, value)
      if (res.ok !== true) throw new Error(`submit refused for ${session}: ${JSON.stringify(res)}`)
    }
    const settled = await waitValue(async () => {
      const view = await json(`${PANEL}/api/workflow/runs/${runId}`, { headers: auth })
      return ['completed', 'errored', 'stopped'].includes(view.record?.status) ? view : undefined
    }, { tries: 80, delay: 500, label: `run ${runId.slice(-8)} to settle` })
    // The projection carries what the raw rows do not (`cached`, the lifecycle phase).
    const projection = await json(`${PANEL}/api/workflow/projection/${runId}`, { headers: auth })
    return { runId, view: settled, projection: projection.run }
  }

  // ── the predecessor: three live asks ───────────────────────────────────────
  const first = await runScript(BASE_SCRIPT, [1, 2, 3])
  check('a) the predecessor completed with all three submitted values',
    first.view?.record?.status === 'completed' && first.view.record.result?.a?.n === 1 && first.view.record.result?.c?.n === 3,
    JSON.stringify(first.view?.record?.result))

  // The boundary is a backfill that happens after the exchange ends (the vendored contract
  // puts it after settlement, so a reader can catch the row in between) — wait for it rather
  // than calling a racing write a missing one.
  const boundaries = await waitValue(async () => {
    const view = await json(`${PANEL}/api/workflow/runs/${first.runId}`, { headers: auth })
    const asks = view.nodes.filter((n) => n.kind === 'ask')
    return asks.length === 3 && asks.every((n) => typeof n.messageBoundary === 'number' && n.messageBoundary > 0) ? asks : undefined
  }, { tries: 40, delay: 500, label: 'the ask boundaries' })
  check('b) the driver backfilled a messageBoundary on every finished ask',
    Boolean(boundaries),
    JSON.stringify((boundaries ?? first.view.nodes.filter((n) => n.kind === 'ask')).map((n) => [n.siteId, n.messageBoundary])))
  const firstNodes = first.view.nodes.filter((n) => n.kind === 'ask')
  check('c) the predecessor’s asks ran live (the baseline: no cache hits)',
    firstNodes.every((n) => n.status === 'completed') && (first.projection?.nodes ?? []).every((n) => n.cached !== true),
    JSON.stringify((first.projection?.nodes ?? []).map((n) => [n.siteId, n.cached])))

  // ── the revision: one more actor, the first three untouched ────────────────
  const amended = await json(`${PANEL}/api/workflow/runs/${first.runId}/amend`, {
    method: 'POST', headers: auth, body: JSON.stringify({ scriptText: AMENDED_SCRIPT }),
  })
  check('d) the amend was accepted and minted a successor', Boolean(amended.runId) && amended.runId !== first.runId, String(amended.runId ?? amended.error))

  const second = await (async () => {
    // Only the NEW actor needs an answer: the first three must settle from the cache.
    const session = await waitValue(async () => {
      const view = await json(`${PANEL}/api/workflow/runs/${amended.runId}`, { headers: auth })
      const delta = (view.actors ?? []).find((a) => a.name === 'delta' && a.sessionId)
      return delta?.sessionId
    }, { tries: 60, delay: 500, label: 'the fourth actor’s session' })
    await submit(session, 4)
    const settled = await waitValue(async () => {
      const view = await json(`${PANEL}/api/workflow/runs/${amended.runId}`, { headers: auth })
      return ['completed', 'errored', 'stopped'].includes(view.record?.status) ? view : undefined
    }, { tries: 80, delay: 500, label: 'the revision to settle' })
    const projection = await json(`${PANEL}/api/workflow/projection/${amended.runId}`, { headers: auth })
    return { view: settled, projection: projection.run }
  })()

  check('e) the revision completed with all four values',
    second.view?.record?.status === 'completed' && second.view.record.result?.a?.n === 1 && second.view.record.result?.d?.n === 4,
    JSON.stringify(second.view?.record?.result))
  check('f) the revision carries the lineage pointer',
    second.view?.record?.resumedFrom === first.runId,
    `${second.view?.record?.resumedFrom} vs ${first.runId}`)

  // ── the point: the three imported asks were NOT re-dispatched ──────────────
  const imported = (second.projection?.nodes ?? []).filter((n) => n.kind === 'ask' && n.siteId !== 'ask#4')
  const fresh = (second.projection?.nodes ?? []).filter((n) => n.siteId === 'ask#4')
  check('g) the predecessor’s asks settled as CACHE HITS in the revision',
    imported.length === 3 && imported.every((n) => n.cached === true),
    JSON.stringify(imported.map((n) => [n.siteId, n.cached])))
  check('h) the one new ask ran live (the cache is not a blanket skip)',
    fresh.length === 1 && fresh[0].cached !== true && fresh[0].phase === 'settled' && fresh[0].outcome === 'ok',
    JSON.stringify(fresh.map((n) => [n.siteId, n.cached, n.phase, n.outcome])))
  check('i) the predecessor is superseded and not resumable',
    (await json(`${PANEL}/api/workflow/projection/${first.runId}`, { headers: auth })).run?.resumable === undefined)

  // The journal is the authority for "was it dispatched": a cache hit has no dispatched
  // event in the revision's own log (the projection's `cached` flag is derived from it).
  const revisionEvents = await json(`${PANEL}/api/workflow/runs/${amended.runId}/events/v4?sessionId=${sessionId}&limit=400`, { headers: auth })
  const dispatched = revisionEvents.events
    .filter((e) => e.type === 'node-dispatched')
    .map((e) => e.payload.instance?.siteId)
  check('j) the revision dispatched only the new ask',
    dispatched.length === 1 && dispatched[0] === 'ask#4',
    JSON.stringify(dispatched))

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  writeFileSync(join(ROOT, 'results-p4b.json'), JSON.stringify(results, null, 2))
  if (passed !== results.length) process.exitCode = 1
}

const KEEP = process.env.GATE_KEEP === '1'

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => {
    if (KEEP) { console.log('GATE_KEEP=1 — stack left running'); return }
    cleanup()
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500)
  })
