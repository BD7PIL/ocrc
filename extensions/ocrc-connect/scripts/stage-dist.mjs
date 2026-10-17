// Stage build outputs into the INSTALL shape: this package directory IS the
// openchamber install root (manifest entries are package-root-relative), so
// staged artifacts land at the package root and a fresh clone is directly
// folder-installable without any build:
//   panel/index.html + main.js   ← contributes.panel.entry
//   status/index.html + main.js  ← contributes.statusSection.entry
//   service/main.js (+ ../shared)← contributes.service.entry
// Build intermediates stay under dist/ (gitignored).
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
<link rel="stylesheet" href="./guest.css" />
</head>
<body>
<div id="root"></div>
<script src="./main.js"></script>
</body>
</html>
`

rmSync(join(root, 'panel'), { recursive: true, force: true })
rmSync(join(root, 'status'), { recursive: true, force: true })
rmSync(join(root, 'service'), { recursive: true, force: true })
mkdirSync(join(root, 'panel'), { recursive: true })
mkdirSync(join(root, 'status'), { recursive: true })

cpSync(join(out, 'panel-assets', 'main.js'), join(root, 'panel', 'main.js'))
cpSync(join(out, 'status-assets', 'main.js'), join(root, 'status', 'main.js'))
writeFileSync(join(root, 'panel', 'index.html'), html('ocrc connect'))
writeFileSync(join(root, 'status', 'index.html'), html('ocrc tunnel'))
cpSync(join(root, 'src', 'shared', 'guest.css'), join(root, 'panel', 'guest.css'))
cpSync(join(root, 'src', 'shared', 'guest.css'), join(root, 'status', 'guest.css'))

// service: manifest entry is <root>/service/main.js; its '../shared/protocol.js'
// import resolves to <root>/shared/ — stage both at package root.
mkdirSync(join(root, 'service'), { recursive: true })
rmSync(join(root, 'shared'), { recursive: true, force: true })
cpSync(join(out, 'service'), join(root, 'service'), { recursive: true })
if (existsSync(join(out, 'shared'))) cpSync(join(out, 'shared'), join(root, 'shared'), { recursive: true })

console.log('[stage-dist] panel/ + status/ + service/ + shared/ staged at package root')
