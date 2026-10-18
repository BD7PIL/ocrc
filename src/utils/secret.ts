import { randomBytes } from 'node:crypto'

/**
 * 生成给远端 openchamber 用的界面密码 / 实例密码。
 * URL-safe（base64url，无 `+` `/` `=`），18 字节 = 144 位，够本地单用户用。
 *
 * 从 `src/core/remotes.ts` 抽出来：那个文件是引擎级远程主机的 store（ocrc 驾驶舱那一代），
 * 已随驾驶舱一起删除，只剩这一个函数被实例级的 store 用着。
 */
export function generateSecret(): string {
  return randomBytes(18).toString('base64url')
}
