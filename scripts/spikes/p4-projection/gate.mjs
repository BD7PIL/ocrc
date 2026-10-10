#!/usr/bin/env node
/**
 * P4-1 gate — the workflow surface as the PANEL sees it.
 *
 * P0–P3 proved the engine, the driver, the host state face and the model tool face.
 * This one proves the thing the plan called the actual gap: a workflow run is *visible*
 * in `/z/` — a card in the timeline, a pane with Stop/Resume, a row in the status panel,
 * a rail in the sidebar — and it survives a refresh (the cold snapshot carries
 * `workflowRuns`; without it the vendor's own note says a running run silently vanishes).
 *
 * Stack (see stack.mjs): ocrc host (:4199) + an engine (:4295) with the ocrc plugin
 * installed (ATTACHED) + a scripted stub model (:4300) + the web-next build the host
 * serves. Nothing here touches the user's engine (:4096) or a running ocrc; every child
 * env blanks the Telegram credentials.
 *
 * GATE_KEEP=1 leaves the stack running for poking at the page by hand.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL, P, REPO, ROOT, SHOTS, cleanup, json, startRunThrough, startStack, waitFor } from './stack.mjs'

const require = createRequire(new URL('../../../web-next/', import.meta.url))
const { chromium } = require('playwright')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const { token, auth } = await startStack({ log: check })

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${P.cdp}`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), token)
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(`${PANEL}/z/`, { waitUntil: 'domcontentloaded' })
  // The sidebar is the app's own signal that services are wired.
  const workspaceItem = page.locator('[data-testid^="workspace-item-"]').first()
  const shellUp = await waitFor(async () => (await workspaceItem.count()) > 0, { tries: 60, delay: 500, label: 'the ZCode shell' })
  check('d) /z/ renders the ZCode shell on ocrc services', shellUp, pageErrors.slice(0, 2).join(' | '))

  // The parent session is created through the HOST's API rather than by clicking the
  // panel's 「新建任务」: the click's session materialization is the vendor's business and
  // its timing is not ours to assert on. What this gate is about is the run's visible
  // surface, and for that the session only has to be the one the panel opens.
  const created = await json(`${PANEL}/api/session`, {
    method: 'POST', headers: auth, body: JSON.stringify({ directory: REPO, title: 'p4-parent' }),
  })
  const sessionId = created.id
  check('e) the host created the parent session', Boolean(sessionId), String(sessionId))

  const runId = await startRunThrough(sessionId, { auth, log: check })
  check('f) the tool call started a live run', Boolean(runId), String(runId))

  const projection = await json(`${PANEL}/api/workflow/projection?sessionId=${sessionId}`, { headers: auth })
  check('g) the host recorded the run→tool-call join', Boolean(projection.joins?.[runId]?.messageId), JSON.stringify(projection.joins?.[runId]))
  // The node table fills in as the actor's ask moves; wait for it rather than reading
  // once and calling a slow first event a failure.
  const liveNode = await waitFor(async () => {
    const p = await json(`${PANEL}/api/workflow/projection?sessionId=${sessionId}`, { headers: auth })
    const run = (p.runs ?? []).find((r) => r.runId === runId)
    return (run?.nodes ?? []).length > 0 && (run?.phaseNames ?? []).includes('collect')
  }, { tries: 20, label: 'a projected node + the declared phase table' })
  check('h) the projection carries the declared phase table and a live node', liveNode)

  // Activate the session by deep link rather than by clicking its sidebar row: the row
  // is the vendor's (it joins a client-side task index with the sessions-index), and the
  // assertions below are about the conversation, not about that index.
  await page.goto(`${PANEL}/z/?session=${sessionId}`, { waitUntil: 'domcontentloaded' })
  const taskItem = `[data-testid="task-item-${sessionId}"]`
  const rowAppeared = await waitFor(async () => (await page.locator(taskItem).count()) > 0, { tries: 40, delay: 500, label: 'the session row in the sidebar' })
  check('i) the session has a sidebar row', rowAppeared)
  // The rail: this session has a LIVE run, so its row draws one. A settled run folds
  // away (the vendor acknowledges it as soon as the row is active) — which is why the
  // hold in the stub model is long enough to cover this whole page.
  const rail = await waitFor(async () => (await page.locator('[data-workflow-run-rail]').count()) > 0, { tries: 20, delay: 500, label: 'the sidebar rail' })
  check('j) the sidebar rail appears for the running session', rail, 'data-workflow-run-rail')
  await page.waitForTimeout(2500)
  // The card the user actually sees is the turn-tail run digest: the vendor folds tool
  // rows into the 「已处理」 group, so the run's visible card is the digest section at the
  // turn tail — and its testid embeds the resolved toolCallId, which is exactly the join
  // this gate is checking (`workflow-run-digest-<turn>-tool-<partId>`).
  const card = page.locator(`[data-testid^="workflow-run-digest-"][data-workflow-run-id="${runId}"]`)
  check('k) the timeline shows the run card joined to its tool call',
    (await card.count()) > 0, `workflow-run-digest*[data-workflow-run-id=${runId}]`)
  await page.screenshot({ path: join(SHOTS, '1-timeline-card.png') })

  // The status panel's Workflows section, read at the level that is actually ours.
  //
  // Three readings of the same fact, each failing differently:
  //   - the composer badge counts the run as workflow background work (our
  //     `backgroundWorks` entry, workId ≡ runId, made it through the snapshot);
  //   - the panel's own model counts it (`data-running-workflow-count` — that attribute
  //     IS the join of `workflowRuns` with `backgroundWorks`);
  //   - the section header exists in the panel (the section renders at all).
  //
  // NOT asserted: the section's expanded body. The panel opens in its mini variant,
  // where the body is not laid out at all (the trigger is in the DOM with
  // `data-state="closed"` but not visible, and Playwright cannot click it even forced) —
  // expanding it is the vendor's disclosure widget, not our data. The row's testid is
  // `v4-background-work-item-<workId>`, so this is where it would appear.
  const badgeCount = await page.locator('[data-testid="v4-composer-background-work-trigger"]').getAttribute('data-background-workflow-count')
  const panel = page.locator('[data-testid="chat-summary-panel"]')
  const modelCount = await panel.getAttribute('data-running-workflow-count').catch(() => null)
  const sectionPresent = (await panel.locator('[data-status-section-trigger="workflow"]').count()) > 0
  check('l) the status panel counts the run in its Workflows section',
    badgeCount === '1' && modelCount === '1' && sectionPresent,
    `badge=${badgeCount} panelModel=${modelCount} section=${sectionPresent}`)

  // ── cold snapshot: a refresh must not lose the running run ──────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const survived = (await page.locator(`[data-testid^="workflow-run-digest-"][data-workflow-run-id="${runId}"]`).count()) > 0
  check('m) a refresh keeps the running run (cold snapshot carries workflowRuns)', survived)

  // ── the run pane: open, Stop, Resume ────────────────────────────────────────
  await page.locator('[data-testid="workflow-card-open-details"]').first().click()
  const pane = page.locator(`[data-workflow-run-id="${runId}"][data-workflow-run-status]`)
  await waitFor(async () => (await pane.count()) > 0, { tries: 30, label: 'the run pane' })
  const statusOf = async () => await pane.first().getAttribute('data-workflow-run-status')
  check('n) clicking the card opens the run pane in the running state',
    (await statusOf()) === 'running', String(await statusOf()))
  check('o) the pane offers Stop for a live run',
    (await page.locator('[data-testid="workflow-run-cancel"]').count()) > 0)
  // The 「配置」 entry is gated on the P4-0 availability bit — its presence is the
  // end-to-end proof that the dynamic-workflow gate resolves to enabled.
  check('p) the P4-0 availability gate is open (Configure is offered)',
    (await page.locator('[data-testid="workflow-run-configure"]').count()) > 0)
  await page.screenshot({ path: join(SHOTS, '2-run-pane-running.png') })


  await page.locator('[data-testid="workflow-run-cancel"]').click()
  const stopped = await waitFor(async () => (await statusOf()) === 'stopped', { tries: 40, delay: 500, label: 'the run to stop' })
  check('v) Stop cancels the run through the v4 command', stopped, String(await statusOf()))
  // Resume lives in the pane's status header and appears only from the projection's own
  // `resumable` bit — the panel never derives it from status + failure code.
  const resumable = await waitFor(async () => (await page.locator('[data-testid="workflow-run-resume"]').count()) > 0, { tries: 30, delay: 500, label: 'Resume' })
  check('w) the stopped run offers Resume (the projection says resumable)', resumable)
  await page.screenshot({ path: join(SHOTS, '3-run-pane-stopped.png') })

  await page.locator('[data-testid="workflow-run-resume"]').click()
  const resumed = await waitFor(async () => (await statusOf()) === 'running', { tries: 60, delay: 500, label: 'the run to resume' })
  check('x) Resume restarts the run', resumed, String(await statusOf()))
  await page.screenshot({ path: join(SHOTS, '4-run-pane-resumed.png') })

  // P4-2 的 actor 侧页：它的入口是 run 面板里**在飞 ask 的花名册**药丸（终态 run 没有花名册），
  // 所以只有活着的 run 才点得到——这里正是唯一能验它的地方。
  const paneScope = `[data-workflow-run-id="${runId}"][data-workflow-run-status]`
  const rosterPill = page.locator(`${paneScope} [data-testid="workflow-agent-pill"][data-agent-open="true"]`).first()
  const pillOpenable = (await rosterPill.count()) > 0
  const titlesBefore = await page.locator('[data-testid="v4-session-title"]').count()
  if (pillOpenable) await rosterPill.click()
  const actorPane = await waitFor(async () => {
    if ((await page.locator('[data-testid="workflow-actor-not-started"]').count()) > 0) return true
    return (await page.locator('[data-testid="v4-session-title"]').count()) > titlesBefore
  }, { tries: 25, delay: 500, label: 'the actor side page' })
  check('u) the actor side page opens from the live run pane', pillOpenable && actorPane,
    `rosterPill=${pillOpenable} pane=${actorPane}`)
  await page.screenshot({ path: join(SHOTS, '5-actor-pane.png') })
  check('y) no page errors from the workflow surface', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  await ctx.close()
  browser.close()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  writeFileSync(join(ROOT, 'results.json'), JSON.stringify(results, null, 2))
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
