/**
 * Decided approval-card presentation (design ruling 5, Wave C).
 *
 * Wording is shared across surfaces — the daemon composes the status line
 * once (`composeDecisionStatusLine` in
 * `assistant/src/runtime/channel-approval-types.ts`: "Approved · by you ·
 * 14:02" / "Denied · by you · 14:02" / "Expired · never answered — nothing
 * was sent") — and each surface contributes only its own glyph vocabulary.
 * This module is the in-app glyph vocabulary: it recognises the shared
 * status word at the head of a `completionSummary` and maps it to the ruled
 * glyph + tint (✓ green · ✕ red · ◷ grey). Summaries that don't start with a
 * decision word (choice/form completions like `User chose: "…"`) keep the
 * existing green-check treatment.
 */

import { CheckCircle, Clock, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type DecisionStatusKind =
  "approved" | "denied" | "expired" | "cancelled" | "generic";

/** In-app glyph + tint per decided state. */
export interface DecisionStatusPresentation {
  kind: DecisionStatusKind;
  Icon: LucideIcon;
  /** Text/icon color class for the inline status line. */
  textClass: string;
  /** Border color class for the collapsed status pill. */
  borderClass: string;
  /** Background color class for the collapsed status pill. */
  bgClass: string;
}

const PRESENTATIONS: Record<DecisionStatusKind, DecisionStatusPresentation> = {
  approved: {
    kind: "approved",
    Icon: CheckCircle,
    textClass: "text-[var(--system-positive-strong)]",
    borderClass: "border-[var(--system-positive-strong)]",
    bgClass: "bg-[var(--system-positive-weak)]",
  },
  denied: {
    kind: "denied",
    Icon: XCircle,
    textClass: "text-[var(--system-negative-strong)]",
    borderClass: "border-[var(--system-negative-strong)]",
    bgClass: "bg-[var(--system-negative-weak)]",
  },
  expired: {
    kind: "expired",
    Icon: Clock,
    textClass: "text-[var(--content-secondary)]",
    borderClass: "border-[var(--border-element)]",
    bgClass: "bg-[var(--surface-base)]",
  },
  cancelled: {
    kind: "cancelled",
    Icon: XCircle,
    textClass: "text-[var(--content-secondary)]",
    borderClass: "border-[var(--border-element)]",
    bgClass: "bg-[var(--surface-base)]",
  },
  generic: {
    kind: "generic",
    Icon: CheckCircle,
    textClass: "text-[var(--system-positive-strong)]",
    borderClass: "border-[var(--system-positive-strong)]",
    bgClass: "bg-[var(--system-positive-weak)]",
  },
};

/**
 * Classify a `completionSummary` by the shared status word at its head.
 * The status word is the single wording source (Wave B-3's
 * `resolveDecisionStatusWord`, extended in Wave C); matching the prefix
 * keeps the client from re-deriving wording it doesn't own.
 */
export function decisionStatusKind(
  summary: string | undefined,
): DecisionStatusKind {
  if (!summary) return "generic";
  if (summary.startsWith("Approved")) return "approved";
  if (summary.startsWith("Denied")) return "denied";
  if (summary.startsWith("Expired")) return "expired";
  // Client-side stale-tap notice (`formatDecisionReason`) for a request that
  // expired before the tap landed — same decided state, different phrasing.
  if (summary.startsWith("Request expired")) return "expired";
  if (summary.startsWith("Cancelled")) return "cancelled";
  return "generic";
}

/** Glyph + tint for a completed surface's status line, per decided state. */
export function decisionStatusPresentation(
  summary: string | undefined,
): DecisionStatusPresentation {
  return PRESENTATIONS[decisionStatusKind(summary)];
}
