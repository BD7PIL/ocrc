import type { OpencodeClient } from '@opencode-ai/sdk'

// Extract the body type from session.promptAsync parameter using TypeScript inference.
// This avoids coupling to SDK internal paths that may change between versions.
type PromptBody = Parameters<OpencodeClient['session']['promptAsync']>[0] extends { body?: infer B }
  ? B
  : never

export interface SubmitImage {
  /** Raw base64 payload (no data: prefix). */
  data: string
  mimeType: string
  filename?: string
}

// Sessions created for internal side calls (e.g. Tier2 suggestion generation).
// Their turns stream through the same event hook as real sessions; transports
// and the relay check isEphemeralSession() so the mirrored output never leaks
// into user-facing feeds.
const ephemeralSessions = new Set<string>()

export function markEphemeralSession(id: string): void {
  ephemeralSessions.add(id)
}

export function isEphemeralSession(id: string): boolean {
  return ephemeralSessions.has(id)
}

export interface SubmitOptions {
  text: string
  sessionId: string
  agent?: string
  model?: { providerID: string; modelID: string }
  /** Reasoning-effort variant id (low/high/max...) — opencode v1.18 model
   *  variants; unsupported values are ignored server-side (safe). */
  variant?: string
  images?: SubmitImage[]
  signal?: AbortSignal
}

/** Build one prompt body from text + optional image attachments (pure; unit-tested). */
export function buildPromptBody(opts: {
  text: string
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  images?: SubmitImage[]
}): PromptBody {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: opts.text }]
  for (const img of opts.images ?? []) {
    // opencode FilePartInput: {type:'file', mime, filename?, url} — a data URL
    // carries the base64 payload inline (the plugin has no public file host).
    const ext = img.mimeType.split('/')[1] ?? 'bin'
    parts.push({
      type: 'file',
      mime: img.mimeType,
      filename: img.filename ?? `image.${ext}`,
      url: `data:${img.mimeType};base64,${img.data}`,
    })
  }
  return {
    parts,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // opencode v1.18.34 accepts `variant` on the prompt body even though the
    // generated SDK types lag — the official TUI/app send it (source-verified).
    ...(opts.variant ? { variant: opts.variant } : {}),
  } as PromptBody
}

export async function submitPrompt(
  client: OpencodeClient,
  opts: SubmitOptions,
): Promise<void> {
  await client.session.promptAsync({
    path: { id: opts.sessionId },
    body: buildPromptBody(opts),
    signal: opts.signal,
  })
}
