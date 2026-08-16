/**
 * Message-metadata marker keys shared between the agent loop (which stamps
 * and clears them per LLM call) and boot-time hung-turn recovery (which
 * sweeps for them after a daemon restart). Kept in a leaf module with no
 * imports so the agent-loop handlers don't pick up a dependency cycle
 * through `turn-recovery.ts`'s store/eventing imports.
 */

/**
 * Stamped on the reserved assistant row while its LLM call is in flight.
 * Present ⇒ the row has not been finalized yet; a row still carrying it at
 * daemon boot belonged to a turn killed by the previous process's death.
 */
export const TURN_IN_FLIGHT_METADATA_KEY = "turnInFlight";

/**
 * Stamped by boot recovery on rows whose turn died. Serialized onto the
 * wire `ConversationMessage.interrupted` so clients can render the
 * "response was interrupted" affordance.
 */
export const INTERRUPTED_METADATA_KEY = "interrupted";

/**
 * Body of an assistant row reserved by `reserveMessage` that has not yet
 * received content. Together with {@link TURN_IN_FLIGHT_METADATA_KEY} this is
 * the whole definition of "not finalized", so every consumer — boot recovery
 * and `forkConversation` — must agree on it or one of them will treat a live
 * row as finished.
 */
export const RESERVED_EMPTY_CONTENT = "[]";

/**
 * True when an assistant row belongs to a turn that has not finished writing:
 * either its LLM call is still in flight, or it is a reserved row that never
 * received content.
 *
 * Two callers depend on this being one function. Boot recovery sweeps for
 * these rows to mark them interrupted. `forkConversation` refuses to copy
 * them: a fork is a new conversation that will never run the source's turn,
 * so a copied in-flight row is filled by nobody — a permanently empty bubble
 * carrying a `turnInFlight` marker that is a lie about a turn that was never
 * live in that conversation.
 */
export function isUnfinalizedTurnRow(row: {
  role: string;
  content: string;
  /** Raw JSON as stored, or an already-parsed record. */
  metadata?: Record<string, unknown> | string | null;
}): boolean {
  if (row.role !== "assistant") return false;
  const meta = parseMetadata(row.metadata);
  if (meta?.[TURN_IN_FLIGHT_METADATA_KEY] === true) return true;
  return row.content === RESERVED_EMPTY_CONTENT;
}

function parseMetadata(
  metadata: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (typeof metadata !== "string") return metadata;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // Malformed metadata carries no marker; callers fall back to content.
    return undefined;
  }
}
