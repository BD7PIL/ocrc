// components/transcript/entrance.ts — entrance-animation dedup (ZCode
// ToolCallBlocks register): a card animates ONLY the first time its id is
// seen; WS replays / snapshot rewrites / reconnect remounts must never replay
// the motion. Bounded Map as LRU (800 keys) so long sessions don't grow.
const seen = new Map<string, true>()
const CAP = 800

export function shouldAnimate(id: string | undefined): boolean {
  if (!id) return false
  if (seen.has(id)) return false
  seen.set(id, true)
  if (seen.size > CAP) {
    // Map preserves insertion order — evict the oldest entries.
    const excess = seen.size - CAP
    let i = 0
    for (const k of seen.keys()) {
      if (i++ >= excess) break
      seen.delete(k)
    }
  }
  return true
}
