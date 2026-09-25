/**
 * Local structural types for the opencode V2 plugin API.
 *
 * We deliberately do NOT depend on the `@opencode-ai/plugin` beta dist-tag
 * (0.0.0-beta-*): the beta moves fast and a pinned structural copy keeps the
 * fork's build stable while the API settles (same approach as OmO #8626).
 * Shapes below are narrowed to the slices ocrc actually consumes — sourced
 * from @opencode-ai/plugin@0.0.0-beta-19271 + its nested @opencode-ai/client
 * generated types. See docs/v2-api-notes.md.
 *
 * V2 hosts interpret the default export's `setup` member; V1 hosts call
 * `server`. See src/plugin/entry.ts for the dual-export wiring.
 */

export type V2PermissionReply = 'once' | 'always' | 'reject'

/** The V2 setup context — narrowed to the domains ocrc touches. */
export interface V2Context {
  readonly app?: { name?: string; version?: string; channel?: string }
  readonly location?: { directory?: string; project?: { id?: string } }
  readonly options?: Record<string, unknown>
  readonly event: {
    subscribe(requestOptions?: unknown): AsyncIterable<V2Event>
  }
  readonly session: {
    create(input?: {
      id?: { title?: string | null; agent?: string | null }
      location?: { directory?: string }
    }): Promise<V2SessionInfo>
    get(input: { sessionID: string }): Promise<V2SessionInfo>
    prompt(input: { sessionID: string; id?: { text: string }; text?: { text: string } }): Promise<unknown>
    interrupt(input: { sessionID: string }): Promise<unknown>
    rename(input: { sessionID: string; id?: { title?: string | null } }): Promise<unknown>
    command(input: { sessionID: string; command: string; arguments?: string }): Promise<unknown>
  }
  readonly permission: {
    reply(input: { sessionID: string; requestID: string; reply: V2PermissionReply; message?: string }): Promise<void>
  }
}

export interface V2SessionInfo {
  id?: string
  title?: string
  agent?: string
  model?: { providerID?: string; modelID?: string } | string
  cost?: number
  tokens?: { input?: number; output?: number }
  directory?: string
  updatedAt?: number | string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

/**
 * The V2Event members ocrc consumes. The real stream is a large union
 * (client/dist/promise/generated/types.d.ts V2Event); only these carry data
 * the relay/push/handlers need. `location` rides on every event and carries
 * the directory — the seam P2a's directory routing builds on.
 */
export interface V2Event {
  type?: string
  location?: { directory?: string; projectID?: string }
  data?: {
    sessionID?: string
    projectID?: string
    assistantMessageID?: string
    id?: string
    name?: string
    ordinal?: number
    delta?: string
    text?: string
    input?: Record<string, unknown>
    content?: Array<{ type?: string; text?: string }>
    error?: { type?: string; message?: string }
    action?: string
    resources?: string[]
    metadata?: Record<string, unknown>
    requestID?: string
    reply?: V2PermissionReply
    parentID?: string
    slug?: string
  }
  [key: string]: unknown
}
