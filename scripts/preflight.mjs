#!/usr/bin/env node
/**
 * 提交前自检：把 CI 会拦的东西在本机跑一遍。
 *
 *   npm run preflight
 *
 * 为什么要有它：**扩展的安装产物是提交进仓库的**（`panel/` `status/` `service/`，
 * 给"不构建直接装"用），所以改了 `src/` 却忘了重建，CI 的
 * "Extension dist consistency" 就会红——而且这已经是同一类错误第二次发生
 * （共享层 `guest.css` 同步进另一个扩展时最容易漏）。这里把顺序固定下来：
 *
 *   1. 重建两个扩展（vite/esbuild 产物 + stage-dist）
 *   2. 三处 typecheck（cli / 测试树 / 两个扩展）
 *   3. cli 与两个扩展的测试
 *   4. guest bundle 不变量（无 process.env / 主题桥 / 无 window.prompt）
 *   5. 产物重建并暂存（一致性由 CI 在干净检出上比对）
 */
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const steps = [
  ['重建 ocrc 扩展', 'npm --prefix extensions/ocrc run build'],
  ['重建 ocrc-omo-view 扩展', 'npm --prefix extensions/ocrc-omo-view run build'],
  ['typecheck（cli）', 'npm run typecheck'],
  ['typecheck（测试树）', 'npm run typecheck:tests'],
  ['typecheck（ocrc 扩展）', 'npm --prefix extensions/ocrc run typecheck'],
  ['typecheck（omo-view 扩展）', 'npm --prefix extensions/ocrc-omo-view run typecheck'],
  ['测试（cli）', 'npm test'],
  ['覆盖率门槛（cli）', 'npm run test:coverage && npm run check:coverage'],
  ['测试（ocrc 扩展）', 'npm --prefix extensions/ocrc test'],
  ['测试（omo-view 扩展）', 'npm --prefix extensions/ocrc-omo-view test'],
  ['guest bundle 不变量', 'node scripts/check-guest-bundles.mjs'],
  [
    '产物重建并暂存',
    // CI 在干净检出上跑 `git diff --exit-code`：那等价于"提交进仓库的产物 == 重新构建的结果"。
    // 本机无法在提交前证明这一点（"忘了重建"和"还没提交"看起来一样），所以这里只保证
    // 构建结果已经进暂存区并列出它们；一致性由 CI 和提交后再跑一次 preflight 兜底。
    'git add -- extensions/ocrc/panel extensions/ocrc/status extensions/ocrc/service extensions/ocrc-omo-view/panel && git diff --cached --name-only -- extensions/ocrc/panel extensions/ocrc/status extensions/ocrc/service extensions/ocrc-omo-view/panel | sed "s/^/  待提交：/" || true',
  ],
]

let failed = 0
for (const [label, cmd] of steps) {
  process.stdout.write(`\n▶ ${label}\n`)
  try {
    execSync(cmd, { cwd: root, stdio: 'inherit' })
  } catch {
    failed++
    process.stdout.write(`✗ ${label}\n`)
  }
}

process.stdout.write(failed ? `\n${failed} 步失败\n` : '\n全部通过（可以提交了）\n')
process.exit(failed ? 1 : 0)
