/**
 * Escape a string for inclusion in a Telegram HTML (parse_mode: 'HTML') message.
 * Unescaped `<`, `>` or `&` in dynamic content makes Telegram reject the send
 * with a 400 "can't parse entities".
 */
export function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)
}
