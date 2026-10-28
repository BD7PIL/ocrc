#!/usr/bin/env node
// Guest-bundle invariants for the panel-side extensions.
//
// Every check here pins a defect that shipped and that no unit test could see,
// because each one only happens inside openchamber's sandboxed guest frame:
//
//   * `process.env.NODE_ENV` survives vite's lib mode. The frame has no Node
//     globals, so React's dev/prod branch throws on load and the frame renders
//     nothing — blank panels from batch 2 until batch 6.
//   * A frame that never reaches `applyHostReady` gets no theme tokens at all,
//     so it paints whatever palette it shipped with instead of the host's.
//   * `window.prompt` is ignored in the sandbox (no `allow-modals`) and returns
//     null without a word: 添加档案 / + 根目录 / 提交信息 all silently did
//     nothing.
//
// The shared trio is also compared byte-for-byte across the two extensions.
// Two copies that drift is how this repository ended up with five identical
// `theme.css` files, each one a frozen copy of a palette the shell had moved on
// from.
//
// Usage: node scripts/check-guest-bundles.mjs   (from the repository root)

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Bundle paths relative to the extension root, and the extension's own root. */
const EXTENSIONS = [
  { name: 'ocrc', root: join(root, 'extensions', 'ocrc'), bundles: ['panel/main.js', 'status/main.js'] },
]

/** Files that must be identical wherever they are copied. */
const SHARED = ['src/shared/host-theme.ts', 'src/shared/kit.tsx', 'src/shared/guest.css']

const failures = []
const fail = (what, detail) => failures.push(`${what}: ${detail}`)

for (const ext of EXTENSIONS) {
  for (const rel of ext.bundles) {
    const file = join(ext.root, rel)
    if (!existsSync(file)) {
      fail(`${ext.name}/${rel}`, 'missing — run npm run build in the extension')
      continue
    }
    const js = readFileSync(file, 'utf8')

    if (/process\.env/.test(js)) {
      fail(`${ext.name}/${rel}`, 'contains process.env — the guest frame has no Node globals (add `define` to the vite config)')
    }
    if (/\bwindow\.(prompt|confirm|alert)\s*\(|\bprompt\s*\(/.test(js)) {
      fail(`${ext.name}/${rel}`, 'contains window.prompt/confirm/alert — the sandbox ignores them and returns null')
    }
    // `applyHostReady` itself is minified away; what survives is the dataset
    // write it performs, which is the thing the host reads back.
    if (!js.includes('ocSurface')) {
      fail(`${ext.name}/${rel}`, 'no theme bridge — the frame never calls applyHostReady (see src/shared/host-theme.ts)')
    }
    // The kit injects its own stylesheet under this id on first mount — so a
    // frame that mounts kit primitives (each one renders the `oc-kit` wrapper)
    // must carry it, or they render unstyled. A frame that mounts none is not
    // covered: the status rail is a read-only readout (plain markup + host
    // tokens, no controls), so it legitimately has no stylesheet. Testing for
    // `oc-sdk-` instead does not work — `applyHostReady` ships that prefix in
    // its own token/stylesheet text whether or not anything is mounted.
    if (js.includes('oc-kit') && !js.includes('oc-sdk-ui-style')) {
      fail(`${ext.name}/${rel}`, 'mounts kit primitives (oc-kit) but has no kit stylesheet — they would be unstyled')
    }
    if (!js.includes('--surface-background')) {
      fail(`${ext.name}/${rel}`, 'no host token table — expected the applyHostReady token list in the bundle')
    }

    // The staged HTML decides whether the page chrome loads at all.
    const html = join(ext.root, rel.replace(/main\.js$/, 'index.html'))
    const markup = existsSync(html) ? readFileSync(html, 'utf8') : ''
    if (!markup.includes('./guest.css')) {
      fail(`${ext.name}/${rel}`, 'staged index.html does not link ./guest.css')
    }
  }
}

// One stylesheet per frame, not one per copy: a leftover theme.css means a
// second colour ramp crept back in.
for (const ext of EXTENSIONS) {
  for (const stale of ['panel/theme.css', 'status/theme.css', 'src/panel/theme.css', 'src/shared/theme.css']) {
    if (existsSync(join(ext.root, stale))) {
      fail(`${ext.name}/${stale}`, 'a duplicated theme.css is back — the host owns colour now (see src/shared/guest.css)')
    }
  }
}

// The manifest is the other half of the contract: entry paths, command names and
// capability names are all schema-checked by the SDK at INSTALL time, which is
// far too late to find a typo. Parse it with the SDK's own parser, and pin the
// one rule that is invisible until a command silently stops resolving.
for (const ext of EXTENSIONS) {
  const parserPath = join(ext.root, 'node_modules', '@openchamber', 'sdk', 'dist', 'parse.js')
  const pkgPath = join(ext.root, 'package.json')
  if (!existsSync(parserPath)) {
    fail(`${ext.name}/manifest`, `no SDK to parse with — run npm ci in ${ext.name} (looked for ${parserPath})`)
    continue
  }
  const { parseManifest } = await import(pathToFileURL(parserPath).href)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const parsed = parseManifest(pkg.openchamber)
  if (!parsed.ok) {
    fail(`${ext.name}/manifest`, `does not parse: ${JSON.stringify(parsed.error ?? parsed)}`)
    continue
  }
  const contributes = parsed.manifest.contributes
  // `contributes.background` hands onResolve to a hidden frame (API.md: "When
  // both entries exist, the visible panel cannot register the slash-command
  // resolver") — so commands registered by the panel die with no error at all.
  if (contributes.background) {
    fail(`${ext.name}/manifest`, 'contributes.background would steal the slash-command resolver from the visible panel')
  }
  for (const [surface, entry] of [
    ['panel', contributes.panel?.entry],
    ['statusSection', contributes.statusSection?.entry],
    ['service', contributes.service?.entry],
  ]) {
    if (entry && !existsSync(join(ext.root, entry))) {
      fail(`${ext.name}/manifest`, `contributes.${surface}.entry points at a missing file: ${entry}`)
    }
  }
}

const [first, ...rest] = EXTENSIONS
for (const rel of SHARED) {
  const reference = readFileSync(join(first.root, rel), 'utf8')
  for (const ext of rest) {
    const other = join(ext.root, rel)
    if (!existsSync(other)) {
      fail(`${ext.name}/${rel}`, 'missing — copy it from ' + first.name)
      continue
    }
    if (readFileSync(other, 'utf8') !== reference) {
      fail(`${ext.name}/${rel}`, `differs from ${first.name}/${rel} — the shared guest layer must stay byte-identical`)
    }
  }
}

if (failures.length > 0) {
  console.error('guest bundle check FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

const total = EXTENSIONS.reduce((n, e) => n + e.bundles.length, 0)
console.log(`guest bundle check OK — ${total} bundles, ${SHARED.length} shared files identical across ${EXTENSIONS.length} extensions`)
