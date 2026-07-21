// Re-exports the canonical conversation-type union (defined alongside the
// create path in `conversation-crud.ts`) under a read-side name and provides
// the shared "is this a non-interactive / background conversation?" predicate
// used by notification-feed and memory filters.

import type { ConversationCreateType } from "./conversation-crud.js";

export type ConversationType = ConversationCreateType;

/**
 * Conversation types that are NOT driven by a live human at the keyboard —
 * background wakes, scheduled runs, retrospective forks. Single source shared
 * by the predicate below and the SQL "was a human recently active?" filter
 * (`getLastInteractiveUserMessageTimestamp`), so the two never drift.
 */
export const BACKGROUND_CONVERSATION_TYPES = [
  "background",
  "scheduled",
] as const;

// Tolerant of null/undefined/unknown strings so it can be called directly on
// raw DB column values without pre-validation.
export function isBackgroundConversationType(
  t: ConversationType | string | null | undefined,
): boolean {
  return (BACKGROUND_CONVERSATION_TYPES as readonly string[]).includes(
    t as string,
  );
}
