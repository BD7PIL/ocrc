#!/usr/bin/env node
/**
 * 覆盖率硬门槛：读 `coverage/coverage-summary.json`（`npm run test:coverage` 的产物），
 * 与 `scripts/coverage-baseline.json` 逐指标比较，任一低于基线即 exit 1。
 *
 * 基线语义：**只升不降**。发现覆盖变高了不要改基线——那一次提升要连同改进
 * （新测试）一起提交；这里的数字是下限，不是目标。
 *
 * 比较用整数百分点（向下取整）：v8 的千分位抖动不应红 CI。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const summaryPath = join(root, 'coverage', 'coverage-summary.json')
const baselinePath = join(root, 'scripts', 'coverage-baseline.json')

function pct(entry) {
  // json-summary 每个文件给 {covered, total}，pct 由我们算（避免依赖字段命名差异）。
  if (!entry || typeof entry.total !== 'number' || entry.total === 0) return 100
  return Math.floor((entry.covered / entry.total) * 100)
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const failures = []

// 1) 全局三项：statements / branches / functions（对 total 键）。
const total = summary.total ?? {}
const globalChecks = baseline.global ?? {}
for (const metric of ['statements', 'branches', 'functions']) {
  const floor = globalChecks[metric]
  if (floor === undefined) continue
  const entry = total[metric]
  if (!entry) { failures.push(`global ${metric}: summary 缺指标`); continue }
  const got = pct(entry)
  if (got < floor) failures.push(`global ${metric}: ${got}% < 基线 ${floor}%`)
}

// 2) 重点路径：基线里 paths 键是相对仓库根的文件路径（`src/…`），或以 `/` 结尾的
//    目录前缀（目录 → 逐文件聚合）。summary 的键是绝对路径，Windows 反斜杠统一成
//    / 再做后缀匹配。
const byNorm = new Map(Object.keys(summary).filter((k) => k !== 'total').map((k) => [k.replaceAll('\\', '/'), k]))
for (const [want, floors] of Object.entries(baseline.paths ?? {})) {
  const isDir = want.endsWith('/')
  const matches = [...byNorm.keys()].filter((k) => (isDir ? k.includes(`/${want}`) : k === want || k.endsWith(`/${want}`)))
  if (matches.length === 0) { failures.push(`重点路径 ${want}: summary 里找不到`); continue }

  let entry
  if (isDir) {
    entry = {}
    for (const metric of ['statements', 'branches', 'functions']) {
      entry[metric] = { covered: 0, total: 0 }
      for (const k of matches) { entry[metric].covered += summary[byNorm.get(k)][metric].covered; entry[metric].total += summary[byNorm.get(k)][metric].total }
    }
  } else {
    entry = summary[byNorm.get(matches[0])]
  }

  for (const metric of ['statements', 'branches', 'functions']) {
    const floor = floors[metric]
    if (floor === undefined) continue
    const e = entry[metric]
    if (!e) { failures.push(`${want} ${metric}: summary 缺指标`); continue }
    const got = pct(e)
    if (got < floor) failures.push(`${want} ${metric}: ${got}% < 基线 ${floor}%`)
  }
}

if (failures.length > 0) {
  console.error('覆盖率低于基线（只升不降；提基线请连同新测试一起提交）：')
  for (const f of failures) console.error(`  - ${f}`)
  console.error(`基线文件：scripts/coverage-baseline.json`)
  process.exit(1)
}
console.log(`覆盖率达标（global ${globalChecks.statements}/${globalChecks.branches}/${globalChecks.functions} + ${Object.keys(baseline.paths ?? {}).length} 条重点路径）`)
