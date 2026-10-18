#!/usr/bin/env node
/**
 * 面板/状态区的本地预览（开发工具，不参与发布）。
 *
 *   node scripts/preview.mjs            # 起服务并打印两个 URL
 *
 * 面板  http://127.0.0.1:5199/panel.html?scenario=mixed&theme=light
 * 状态区 http://127.0.0.1:5199/status.html?scenario=two&theme=light
 *
 * 它把真面板（真 kit、真 guest.css）挂在一个假宿主上（`preview/sdk-shim.ts` 只换掉
 * `connectHost`），所以「我截图看过了」和线上是同一套渲染。scenario 取值见
 * `preview/scenarios.ts`：empty / one / two / mixed / fresh。
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, '.preview-dist')
mkdirSync(outDir, { recursive: true })

const sdkShim = join(root, 'preview/sdk-shim.ts')

/** 只换 `@openchamber/sdk` 这一个说明符：`@openchamber/sdk/ui` 必须是真包
 *  （kit 与 applyHostReady 都得是真的，否则预览看到的不是线上那套）。 */
const sdkShimPlugin = {
  name: 'sdk-shim',
  setup(build) {
    build.onResolve({ filter: /^@openchamber\/sdk$/ }, () => ({ path: sdkShim }))
  },
}

await build({
  entryPoints: [join(root, 'preview/panel.tsx'), join(root, 'preview/status.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: outDir,
  entryNames: '[name]',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  plugins: [sdkShimPlugin],
  loader: { '.css': 'css' },
  logLevel: 'warning',
})

/** 面板页：右栏宽度 + 宿主底色；状态区页：窄栏。 */
const page = (title, body, css) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="./${body.includes('panel.js') ? 'panel' : 'status'}.css">
<style>
  html, body { margin: 0; }
  body { background: var(--oc-bg, #fff); font-family: var(--oc-font, system-ui, sans-serif); }
  ${css}
</style></head><body>${body}</body></html>`

writeFileSync(join(outDir, 'panel.html'), page('OCRC Remote · 面板预览', `
  <div class="stage"><div class="frame" id="root"></div></div>
  <script type="module" src="./panel.js"></script>`, `
  .stage { display: flex; justify-content: flex-end; padding: 16px; min-height: 100vh; box-sizing: border-box; }
  .frame { width: 640px; max-width: 100%; background: var(--oc-bg, #fff); border: 1px solid var(--interactive-border, #e2e2e6); border-radius: 12px; }
`))

writeFileSync(join(outDir, 'status.html'), page('OCRC Remote · 状态区预览', `
  <div class="stage"><div class="frame" id="root"></div></div>
  <script type="module" src="./status.js"></script>`, `
  .stage { display: flex; align-items: flex-start; justify-content: flex-start; padding: 16px; min-height: 100vh; box-sizing: border-box; }
  .frame { width: 300px; background: var(--surface-background, #fff); border: 1px solid var(--interactive-border, #e2e2e6); border-radius: 10px; }
`))

const port = Number(process.env.OCRC_PREVIEW_PORT ?? 5199)
createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const file = path === '/' ? 'panel.html' : path.replace(/^\//, '')
  try {
    const body = readFileSync(join(outDir, file))
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`面板   http://127.0.0.1:${port}/panel.html?scenario=mixed&theme=light`)
  console.log(`状态区 http://127.0.0.1:${port}/status.html?scenario=two&theme=light`)
})
