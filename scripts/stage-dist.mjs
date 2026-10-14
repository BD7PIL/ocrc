// Stage build outputs into the install shape openchamber expects
// (manifest entry paths are package-root-relative):
//   dist/panel/index.html + main.js   ← contributes.panel.entry
//   dist/status/index.html + main.js  ← contributes.statusSection.entry
//   dist/service/main.js              ← contributes.service.entry (tsc emits here directly)
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')

const html = (title) => `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="stylesheet" href="./theme.css" />
</head>
<body>
<div id="root"></div>
<script src="./main.js"></script>
</body>
</html>
`

rmSync(join(out, 'panel'), { recursive: true, force: true })
mkdirSync(join(out, 'panel'), { recursive: true })

cpSync(join(out, 'panel-assets', 'main.js'), join(out, 'panel', 'main.js'))
writeFileSync(join(out, 'panel', 'index.html'), html('ocrc connect'))
cpSync(join(root, 'src', 'panel', 'theme.css'), join(out, 'panel', 'theme.css'))

// service: manifest entry is <root>/service/main.js; its '../shared/protocol.js'
// import resolves to <root>/shared/ — stage both at package root.
rmSync(join(root, 'shared'), { recursive: true, force: true })
if (existsSync(join(out, 'shared'))) cpSync(join(out, 'shared'), join(root, 'shared'), { recursive: true })

console.log('[stage-dist] dist/panel + dist/status + dist/service ready')
