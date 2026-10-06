// components/markdown/MarkdownView.tsx — thin React wrapper over the migrated
// sanitizer/renderer ($lib/markdown/sanitize.ts: marked + hljs + DOMPurify,
// 60k cap). Re-render only on text change (memo) — streaming appends rewrite
// the string, innerHTML swap is cheap relative to re-parsing.
import { memo } from 'react'
import { renderMarkdown } from '$lib/markdown/sanitize.js'

export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
})
