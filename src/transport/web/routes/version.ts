import type { Hono } from 'hono'
import { homedir, hostname, platform, release } from 'node:os'
import { getVersionInfo } from '../../../utils/version.js'

export function registerVersion(app: Hono) {
  app.get('/api/version', (c) => c.json(getVersionInfo()))

  /** N6: /z/ 的 DirectoryBrowser 以 homedir 作为起始路径，useWorkspaceHomePath
   *  也靠它算 ~ 展开——没有这个端点时目录选择器直接进 errorSystem 空态。 */
  app.get('/api/system', (c) =>
    c.json({
      homedir: homedir(),
      platform: platform(),
      osRelease: release(),
      hostname: hostname(),
      node: process.version,
      version: getVersionInfo().version,
    }))
}
