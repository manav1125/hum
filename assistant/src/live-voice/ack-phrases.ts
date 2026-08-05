import type { LiveVoiceSpokenAckKind } from "./live-voice-metrics.js";

// Short, persona-neutral phrases spoken to hold the floor when the model is
// slow to produce its first delta. Pure floor-holders: they must never carry
// content or require domain knowledge, and they stay short (≤ 6 words) so they
// finish before the real reply's audio arrives.
// Wording is design-owned (Wave C answers, v37 W3): a capable colleague
// mid-task — brief, plain, no enthusiasm about its own work.
export const ACK_PHRASES: readonly string[] = [
  "On it.",
  "Give me a second.",
  "Let me look.",
  "Checking.",
];

// Tool-flavored variant spoken the moment a turn starts tool use (a
// guaranteed-slow turn). Same rules as ACK_PHRASES: persona-neutral, no
// domain content, ≤ 6 words.
export const TOOL_ACK_PHRASES: readonly string[] = [
  "Pulling that up now.",
  "Let me look.",
  "Checking.",
  "On it.",
];

const PHRASES_BY_KIND: Record<LiveVoiceSpokenAckKind, readonly string[]> = {
  first_delta: ACK_PHRASES,
  tool_use: TOOL_ACK_PHRASES,
};

// Deterministic rotation through the kind's phrase list: callers hold a
// nonnegative monotonic counter, so consecutive acks vary while tests stay
// reproducible.
export function pickAckPhrase(
  kind: LiveVoiceSpokenAckKind,
  counter: number,
): string {
  const phrases = PHRASES_BY_KIND[kind];
  return phrases[counter % phrases.length];
}
