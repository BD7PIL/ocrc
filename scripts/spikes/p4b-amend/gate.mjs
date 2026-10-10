#!/usr/bin/env node
/**
 * P4b gate — amend reuses the predecessor's finished asks instead of re-running them, and
 * seeds the diverging actor's session from the predecessor's transcript.
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
 * The revision adds a second ask to an actor that already has one, which is the only shape
 * that produces a seed: the engine's `ImportedActorState.seed()` is undefined at
 * `consumed === 0`, so a brand-new actor never seeds. Checks k–n then read the *copy*: the
 * diverging actor's session must open with the predecessor's transcript prefix, by content
 * (a copy re-mints every message id — that is the whole point of the vendored count offset).
 *
 * Stack: the P4-1 one (host :4199 + engine :4295 + stub :4300), borrowed from
 * ../p4-projection/stack.mjs. Nothing is asked of the stub model.
 *
 * GATE_KEEP=1 leaves the stack running.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL, ROOT, cleanup, json, startStack, waitFor, waitValue } from '../p4-projection/stack.mjs'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const V = 'interface V { n: number }'
/**
 * Three typed asks, sequential — the order is what makes the cache's actorSeq indexable.
 *
 * `alpha` is bound to a handle and keeps it for the whole script: a second `agent("alpha")`
 * is a *different* actor with the same name, which the engine refuses
 * (`DuplicateActorName`), and it is the same handle that lets the revision add a second ask
 * to an actor that already has one.
 */
const BASE_SCRIPT = `
${V}
const alpha = agent("alpha");
const a = await alpha.ask<V>("Report the first number.");
const b = await agent("beta").ask<V>("Report the second number.");
const c = await agent("gamma").ask<V>("Report the third number.");
return { a, b, c };
`
/**
 * The revision changes two things: a fourth ask, and a *second* ask for an actor that
 * already has one. The first three asks are byte-identical, so their inputHash matches the
 * cache — which is the whole point of "amend one thing".
 *
 * The second `alpha` ask is load-bearing for the transcript seeding: an actor only gets a
 * seed once it has *consumed* an imported ask and then diverges (the engine's
 * `ImportedActorState.seed()` is undefined at `consumed === 0`). A brand-new actor never
 * seeds — so `delta` alone would prove nothing about seeding.
 */
const AMENDED_SCRIPT = `
${V}
const alpha = agent("alpha");
const a = await alpha.ask<V>("Report the first number.");
const b = await agent("beta").ask<V>("Report the second number.");
const c = await agent("gamma").ask<V>("Report the third number.");
const d = await agent("delta").ask<V>("Report the fourth number.");
const a2 = await alpha.ask<V>("Now report a fifth number.");
return { a, b, c, d, a2 };
`

/** The host's own boundaries (journal.ts `AskBoundary`) — one JSONL line per ask, and a
 *  re-measure appends another. The *last* line per instance is the journal's own reading,
 *  so the helper keeps the same rule rather than taking whichever line comes first. */
function askBoundaries(runId) {
  const file = join(ROOT, 'home', '.ocrc', 'workflows', 'runs', `${runId}.jsonl`)
  const latest = new Map()
  try {
    for (const raw of readFileSync(file, 'utf-8').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      if (parsed.k !== 'ask-boundary') continue
      latest.set(`${parsed.boundary.siteId}#${parsed.boundary.ordinal}`, parsed.boundary)
    }
  } catch { /* no journal yet */ }
  return [...latest.values()]
}

/**
 * A session's transcript, oldest first, as **content signatures**.
 *
 * Not message ids: the whole point of the vendored count offset is that a copy re-mints
 * every id ("count 的关键性质是前缀复制下不变：把源会话前 N 条消息复制进一个新会话，消息 id
 * 全变而 count 不变"). Comparing ids across a fork would compare exactly the thing the copy
 * is allowed to change, so the prefix check has to look at what the cards say.
 */
async function transcript(sessionId, auth) {
  const body = await json(`${PANEL}/api/session/${encodeURIComponent(sessionId)}?limit=200`, { headers: auth })
  return (body.cards ?? []).map((c) => {
    const blocks = Array.isArray(c.blocks)
      ? c.blocks.map((b) => `${b.type}:${String(b.text ?? b.args ?? '').slice(0, 120)}`).join('~')
      : ''
    return `${c.kind}|${String(c.text ?? '').slice(0, 160)}|${blocks}`
  })
}

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
      // The actor row lands when its session is minted, a beat before the ask is actually
      // dispatched, so a single submit can arrive too early and be refused.
      const ok = await waitValue(async () => {
        const res = await submit(session, value)
        return res.ok === true ? true : undefined
      }, { tries: 40, delay: 250, label: `the submit for actor ${index + 1}` })
      if (!ok) throw new Error(`submit refused for ${session}`)
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

  // The boundary is written twice: provisionally when a typed ask's value is accepted, and
  // authoritatively at the actor's turn end — the vendored contract defines it over the
  // *complete* exchange, "repair / nudge rounds and the wrap-up messages after the submit
  // included". The turn end routinely arrives after the run is terminal (a typed ask
  // settles at accept; the model keeps producing cards after that), and a real amend is
  // made once the actor has gone quiet. So the gate waits for the final number the same
  // way: every finished ask's boundary equals its actor session's length *now*.
  const boundaries = await waitValue(async () => {
    const view = await json(`${PANEL}/api/workflow/runs/${first.runId}`, { headers: auth })
    const asks = view.nodes.filter((n) => n.kind === 'ask')
    if (asks.length !== 3) return undefined
    const measured = await Promise.all(asks.map(async (n) => {
      const actor = (view.actors ?? []).find((a) => a.siteId === n.actorSiteId && a.ordinal === n.actorOrdinal)
      if (!actor?.sessionId) return undefined
      const ids = await transcript(actor.sessionId, auth)
      return n.messageBoundary === ids.length && ids.length > 0 ? { siteId: n.siteId, messageBoundary: n.messageBoundary, tx: ids.length } : undefined
    }))
    return measured.every(Boolean) ? measured : undefined
  }, { tries: 60, delay: 500, label: 'the final ask boundaries' })
  check('b) every finished ask’s messageBoundary is its session’s real length',
    Boolean(boundaries),
    JSON.stringify(boundaries ?? first.view.nodes.filter((n) => n.kind === 'ask').map((n) => [n.siteId, n.messageBoundary])))
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
    // Only the NEW asks need an answer: the first three must settle from the cache. Both
    // waiters must run *concurrently* — a typed ask whose turn ends without a submit fails
    // the run, and the run never reaches the second new ask, so waiting for both sessions
    // before submitting either deadlocks the gate (it did, the first time).
    // `alpha`'s session is the seeded one: it only exists once its second ask is dispatched.
    await Promise.all([['delta', 4], ['alpha', 5]].map(([name, value]) => waitValue(async () => {
      const view = await json(`${PANEL}/api/workflow/runs/${amended.runId}`, { headers: auth })
      const actor = (view.actors ?? []).find((a) => a.name === name && a.sessionId)
      if (!actor) return undefined
      const res = await submit(actor.sessionId, value)
      return res.ok === true ? true : undefined
    }, { tries: 120, delay: 250, label: `the submit for ${name}` })))
    const settled = await waitValue(async () => {
      const view = await json(`${PANEL}/api/workflow/runs/${amended.runId}`, { headers: auth })
      return ['completed', 'errored', 'stopped'].includes(view.record?.status) ? view : undefined
    }, { tries: 80, delay: 500, label: 'the revision to settle' })
    const projection = await json(`${PANEL}/api/workflow/projection/${amended.runId}`, { headers: auth })
    return { view: settled, projection: projection.run, actors: settled?.actors ?? [] }
  })()

  check('e) the revision completed with all five values',
    second.view?.record?.status === 'completed' && second.view.record.result?.a?.n === 1
      && second.view.record.result?.d?.n === 4 && second.view.record.result?.a2?.n === 5,
    JSON.stringify(second.view?.record?.result))
  check('f) the revision carries the lineage pointer',
    second.view?.record?.resumedFrom === first.runId,
    `${second.view?.record?.resumedFrom} vs ${first.runId}`)

  // ── the point: the three imported asks were NOT re-dispatched ──────────────
  const imported = (second.projection?.nodes ?? []).filter((n) => n.kind === 'ask' && !['ask#4', 'ask#5'].includes(n.siteId))
  const fresh = (second.projection?.nodes ?? []).filter((n) => ['ask#4', 'ask#5'].includes(n.siteId))
  check('g) the predecessor’s asks settled as CACHE HITS in the revision',
    imported.length === 3 && imported.every((n) => n.cached === true),
    JSON.stringify(imported.map((n) => [n.siteId, n.cached])))
  check('h) the two new asks ran live (the cache is not a blanket skip)',
    fresh.length === 2 && fresh.every((n) => n.cached !== true && n.phase === 'settled' && n.outcome === 'ok'),
    JSON.stringify(fresh.map((n) => [n.siteId, n.cached, n.phase, n.outcome])))
  check('i) the predecessor is superseded and not resumable',
    (await json(`${PANEL}/api/workflow/projection/${first.runId}`, { headers: auth })).run?.resumable === undefined)

  // The journal is the authority for "was it dispatched": a cache hit has no dispatched
  // event in the revision's own log (the projection's `cached` flag is derived from it).
  const revisionEvents = await json(`${PANEL}/api/workflow/runs/${amended.runId}/events/v4?sessionId=${sessionId}&limit=400`, { headers: auth })
  const dispatched = revisionEvents.events
    .filter((e) => e.type === 'node-dispatched')
    .map((e) => e.payload.instance?.siteId)
  check('j) the revision dispatched only the two new asks',
    dispatched.length === 2 && dispatched.every((id) => id === 'ask#4' || id === 'ask#5'),
    JSON.stringify(dispatched))

  // ── P2: the diverging actor inherits the predecessor's transcript ──────────
  // The boundary is a count in *our* units (a card), so the check is two-sided: the count
  // must equal the source transcript's real length (P1 — under the engine's default page it
  // would have read 50), and the copy must reproduce exactly that prefix.
  const alphabet = (first.view.actors ?? []).find((a) => a.name === 'alpha')
  const revisionAlpha = (second.actors ?? []).find((a) => a.name === 'alpha')
  const boundaryLine = askBoundaries(first.runId).find((b) => b.siteId === 'ask#1')
  const before = alphabet ? await transcript(alphabet.sessionId, auth) : []
  // `messageId` is an engine id, and the signature list is cards — the boundary names the
  // *last* message of its prefix, which is what the last card's `__messageId` is. The
  // count is the contract; the id is what a fork has to be pointed at.
  const boundaryIsReal = boundaryLine?.count === before.length && typeof boundaryLine?.messageId === 'string'

  check('k) the predecessor journaled a boundary with both a count and a message id',
    boundaryIsReal,
    `line=${JSON.stringify(boundaryLine)} transcript=${before.length}`)

  check('l) the diverging actor got a NEW session (the seed is a copy, never a re-attach)',
    Boolean(revisionAlpha?.sessionId) && revisionAlpha.sessionId !== alphabet?.sessionId,
    `${alphabet?.sessionId?.slice(-8)} → ${revisionAlpha?.sessionId?.slice(-8)}`)

  const forked = revisionAlpha ? await transcript(revisionAlpha.sessionId, auth) : []
  // What the fork copies at `messageID` — inclusive of that message or not — is the
  // engine's semantics, not ours, so the gate measures it rather than assuming it:
  // `prefix` is how many of the source's leading cards came back, by content.
  const prefix = (() => {
    let n = 0
    while (n < forked.length && n < before.length && forked[n] === before[n]) n += 1
    return n
  })()
  const boundary = boundaryLine?.count ?? 0
  // The engine's cut is exclusive of the message it is pointed at (measured: a 6-message
  // session forked at message[3] comes back with 3), while our boundary names the last
  // message *inside* the prefix — so the driver points the fork at the next message, and
  // the seeded session must hold the whole prefix. `prefix === boundary` is that claim.
  const prefixExact = prefix >= boundary && boundary > 0
  check('m) the seeded session holds the predecessor’s whole transcript prefix',
    prefixExact,
    `prefix=${prefix} boundary=${boundary} source=${before.length} forked=${forked.length}`)
  // The copied run must be a prefix, not a set: whatever the fork adds after the boundary
  // is the new ask, so a divergence inside the copied region would mean the copy is not the
  // predecessor's conversation at all.
  check('n) the copied region is the source’s leading cards, in order',
    prefix >= 1 && forked.slice(0, prefix).every((sig, i) => sig === before[i]),
    `prefix=${prefix} first=${JSON.stringify(forked[0]?.slice(0, 40))} sourceFirst=${JSON.stringify(before[0]?.slice(0, 40))}`)

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  console.log(`  (fork cut: exclusive at the named message — the driver points it one message past the boundary, so the copy is ${prefix} of ${boundary} units)`)
  writeFileSync(join(ROOT, 'results-p4b.json'), JSON.stringify({ results, prefixExact, prefix, boundary }, null, 2))
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
