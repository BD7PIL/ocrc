import { InputFile, type Api } from 'grammy'
import type { OutboundMediaKind } from './m8-journal.js'

/** B5：媒体输出的 grammy 发送端——按 kind 分发到 Bot API 的
 *  sendPhoto / sendVideo / sendAudio / sendDocument。
 *  抽成工厂是为了能在 tests/unit 里用**本地 mock Bot API**（`apiRoot` 指向
 *  127.0.0.1）验证「四种 kind 各打到哪个端点、multipart 字段名与 filename 对不对」，
 *  不必真连 Telegram、不碰生产 bot。 */
export function grammyOutboundSender(api: Api, chatId: number | string) {
  return async (kind: OutboundMediaKind, file: { buf: Buffer; filename: string }): Promise<unknown> => {
    const input = new InputFile(file.buf, file.filename)
    if (kind === 'photo') return api.sendPhoto(chatId, input)
    if (kind === 'video') return api.sendVideo(chatId, input)
    if (kind === 'audio') return api.sendAudio(chatId, input)
    return api.sendDocument(chatId, input)
  }
}
