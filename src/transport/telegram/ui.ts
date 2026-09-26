// Minimal Telegram-UI and error helpers shared by the grammY transport.
// These preserve the old Markup call-shapes (spread-friendly {reply_markup})
// so call sites stay a mechanical find/replace, and read both grammY's
// top-level error fields and the legacy response-envelope shape.

import { InlineKeyboard } from 'grammy'

export interface TgBtn {
  text: string
  callback_data: string
}

export const btn = (text: string, callback_data: string): TgBtn => ({ text, callback_data })

/** Build an InlineKeyboard from row arrays; returns {reply_markup} for spreading into reply opts. */
export function inlineKeyboard(rows: TgBtn[][]): { reply_markup: InlineKeyboard } {
  let kb = new InlineKeyboard()
  rows.forEach((row, i) => {
    for (const b of row) kb = kb.text(b.text, b.callback_data)
    if (i < rows.length - 1) kb = kb.row()
  })
  return { reply_markup: kb }
}

/** Telegram API error code — grammY raises GrammyError with a top-level code. */
export function errorCodeOf(e: unknown): number | undefined {
  const anyE = e as any
  return anyE?.error_code ?? anyE?.response?.error_code
}

/** retry_after from a 429 — grammY exposes it on the error's parameters. */
export function retryAfterOf(e: unknown): number | undefined {
  const anyE = e as any
  return anyE?.parameters?.retry_after ?? anyE?.response?.parameters?.retry_after
}
