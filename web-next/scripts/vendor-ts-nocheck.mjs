#!/usr/bin/env node
// vendor-ts-nocheck.mjs — 给 vendor 树全部 ts/tsx 补 @ts-nocheck 横幅（PATCHES.md 条目 1 的重放脚本）。
// 幂等：已有横幅（首行含 @ts-nocheck）的文件跳过；cua/**/*.d.ts 是声明文件，保持上游原样不插。
// 用法：node scripts/vendor-ts-nocheck.mjs [--check]   （--check 只报告不写入，用于升级后核对）
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const VENDOR_ROOT = join(new URL('..', import.meta.url).pathname, 'vendor', 'zcode')
const BANNER = '// @ts-nocheck'
const CHECK_ONLY = process.argv.includes('--check')

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(VENDOR_ROOT, [])
const missing = []
let inserted = 0
for (const file of files) {
  const rel = relative(VENDOR_ROOT, file)
  const relPosix = rel.split(sep).join('/')
  if (relPosix.startsWith('cua/') && relPosix.endsWith('.d.ts')) continue
  const src = readFileSync(file, 'utf8')
  if (src.split('\n', 1)[0].includes(BANNER)) continue
  missing.push(relPosix)
  if (!CHECK_ONLY) {
    writeFileSync(file, `${BANNER}\n${src}`)
    inserted++
  }
}

const label = CHECK_ONLY ? 'missing banner' : 'inserted'
console.log(`vendor/zcode: ${files.length} ts/tsx scanned, ${label}: ${missing.length}`)
for (const rel of missing) console.log(`  + ${rel}`)
if (CHECK_ONLY && missing.length > 0) process.exitCode = 1
