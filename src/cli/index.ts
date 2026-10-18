#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * ocrc CLI — **远程 openchamber 实例这一件事**。
 *
 * 这里曾经还有一整套"驾驶舱"命令（`install`/`uninstall` 装成 opencode 插件、`start`/`stop`/
 * `restart`/`status`/`restore` 的守护与监督、`pair` 的网页配对、`host` 的 ACP 主机、`wf` 的
 * 动态工作流、`mcp-browser`）。它们属于另一个产品面（ocrc 自己的 IM 驾驶舱：Telegram/Web
 * 两个通道 + 引擎级远程主机 + 工作流/日程/技能），那个面**已经从这个仓库删除**，会作为独立的
 * openchamber 扩展在别的项目里做。所以这里只剩 `remote`。
 */
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
})()

const HELP = `
ocrc v${VERSION}

USAGE:
  ocrc <command>

COMMANDS:
  remote <sub>  Remote openchamber instances (add / plan / apply / up / down / pairlink / …)
  --help, -h    Show this help
`

async function main() {
  const cmd = process.argv[2]

  if (cmd === 'remote') {
    await import('./remote.js').then((m) => m.main(process.argv.slice(3)))
    return
  }

  console.log(HELP)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
