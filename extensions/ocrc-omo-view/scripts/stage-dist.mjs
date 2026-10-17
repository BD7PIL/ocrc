// Stage build outputs into the INSTALL shape: this package directory IS the
// openchamber install root, so staged artifacts land at the package root and
// a fresh clone is directly folder-installable without any build:
//   panel/index.html + main.js ← contributes.panel.entry
// Build intermediates stay under dist/ (gitignored).
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
mkdirSync(join(root, 'panel'), { recursive: true })

cpSync(join(out, 'panel-assets', 'main.js'), join(root, 'panel', 'main.js'))
writeFileSync(join(root, 'panel', 'index.html'), html('omo 编排'))
cpSync(join(root, 'src', 'shared', 'guest.css'), join(root, 'panel', 'guest.css'))

console.log('[stage-dist] panel/ staged at package root')
