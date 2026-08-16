/**
 * The one place the `activity` server frame's text is decided.
 *
 * Read this next to `tool_activity` in `protocol.ts`, which deliberately sends
 * a raw tool name and forbids the daemon from turning it into prose. That ban
 * is about *invention*: a daemon that maps `web_search` to a sentence will
 * eventually map some tool to the wrong sentence, confidently.
 *
 * This module does not invent anything. The only text it will ever return is
 * the `activity` string the model itself wrote on the tool call — a field
 * whose advertised description is "brief non-technical explanation of what you
 * are doing and why, shown as a status update", written by the model for this
 * exact purpose. When the model wrote nothing, this returns `undefined` and no
 * frame is sent, so the surface falls back to the curated words it derives
 * from `tool_activity`. Three honest outcomes, none of them a guess.
 *
 * The text is redacted before it leaves: the surfaces this frame feeds (the
 * Lock Screen, the Dynamic Island) render while the device is locked, so a
 * model that quoted a credential back into its own status line must not put it
 * somewhere a passer-by can read.
 */

import { redactSecrets } from "../security/secret-scanner.js";

/**
 * Upper bound on the label. The consuming surfaces are a lock-screen line and
 * an island pill — both truncate hard, and a long string only costs bandwidth
 * on a live call. Cut on a word boundary when there is one nearby so the
 * result reads as a clipped phrase rather than a severed word.
 */
const MAX_LABEL_LENGTH = 80;

/**
 * Compose the activity label for a tool call, or `undefined` when the model
 * declared none. `input` is the raw tool input the model produced.
 */
export function composeTurnActivityLabel(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const declared = firstNonEmptyString(input?.activity, input?.reason);
  if (declared === undefined) return undefined;

  // Redact first: truncating a secret does not stop it being a secret, and a
  // half-secret still leaks its shape.
  const redacted = redactSecrets(declared).trim();
  if (redacted.length === 0) return undefined;

  return truncateOnWordBoundary(redacted, MAX_LABEL_LENGTH);
}

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function truncateOnWordBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  // Only honour the word boundary when it is not so far back that the label
  // loses its meaning.
  const cut = lastSpace > limit * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}
