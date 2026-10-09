export interface Card {
  title?: string
  lines: string[]
  buttons?: Button[][]
  footer?: string
  /** When true, lines/footer are already valid Telegram HTML — skip escaping in renderer */
  rawHtml?: boolean
}

export interface Button {
  label: string
  data: string
}

export interface IncomingMessage {
  userId: string
  chatId: string
  text: string
  messageId: string
  /**
   * Target session this message should be relayed into. Web sets it to the
   * session the UI is viewing; Telegram leaves it unset and the relay falls
   * back to the (global) pinned/last session. The relay validates it exists.
   */
  sessionId?: string
  /** Reasoning-effort variant id (e.g. low/high/max) for this turn — panel
   *  sets it per message; undefined = provider default. */
  variant?: string
  /**
   * Per-message engine agent override (e.g. "plan"). /z/ sets it when the
   * composer's 计划 mode is on (payload.planEnabled) — the engine's native
   * plan agent is the honest equivalent of ZCode's plan mode. Undefined =
   * fall back to the host's one-shot nextAgent (TG /agent), then default.
   */
  agent?: string
  /**
   * Which transport the message came from. Used so a transport can avoid
   * echoing the user's own message back to them (e.g. Telegram already shows it).
   * 'goalContinuation' is the goal loop's synthetic continuation turn — visible
   * in /z/ as the vendor's goalContinuation origin, suppressed in Telegram.
   */
  origin?: 'telegram' | 'web' | 'scheduler' | 'lark' | 'dingtalk' | 'wecom' | 'goalContinuation'
  /** Image attachments (base64 `data` + `mimeType`) for backends with imageInput. */
  images?: Array<{ data: string; mimeType: string }>
}

export interface ChannelCapabilities {
  readonly edit: boolean
  readonly maxMessageLength: number
  readonly buttons: boolean
  readonly richText: boolean
  readonly streaming: boolean
}
