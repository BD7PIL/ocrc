#!/usr/bin/env node
/**
 * P4-2 gate — the seven read faces, end to end over HTTP.
 *
 * The run this drives has NO model in the loop on purpose: a script that only reads the
 * workspace and publishes artifacts is deterministic, settles in a second, and produces
 * exactly the journal facts the seven queries are supposed to expose (world nodes with
 * ops and bodies, an artifact with versions and bytes, an event log to page).
 *
 * The stack is the P4-1 one (host :4199 + engine :4295 + stub :4300), borrowed verbatim
 * from ../p4-projection/stack.mjs; the stub model is never asked anything.
 *
 * GATE_KEEP=1 leaves the stack running.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL, REPO, ROOT, cleanup, json, startRunThrough, startStack, waitFor } from '../p4-projection/stack.mjs'

const require = createRequire(new URL('../../../web-next/', import.meta.url))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * A deterministic run: two world reads (glob + read), one git read, and a published
 * markdown artifact. No asks, so no model and no tokens.
 */
const SCRIPT = `
phase("scan");
const paths = await files.glob("src/core/workflow/*.ts");
const one = await files.read("src/core/workflow/projection.ts");
phase("publish");
await artifact.markdown("report", [
  "# workflow query gate",
  "",
  "- files: " + paths.length,
  "- first file bytes: " + one.length,
].join("\\n"), { title: "Query gate report" });
return { files: paths.length };
`

async function main() {
  // The run is started THROUGH the model tool face (the stub's plan), not over HTTP: a run
  // submitted over HTTP has no tool call, so it has no card to sit in — and the browser
  // half of this gate is about the run's pages. The script itself is model-free, so
  // nothing is asked of the stub.
  const { token, auth } = await startStack({ log: check, script: SCRIPT, name: 'p4-queries' })
  const created = await json(`${PANEL}/api/session`, {
    method: 'POST', headers: auth, body: JSON.stringify({ directory: REPO, title: 'p4-queries' }),
  })
  const sessionId = created.id
  check('a) the host created the parent session', Boolean(sessionId), String(sessionId))

  const runId = await startRunThrough(sessionId, { auth, log: check, waitForStatus: 'any' })
  check('b) the tool call started a run', Boolean(runId), String(runId))

  const settled = await waitFor(async () => {
    const body = await json(`${PANEL}/api/workflow/projection/${runId}`, { headers: auth })
    return ['completed', 'errored', 'stopped'].includes(body.run?.status)
  }, { tries: 60, delay: 500, label: 'the run to settle' })
  const projected = await json(`${PANEL}/api/workflow/projection/${runId}`, { headers: auth })
  check('c) the run settled completed', settled && projected.run.status === 'completed',
    `${projected.run?.status}${projected.run?.error ? ` — ${projected.run.error}` : ''}`)

  // ── ② the enumeration face ─────────────────────────────────────────────────
  const summaries = await json(`${PANEL}/api/workflow/runs/summaries?sessionId=${sessionId}`, { headers: auth })
  check('d) ② workflowRuns enumerates the run with a derived label',
    summaries.runs?.length === 1 && summaries.runs[0].runId === runId && summaries.runs[0].label === 'p4-queries',
    JSON.stringify(summaries.runs?.[0]))

  // ── ① the event log, paged ─────────────────────────────────────────────────
  const firstPage = await json(`${PANEL}/api/workflow/runs/${runId}/events/v4?sessionId=${sessionId}&limit=3`, { headers: auth })
  const secondPage = await json(`${PANEL}/api/workflow/runs/${runId}/events/v4?sessionId=${sessionId}&afterSequence=${firstPage.events.at(-1)?.sequence}`, { headers: auth })
  check('e) ① workflowRunEvents pages by sequence and reports hasMore',
    firstPage.events.length === 3 && firstPage.hasMore === true && secondPage.events[0]?.sequence > firstPage.events.at(-1)?.sequence,
    `page1=${firstPage.events.length} hasMore=${firstPage.hasMore} page2=${secondPage.events.length}`)
  const types = [...firstPage.events, ...secondPage.events].map((e) => e.type)
  check('f) the event log carries the boundary-C vocabulary',
    types.includes('run-started') && types.includes('node-queued') && types.includes('artifact-published'),
    types.slice(0, 8).join(','))

  // ── ⑥ the workspace transcript ─────────────────────────────────────────────
  const workspace = await json(`${PANEL}/api/workflow/runs/${runId}/workspace?sessionId=${sessionId}`, { headers: auth })
  const ops = (workspace.nodes ?? []).map((n) => n.op)
  check('g) ⑥ workflowRunWorkspace lists the world calls with their ops',
    workspace.nodes.length >= 2 && ops.includes('glob') && ops.includes('read'),
    JSON.stringify(ops))
  const globNode = workspace.nodes.find((n) => n.op === 'glob')
  check('h) a transcript row carries its args, status and summary',
    Array.isArray(globNode?.args) && globNode.status === 'completed' && globNode.summary?.resultCount > 0,
    JSON.stringify(globNode?.summary))
  check('i) transcript rows carry journal-derived timestamps',
    typeof globNode?.createdAt === 'number' && globNode.createdAt > 0 && globNode.updatedAt >= globNode.createdAt,
    `${globNode?.createdAt} → ${globNode?.updatedAt}`)

  // ── ⑦ one node's body ──────────────────────────────────────────────────────
  const nodeResult = await json(`${PANEL}/api/workflow/runs/${runId}/nodes/${encodeURIComponent(globNode.siteId)}/${globNode.ordinal}/result?sessionId=${sessionId}`, { headers: auth })
  check('j) ⑦ workflowRunNodeResult returns the body and its size',
    nodeResult.status === 'completed' && Array.isArray(nodeResult.result) && nodeResult.totalBytes > 0 && nodeResult.truncated === false,
    `bytes=${nodeResult.totalBytes} items=${Array.isArray(nodeResult.result) ? nodeResult.result.length : '?'}`)
  const bounded = await json(`${PANEL}/api/workflow/runs/${runId}/nodes/${encodeURIComponent(globNode.siteId)}/${globNode.ordinal}/result?sessionId=${sessionId}&maxBytes=64`, { headers: auth })
  check('k) a tiny maxBytes truncates shape-preservingly and says so',
    bounded.truncated === true && bounded.totalBytes === nodeResult.totalBytes,
    `truncated=${bounded.truncated} totalBytes=${bounded.totalBytes}`)

  // ── ③④⑤ artifacts ─────────────────────────────────────────────────────────
  const artifacts = await json(`${PANEL}/api/workflow/runs/${runId}/artifacts/v4?sessionId=${sessionId}`, { headers: auth })
  const report = (artifacts.artifacts ?? []).find((a) => a.id === 'report')
  check('l) ③ workflowRunArtifacts lists the artifact with its versions',
    Boolean(report) && report.kind === 'markdown' && report.versions.length === 1 && report.version === 1,
    JSON.stringify(report ? { id: report.id, kind: report.kind, version: report.version } : artifacts.artifacts))
  check('m) the artifact carries its title and byte count',
    report?.title === 'Query gate report' && report.versions[0].bytes > 0,
    `title=${report?.title} bytes=${report?.versions[0]?.bytes}`)

  const chunk = await json(`${PANEL}/api/workflow/runs/${runId}/artifacts/report/versions/1/read?sessionId=${sessionId}&offset=0&limit=32`, { headers: auth })
  const text = Buffer.from(chunk.dataBase64 ?? '', 'base64').toString('utf-8')
  check('n) ⑤ workflowRunArtifactRead returns the real bytes in blocks',
    text.startsWith('# workflow query gate') && chunk.totalBytes === report.versions[0].bytes && chunk.nextOffset === 32,
    `${JSON.stringify(text.slice(0, 28))} next=${chunk.nextOffset}`)
  // 512 KiB is the vendored block ceiling (`attachmentChunkMaxBytes`) — the route clamps
  // to it and rejects anything above, so the gate must ask within it too.
  const tail = await json(`${PANEL}/api/workflow/runs/${runId}/artifacts/report/versions/1/read?sessionId=${sessionId}&offset=${chunk.nextOffset}&limit=524288`, { headers: auth })
  check('o) the last block ends with nextOffset null',
    tail.nextOffset === null && Buffer.from(tail.dataBase64, 'base64').length === chunk.totalBytes - 32,
    `last=${Buffer.from(tail.dataBase64, 'base64').length}`)

  const board = await json(`${PANEL}/api/workflow/runs/${runId}/artifacts/report/data?sessionId=${sessionId}`, { headers: auth })
  check('p) ④ workflowRunArtifactData is empty for a markdown artifact (it is not a board)',
    Array.isArray(board.items) && board.items.length === 0 && board.hasMore === false,
    JSON.stringify(board))

  // ── the display (the tool card's static picture) ────────────────────────────
  const display = await json(`${PANEL}/api/workflow/runs/${runId}/display?sessionId=${sessionId}`, { headers: auth })
  const graph = display.display?.causalityGraph
  check('q) the tool card display carries a causality graph',
    display.display?.kind === 'create_workflow' && display.display.ok === true && graph?.steps?.length >= 2,
    `steps=${graph?.steps?.length} participants=${graph?.participants?.length} phases=${graph?.phases?.length}`)
  check('r) the graph carries the declared phase vocabulary and the world lanes',
    (graph?.phases ?? []).map((p) => p.name).includes('scan') && (graph?.lanes ?? []).length > 0,
    JSON.stringify({ phases: (graph?.phases ?? []).map((p) => p.name), lanes: (graph?.lanes ?? []).map((l) => l.id) }))

  // ── authorization: the vendored rule, over HTTP ─────────────────────────────
  const other = await fetch(`${PANEL}/api/workflow/runs/${runId}/workspace?sessionId=ses_someone_else`, { headers: auth })
  const unknown = await fetch(`${PANEL}/api/workflow/runs/dwfrun-nope/workspace?sessionId=${sessionId}`, { headers: auth })
  check('s) a query from another session is the same 404 as an unknown run',
    other.status === 404 && unknown.status === 404, `other=${other.status} unknown=${unknown.status}`)

  // ── the side pages, in the browser ─────────────────────────────────────────
  // The pane draws the static graph from the tool row's `display` (asserted above) and the
  // artifacts section from the journal; opening an artifact reads its bytes through the
  // read query. This is the part of P4-2 that only a real browser can confirm.
  const { chromium } = require('playwright')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), token)
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(`${PANEL}/z/?session=${sessionId}`, { waitUntil: 'domcontentloaded' })
  const card = page.locator(`[data-testid^="workflow-run-digest-"][data-workflow-run-id="${runId}"]`)
  const cardUp = await waitFor(async () => (await card.count()) > 0, { tries: 60, delay: 500, label: 'the run card' })
  check('t) the settled run still shows a card (the projection survives settlement)', cardUp)
  await page.locator('[data-testid="workflow-card-open-details"]').first().click()
  const pane = page.locator(`[data-workflow-run-id="${runId}"][data-workflow-run-status]`)
  await waitFor(async () => (await pane.count()) > 0, { tries: 30, label: 'the run pane' })
  check('u) the run pane opens on the completed run',
    (await pane.first().getAttribute('data-workflow-run-status')) === 'completed')

  // The graph: before this landed the pane said "当前会话的可见历史里没有这张工作流程图".
  const graphMissing = await page.locator('[data-testid="workflow-run-graph-unavailable"]').count()
  check('v) the pane draws the script graph (no “graph unavailable” notice)', graphMissing === 0,
    `workflow-run-graph-unavailable ×${graphMissing}`)

  const section = page.locator('[data-testid="workflow-run-artifacts"]')
  check('w) the artifacts section lists the published artifact',
    (await section.count()) > 0 && (await page.locator('[data-testid="workflow-run-artifact-card"]').count()) > 0)
  await page.screenshot({ path: join(ROOT, 'shots', '5-run-pane-graph-artifacts.png') })

  await page.locator('[data-testid="workflow-run-artifact-card"]').first().click()
  const artifactPane = page.locator('[data-testid="workflow-artifact-pane"][data-workflow-artifact-id="report"]')
  const paneUp = await waitFor(async () => (await artifactPane.count()) > 0, { tries: 30, delay: 500, label: 'the artifact pane' })
  check('x) clicking the artifact opens its pane', paneUp, 'workflow-artifact-pane[report]')
  // The markdown body renders inside a highlighted code block, whose text `innerText` on
  // the pane does not reach — read the block itself, and wait for it (the viewer is lazy).
  const body = artifactPane.first().locator('pre, code').first()
  const bodyUp = await waitFor(async () => ((await body.textContent()) ?? '').includes('workflow query gate'), { tries: 20, delay: 500, label: 'the artifact body' })
  const bodyText = (await body.textContent().catch(() => '')) ?? ''
  check('y) the artifact pane renders the real bytes',
    bodyUp && bodyText.includes('first file bytes'),
    JSON.stringify(bodyText.slice(0, 90)))
  await page.screenshot({ path: join(ROOT, 'shots', '6-artifact-pane.png') })

  check('z) no page errors from the run pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await ctx.close()
  browser.close()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  writeFileSync(join(ROOT, 'results-p4-2.json'), JSON.stringify(results, null, 2))
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
