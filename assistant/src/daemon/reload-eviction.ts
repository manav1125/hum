/**
 * Whether a config reload may throw a conversation away.
 *
 * Reload eviction discards conversations so the next turn picks up the edited
 * SOUL.md, skill or config. Discarding a conversation also aborts every
 * subagent running under it, which makes "is anything depending on this?" the
 * real question — and `isProcessing()` does not answer it.
 *
 * Subagents spawn asynchronously, so a parent waiting on a child sits idle
 * between tool calls. Reading that idleness as "safe to discard" meant saving
 * a watched file killed mid-task subagents — precisely what an owner does
 * while watching one work, which is what made it look like the subagent had
 * failed on its own.
 *
 * Extracted so the rule has a name and a test. The TTL/LRU evictor already
 * applied both halves; only the reload path was asking the narrower question.
 */
export function mayDiscardOnReload(state: {
  /** A turn is running in this conversation right now. */
  isProcessing: boolean;
  /** Subagents are running or pending under this conversation. */
  hasLiveChildren: boolean;
}): boolean {
  return !state.isProcessing && !state.hasLiveChildren;
}
