// Static fallbacks for an idle-triggered progress narration whose LLM
// phrasing failed — the one case where prolonged silence is actively harmful.
// The idle trigger can fire on a slow turn with zero tool activity, so every
// phrase stays strictly neutral: no claims about running tools or tasks.
// Persona-neutral, no domain content, ≤ 8 words.
// Exported so tests can assert the neutrality invariant against the list.
// Wording is design-owned (Wave C answers, v37 W3). Design's third fallback
// ("That didn't come through — let me try again.") is error-flavored and
// belongs to a retry path, not this idle slot, so it is deliberately not here.
export const PROGRESS_FALLBACK_PHRASES: readonly string[] = [
  "Still with you — give me a moment.",
  "Taking longer than it should. Hold on.",
  "Nearly there.",
];

// Deterministic rotation through the phrase list: callers hold a nonnegative
// monotonic counter, so consecutive picks vary while tests stay reproducible.
export function pickProgressPhrase(counter: number): string {
  return PROGRESS_FALLBACK_PHRASES[counter % PROGRESS_FALLBACK_PHRASES.length];
}
