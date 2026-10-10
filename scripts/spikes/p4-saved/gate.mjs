#!/usr/bin/env node
/**
 * P4-3 gate — the saved-workflows hub in `/z/`.
 *
 * The panel's Automations page has a second top-level tab (工作流) that lists the saved
 * workflows, launches one, and shows its run history. Three things had to line up for it
 * to work at all, and each is asserted here:
 *   - the tab is gated on the P4-0 availability bit (P4-0);
 *   - the list/meta/scope shape is the vendored one (P4-3 host + bridge);
 *   - launching goes through the same `startSavedWorkflow` command the run card uses, and
 *     the run history is read from the journal by the run's own name.
 *
 * Stack: the P4-1 one (host :4199 + engine :4295 + stub :4300), borrowed from
 * ../p4-projection/stack.mjs. The saved workflow's script is model-free, so nothing is
 * asked of the stub.
 *
 * GATE_KEEP=1 leaves the stack running.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PANEL, REPO, ROOT, cleanup, json, startStack, waitFor, waitValue } from '../p4-projection/stack.mjs'

const require = createRequire(new URL('../../../web-next/', import.meta.url))
const { chromium } = require('playwright')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Model-free again: two world reads and a published artifact, so the run settles at once. */
const SAVED_SCRIPT = `
const paths = await files.glob("src/core/workflow/*.ts");
await artifact.markdown("report", "# saved workflow run\\n\\n- files: " + paths.length, { title: "Saved run" });
return { files: paths.length };
`

async function main() {
  const { token, auth } = await startStack({ log: check })

  // Seed one saved workflow through the host API (the same shape the panel's editor writes).
  const seeded = await json(`${PANEL}/api/workflow/saved`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: 'gate-audit',
      scriptText: SAVED_SCRIPT,
      description: 'audit the workflow layer',
      whenToUse: 'before a release',
      args: [{ name: 'target', type: 'string', required: true, description: 'what to audit' }],
      cwd: REPO,
    }),
  })
  check('a) the host saved a workflow with meta and a declared argument',
    Boolean(seeded.workflow?.id) && seeded.workflow.scope === 'project',
    JSON.stringify({ id: seeded.workflow?.id, scope: seeded.workflow?.scope }))

  const list = await json(`${PANEL}/api/workflow/saved`, { headers: auth })
  check('b) the list is the vendored shape (workflows + invalid + dir)',
    Array.isArray(list.workflows) && Array.isArray(list.invalid) && typeof list.dir === 'string',
    `workflows=${list.workflows.length} dir=${list.dir}`)
  check('c) the entry carries meta, scope and args',
    list.workflows[0]?.whenToUse === 'before a release' && list.workflows[0]?.args?.target?.required === true,
    JSON.stringify(list.workflows[0]))

  const history = await json(`${PANEL}/api/workflow/saved/by-name/gate-audit/runs`, { headers: auth })
  check('d) the run history is empty before the first run', history.runs?.length === 0, JSON.stringify(history))

  // ── the browser: Automations → 工作流 tab ───────────────────────────────────
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), token)
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(`${PANEL}/z/`, { waitUntil: 'domcontentloaded' })
  const shellUp = await waitFor(async () => (await page.locator('[data-testid^="workspace-item-"]').count()) > 0, { tries: 60, delay: 500, label: 'the ZCode shell' })
  check('e) the shell renders', shellUp)

  await page.locator('[data-testid="automations-open"]').click()
  const workflowTab = page.locator('[data-testid="automations-page-tab-workflow"]')
  const tabUp = await waitFor(async () => (await workflowTab.count()) > 0, { tries: 30, delay: 500, label: 'the 工作流 tab' })
  check('f) the Automations page offers the 工作流 tab (P4-0 gate open)', tabUp)
  await workflowTab.click()
  await page.waitForTimeout(1500)

  // The card's testid is suffixed with the workflow's name (`testId(TID_WORKFLOW_CARD, name)`).
  const card = page.locator('[data-testid="workflow-card-gate-audit"]')
  const cardUp = await waitFor(async () => (await card.count()) > 0, { tries: 30, delay: 500, label: 'the saved workflow card' })
  check('g) the tab lists the saved workflow', cardUp)
  const cardText = cardUp ? await card.innerText() : ''
  check('h) the card shows the name and the description',
    cardText.includes('gate-audit') && cardText.includes('audit the workflow layer'),
    JSON.stringify(cardText.slice(0, 120)))
  await page.screenshot({ path: join(ROOT, 'shots', '7-saved-workflows.png') })

  // Launch: the card's Run opens the launch dialog (the declared argument is required, so
  // the dialog must ask for it) and submitting starts the run through the v4 command.
  await page.locator('[data-testid="workflow-card-run-gate-audit"]').click()
  const dialog = page.locator('[data-testid="workflow-launch-dialog"]')
  const dialogUp = await waitFor(async () => (await dialog.count()) > 0, { tries: 30, delay: 500, label: 'the launch dialog' })
  check('i) Run opens the launch dialog', dialogUp)
  const argInput = page.locator('[data-testid^="workflow-launch-arg"]').first()
  check('j) the dialog asks for the declared argument', (await argInput.count()) > 0)
  if ((await argInput.count()) > 0) await argInput.fill('src/core/workflow')
  await page.screenshot({ path: join(ROOT, 'shots', '8-launch-dialog.png') })
  await page.locator('[data-testid="workflow-launch-submit"]').click()

  const launched = await waitFor(async () => {
    const body = await json(`${PANEL}/api/workflow/runs/summaries?sessionId=${(await json(`${PANEL}/api/sessions`, { headers: auth })).find((s) => s.directory === REPO)?.id}`, { headers: auth }).catch(() => ({ runs: [] }))
    return (body.runs ?? []).some((r) => r.label === 'gate-audit')
  }, { tries: 40, delay: 500, label: 'a run named after the saved workflow' })
  check('k) submitting the dialog starts the run (startSavedWorkflow)', launched)

  // Run history, read by the run's own name. The run is model-free so it settles in about a
  // second — but the launch returns before that, so wait for a settled status (and for the
  // artifact chip the history row draws) instead of reading once.
  const settled = new Set(['completed', 'errored', 'stopped'])
  const after = await waitValue(async () => {
    const body = await json(`${PANEL}/api/workflow/saved/by-name/gate-audit/runs`, { headers: auth })
    const run = body.runs?.[0]
    return run && settled.has(run.status) ? body : undefined
  }, { tries: 40, delay: 500, label: 'the run history to settle' })
  check('l) the run history lists the run with its status',
    after?.runs?.[0]?.status === 'completed' && after.runs[0].name === 'gate-audit',
    JSON.stringify(after?.runs?.[0] ? { runId: after.runs[0].runId, status: after.runs[0].status } : after))
  check('m) the history row carries the run’s artifact chips',
    after?.runs?.[0]?.artifacts?.[0]?.id === 'report' && after.runs[0].artifacts[0].kind === 'markdown',
    JSON.stringify(after?.runs?.[0]?.artifacts))

  // The panel's own history view. Launching navigates to the detail page, whose history panel
  // lists one row per run (`testId(TID_WORKFLOW_RUN_ROW, runId)`) — so open the detail page if
  // the launch left us on the list.
  // Launching navigates away (the panel follows the new run), so come back to the hub: the
  // Automations page → 工作流 tab → the card → its detail view, which is where the history
  // panel lives.
  const historyRow = page.locator(`[data-testid="workflow-run-row-${after?.runs?.[0]?.runId}"]`)
  if ((await historyRow.count()) === 0) {
    await page.locator('[data-testid="automations-open"]').click()
    await page.waitForTimeout(1000)
    const tab = page.locator('[data-testid="automations-page-tab-workflow"]')
    if ((await tab.count()) > 0) await tab.click()
    await waitFor(async () => (await page.locator('[data-testid="workflow-card-gate-audit"]').count()) > 0, { tries: 30, delay: 500, label: 'the saved workflow card again' })
    await page.locator('[data-testid="workflow-card-gate-audit"]').first().click()
  }
  // The detail page's history lives behind a segmented tab (definition | history).
  const tabButtons = page.locator('[data-testid="workflow-detail-tab"] button, [data-testid="workflow-detail-tab"] [role="tab"]')
  if ((await historyRow.count()) === 0 && (await tabButtons.count()) > 1) {
    await tabButtons.last().click()
  }
  const historyShown = await waitFor(async () => (await historyRow.count()) > 0, { tries: 30, delay: 500, label: 'the detail run-history row' })
  if (!historyShown) {
    writeFileSync(join(ROOT, 'saved-hub-dom.txt'), await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).join('\n')))
  }
  check('n) the panel shows the run history row', historyShown,
    `workflow-run-row-${after?.runs?.[0]?.runId}`)
  await page.screenshot({ path: join(ROOT, 'shots', '9-saved-run-history.png') })

  check('o) moveSavedWorkflow is refused with a reason (one machine-wide store)',
    (await json(`${PANEL}/api/workflow/saved/by-name/gate-audit/move`, { method: 'POST', headers: auth })).reason === 'unsupported')
  check('p) no page errors from the saved-workflow hub', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  await ctx.close()
  browser.close()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
  writeFileSync(join(ROOT, 'results-p4-3.json'), JSON.stringify(results, null, 2))
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
