/**
 * Read-time derivation of the waiting state for an item that is blocked on a
 * person (`waitingOn` + `lastChasedAt`, migration 317).
 *
 * Waiting is not one state, it is several with different right answers — a
 * nudge, an escalation, or nothing at all — so the difference has to be
 * computed somewhere. It is computed HERE, once, rather than in each client:
 * the boundary between "on time" and "going cold" is a policy number, and
 * three surfaces each picking their own would show the owner three different
 * answers for the same row.
 */

/**
 * The waiting states derivable from what a work item stores today.
 *
 * - `on_time` — waiting, nothing has gone quiet yet. The right answer is to
 *   forget about it; Cue will chase.
 * - `already_chased` — a nudge went out recently. The next move is to
 *   escalate, not to nudge the same person again.
 * - `going_cold` — a nudge went out and the silence has outlasted the chase
 *   window. This is the one that earns an amber row.
 *
 * §7 of the work-surfaces handoff names a fourth state, "waiting on a system"
 * (nothing to do, and saying so is the value). It is deliberately absent: it
 * needs a wait target that is not a person, and `waiting_on` holds a contact
 * reference by definition. Inferring it from a null contact would relabel
 * every ordinary not-waiting item as a system wait, which is worse than not
 * claiming it at all. It arrives with the delegation/leash record, which can
 * name a non-person target.
 */
export type WaitingState = "on_time" | "already_chased" | "going_cold";

/**
 * How long a chase may go unanswered before the item reads as going cold.
 *
 * Five days is the handoff's own worked example of the standing rule this
 * eventually becomes ("always chase after 5 days"). Until per-relationship
 * chase rules exist, it is the single default — deliberately generous, because
 * a false "going cold" is a public wrong answer about somebody the owner
 * knows, and those are the ones that cost trust.
 */
export const GOING_COLD_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/** Statuses where the item is finished and nobody is waiting on anything. */
const TERMINAL_STATUSES = new Set(["done", "cancelled", "archived", "failed"]);

/**
 * Derive the waiting state of a single item, or null when the question does
 * not apply — the item is not waiting on a person, or it is already finished.
 *
 * Note what this deliberately does NOT do: it never calls an item cold on age
 * alone. An item nobody has chased reads `on_time` however old it is, because
 * the stored columns carry no "waiting since" clock — `createdAt` is the age
 * of the TASK, not of the wait, and an item you started waiting on this
 * morning would otherwise show up amber on its first render.
 */
export function deriveWaitingState(
  item: {
    status: string;
    waitingOn: string | null;
    lastChasedAt: number | null;
  },
  now: number = Date.now(),
): WaitingState | null {
  if (!item.waitingOn) return null;
  if (TERMINAL_STATUSES.has(item.status)) return null;
  if (item.lastChasedAt == null) return "on_time";
  return now - item.lastChasedAt >= GOING_COLD_AFTER_MS
    ? "going_cold"
    : "already_chased";
}
