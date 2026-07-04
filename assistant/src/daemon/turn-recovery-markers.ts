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
