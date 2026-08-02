/**
 * Ask once, or not at all.
 *
 * *"Dana's thread or Rachel's?"* — one clarifying question is partnership;
 * three is a form. If Cue can pick right 90% of the time it should pick and say
 * which, so the batched question prompt is capped at a single question here
 * rather than paginating the user through a questionnaire.
 *
 * Nothing is silently swallowed. The questions past the first are answered as
 * explicit `skip` entries in the same submission the daemon is already waiting
 * on, so the run resumes exactly as it would have — it just resumes with Cue
 * making its own call on the rest, which is the behaviour we wanted anyway.
 */

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import type { QuestionEntry } from "@/types/interaction-ui-types";

/** How many questions a single turn is allowed to ask. */
export const MAX_CLARIFYING_QUESTIONS = 1;

/** The questions we will actually show. */
export function capClarifyingQuestions(
  entries: readonly QuestionEntry[],
): QuestionEntry[] {
  return entries.slice(0, MAX_CLARIFYING_QUESTIONS);
}

/** The ones we won't — answered as skips so the daemon is never left hanging. */
export function skipsForDroppedQuestions(
  entries: readonly QuestionEntry[],
): QuestionResponseEntry[] {
  return entries
    .slice(MAX_CLARIFYING_QUESTIONS)
    .map((entry) => ({ questionId: entry.id, kind: "skip" as const }));
}

/**
 * Merge the user's answers with the auto-skips, preserving the daemon's own
 * question order so it can pair responses back to its batch.
 */
export function withDroppedSkips(
  entries: readonly QuestionEntry[],
  responses: readonly QuestionResponseEntry[],
): QuestionResponseEntry[] {
  const answered = new Set(responses.map((r) => r.questionId));
  const skips = skipsForDroppedQuestions(entries).filter(
    (s) => !answered.has(s.questionId),
  );
  if (skips.length === 0) return [...responses];
  const order = new Map(entries.map((entry, i) => [entry.id, i]));
  return [...responses, ...skips].sort(
    (a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0),
  );
}
