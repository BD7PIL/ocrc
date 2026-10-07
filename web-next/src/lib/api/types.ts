import type {
  ToolCall,
  AssistantMeta,
  InfoSection,
  Button,
  ContentBlock,
  StructuredCard,
  StreamDeltaFrame,
} from '$shared/structured-card.js'

export type {
  ToolCall,
  AssistantMeta,
  InfoSection,
  Button,
  ContentBlock,
  StructuredCard,
  StreamDeltaFrame,
}

/** The 'tool' / 'text' / 'reasoning' variants of a ContentBlock. */
export type ToolBlock = Extract<ContentBlock, { type: 'tool' }>
export type TextBlock = Extract<ContentBlock, { type: 'text' }>
export type ReasoningBlock = Extract<ContentBlock, { type: 'reasoning' }>

export type ExtractStructuredCard<K extends StructuredCard['kind']> = Extract<StructuredCard, { kind: K }>

export interface ProjectOverview {
  dir: string
  agentsMd: { exists: boolean; content: string }
  projectConfig: { exists: boolean; content: string }
  commands: Array<{ name: string; content: string }>
  rules: Array<{ name: string; content: string }>
}

export interface ConfigSummary {
  path: string
  raw: string
  parsed: boolean
  error?: string
  providers: Array<{ id: string; baseURL?: string; hasKey: boolean; keyHint?: string; models: Array<{ id: string; name?: string }> }>
}

export interface SessionSummary {
  id: string
  title: string
  agent?: string
  model?: string
  cost?: number
  lastActiveAt: number
  unread: boolean
  directory?: string
  additions?: number
  deletions?: number
  /** Multi-backend: which backend owns this session. */
  backendId?: string
  /** M9: last turn failed (error card seen, no user card since). */
  error?: boolean
}
