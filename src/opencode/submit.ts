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

export interface SubmitOptions {
  text: string
  sessionId: string
  agent?: string
  model?: { providerID: string; modelID: string }
  images?: SubmitImage[]
  signal?: AbortSignal
}

/** Build one prompt body from text + optional image attachments (pure; unit-tested). */
export function buildPromptBody(opts: {
  text: string
  agent?: string
  model?: { providerID: string; modelID: string }
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
