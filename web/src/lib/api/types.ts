import type {
  ToolCall,
  AssistantMeta,
  InfoSection,
  Button,
  ContentBlock,
  StructuredCard,
} from '$shared/structured-card.js'

export type {
  ToolCall,
  AssistantMeta,
  InfoSection,
  Button,
  ContentBlock,
  StructuredCard,
}

/** The 'tool' / 'text' / 'reasoning' variants of a ContentBlock. */
export type ToolBlock = Extract<ContentBlock, { type: 'tool' }>
export type TextBlock = Extract<ContentBlock, { type: 'text' }>
export type ReasoningBlock = Extract<ContentBlock, { type: 'reasoning' }>

export type ExtractStructuredCard<K extends StructuredCard['kind']> = Extract<StructuredCard, { kind: K }>

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
}
