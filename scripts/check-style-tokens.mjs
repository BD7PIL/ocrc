#!/usr/bin/env node
/**
 * 样式令牌门禁（0.10.0 重设计的一部分）：
 *
 *   guest 侧的视觉必须 100% 走宿主令牌——颜色与字号不许自造。具体规则：
 *     1. 十六进制颜色只允许作为 `var(--令牌, fallback)` 里的 fallback 出现
 *        （所在行必须含 `var(--`）；行内裸 hex 一律失败。
 *     2. `font-size:` 必须以 `var(--text-…)` 开头（fallback 用 rem）；
 *        px 字号、裸 rem 字号都失败。TSX 里内联 `fontSize` 一律失败。
 *
 * 字阶令牌（app 2.5.1 web-dist 实测）：--text-base / --text-markdown / --text-code。
 * 只查 ocrc 扩展的 guest 侧（omo-view 是另一代视图，不在本案范围）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = [
  join(root, 'extensions/ocrc/src/shared/guest.css'),
  ...['panel', 'status', 'shared'].flatMap((dir) => {
    const d = join(root, 'extensions/ocrc/src', dir)
    try {
      // 测试文件里出现 hex 是断言，不是样式——不扫 *.test.*
      return readdirSync(d).filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('.test.')).map((f) => join(d, f))
    } catch {
      return []
    }
  }),
]

let failed = 0
for (const file of files) {
  const text = readFileSync(file, 'utf-8')
  const rel = file.slice(root.length + 1)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`
    const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    if (hexes.length && !line.includes('var(--')) {
      console.error(`✗ ${where} 裸 hex 颜色（只能作为 var(--令牌, fallback) 的 fallback）：${line.trim()}`)
      failed++
    }
    const fontSize = /(?:^|[;{])\s*font-size:\s*([^;]+)/.exec(line)
    if (fontSize && !fontSize[1].trim().startsWith('var(--text-')) {
      console.error(`✗ ${where} font-size 不走字阶令牌（--text-base/--text-markdown/--text-code）：${line.trim()}`)
      failed++
    }
    if (/\bfontSize\s*:/.test(line)) {
      console.error(`✗ ${where} 内联 fontSize 禁用（用 guest.css 的令牌类）：${line.trim()}`)
      failed++
    }
  })
}

if (failed) {
  console.error(`\n样式令牌门禁：${failed} 处违规`)
  process.exit(1)
}
console.log('样式令牌门禁：通过（颜色/字号全部走宿主令牌）')
