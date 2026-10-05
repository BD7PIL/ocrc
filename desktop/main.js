// desktop/main.js — ocrc Desktop thin shell (Electron, roadmap ⑥ scaffold).
//
// The shell is a WINDOW + TRAY + LAUNCH CHAIN, nothing more (PRODUCT.md 第三
// 条): it never embeds the agent runtime — on boot it ensures the daemon is
// up (`ocrc start` semantics = the supervisor's job; the shell only triggers
// it if the panel isn't already healthy), polls the panel health endpoint,
// then loads it. Close-to-tray on Windows (ZCode desktop's default), single
// instance + deep link, no auto-start setting yet (ZCode doesn't ship one
// either — backlog).
//
// NOT wired into CI/再打包: this scaffold compiles and runs only inside
// Electron (require('electron') absent under Node). It's the skeleton for
// the shell project, kept in-repo so the design stays reviewable.

const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')

const PANEL_URL = process.env.OCRC_PANEL_URL || 'http://127.0.0.1:4099'
const PANEL_PORT = Number(process.env.OCRC_WEB_PORT || 4099)
const OCRC_BIN = process.env.OCRC_BIN || 'ocrc'
const WORK_DIR = process.env.OCRC_WORK_DIR || null
const HEALTH_TIMEOUT_MS = Number(process.env.OCRC_SHELL_HEALTH_TIMEOUT || 60_000)

let win = null
let tray = null
let quitting = false

function probePanel() {
  return new Promise((resolve) => {
    const req = http.get(`${PANEL_URL}/`, { timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ensure the daemon is up: if the panel isn't healthy, trigger `ocrc start`
 *  (the supervisor adopts or spawns — the shell never runs opencode itself). */
async function ensureDaemon() {
  if (await probePanel()) return true
  if (WORK_DIR) {
    console.log(`[ocrc-shell] panel unhealthy — triggering ${OCRC_BIN} start ${WORK_DIR}`)
    spawn(OCRC_BIN, ['start', WORK_DIR], { detached: true, stdio: 'ignore' }).unref()
  }
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(500)
    if (await probePanel()) return true
  }
  return false
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    title: 'ocrc',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadURL(PANEL_URL)
  // Windows: closing the window hides to tray (ZCode desktop's default);
  // the explicit 退出 menu item sets quitting first.
  win.on('close', (e) => {
    if (!quitting && process.platform === 'win32') {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => { win = null })
}

function createTray() {
  // 16×16 transparent placeholder until a real mark is committed (no
  // invented glyphs — the 0.13.1 ruling applies to tray icons too).
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('ocrc')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开面板', click: () => { if (win) win.show(); else createWindow() } },
    { label: '新建会话', click: () => { if (win) { win.show(); win.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("ocrc:new-session"))').catch(() => {}) } } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', () => { if (win) { win.show(); win.focus() } })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
  app.whenReady().then(async () => {
    const healthy = await ensureDaemon()
    if (!healthy) {
      console.error(`[ocrc-shell] panel never became healthy at ${PANEL_URL} — exiting (the supervisor keeps the daemon; retry by reopening the shell)`)
      app.quit()
      return
    }
    createTray()
    createWindow()
    app.on('activate', () => { if (!win) createWindow() })
  })
  app.on('window-all-closed', () => {
    // macOS convention keeps the app alive; win32 handled by close-to-tray.
    if (process.platform !== 'darwin' && process.platform !== 'win32') app.quit()
  })
}
