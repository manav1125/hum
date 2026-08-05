/**
 * Channel-agnostic approval flow types.
 *
 * These types model the approval prompt/decision lifecycle for tool-use
 * confirmations surfaced through external channels (Telegram, Slack, etc.).
 * They are intentionally decoupled from any specific channel so that the
 * same approval flow can be reused across transports.
 */

import { getConfig } from "../config/loader.js";
import { canonicalizeTimeZone } from "../daemon/date-context.js";
import type { GuardianDecisionAction } from "./guardian-decision-types.js";

// ---------------------------------------------------------------------------
// Approval actions
// ---------------------------------------------------------------------------

/** The set of actions a user can take on an approval prompt. */
export type ApprovalAction = "approve_once" | "reject";

/** An action presented to the user as a tappable button or text option. */
export interface ApprovalActionOption {
  id: ApprovalAction;
  label: string;
}

/** Outcome word per terminal guardian-request status on a resolved card. */
const DECISION_STATUS_WORDS: Record<string, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
};

/**
 * The outcome word shown on a resolved guardian-request card, shared by every
 * surface (in-app, Telegram); surfaces add only their own glyph vocabulary
 * around it.
 */
export function resolveDecisionStatusWord(status: string): string {
  return DECISION_STATUS_WORDS[status] ?? "Resolved";
}

/**
 * Consequence clause per terminal status whose bare outcome word is ambiguous
 * about whether the action ran. "Expired" alone doesn't say whether the thing
 * happened, so the card must state the consequence (design ruling 5, Wave C:
 * "Expired · never answered — nothing was sent").
 */
const DECISION_STATUS_CONSEQUENCES: Record<string, string> = {
  expired: "never answered — nothing was sent",
};

/** Optional context for composing a decided card's full status line. */
export interface DecisionStatusLineContext {
  /**
   * Who decided, as shown to the reader ("you" for the guardian's own
   * surfaces). Defaults to "you" — every surface a decided card lives on
   * today is guardian-facing.
   */
  decidedBy?: string;
  /** Epoch ms of the decision; renders as a wall-clock `HH:mm` segment. */
  decidedAtMs?: number;
  /**
   * IANA zone the decision time is rendered in. Defaults to the daemon
   * host's zone; callers that know the user's configured zone should pass it
   * (prod daemons run in UTC).
   */
  timeZone?: string;
}

/**
 * The zone a decided card's `HH:mm` segment is rendered in: the user's
 * configured/detected timezone when known, else undefined (the formatter
 * falls back to the daemon host's zone). Prod daemons run in UTC, so the
 * configured zone should win whenever set.
 */
export function resolveDecisionStatusTimeZone(): string | undefined {
  try {
    const ui = getConfig().ui;
    return (
      canonicalizeTimeZone(ui?.userTimezone) ??
      canonicalizeTimeZone(ui?.detectedTimezone) ??
      undefined
    );
  } catch {
    // Config unreadable (early boot, test harness) — host zone fallback.
    return undefined;
  }
}

/** `HH:mm` wall-clock rendering of a decision instant, per ruling 5. */
function formatDecisionClockTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms));
  } catch {
    // Invalid zone from config — fall back to the host zone.
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  }
}

/**
 * The full status line for a decided approval card, shared by every surface
 * so in-app, Slack, and Telegram cannot drift (design ruling 5): decided
 * statuses compose "Approved · by you · 14:02" / "Denied · by you · 14:02";
 * expiry composes "Expired · never answered — nothing was sent" (the
 * consequence must be stated). Surfaces add only their own glyph vocabulary
 * (in-app ✓/✕/◷ tints, Telegram/Slack emoji) around this line.
 */
export function composeDecisionStatusLine(
  status: string,
  context: DecisionStatusLineContext = {},
): string {
  const word = resolveDecisionStatusWord(status);
  const consequence = DECISION_STATUS_CONSEQUENCES[status];
  if (consequence) {
    return `${word} · ${consequence}`;
  }
  if (status !== "approved" && status !== "denied") {
    // Cancelled and unknown terminal statuses keep the bare word — no ruled
    // by-whom/consequence copy exists for them.
    return word;
  }
  const segments = [word, `by ${context.decidedBy ?? "you"}`];
  if (context.decidedAtMs != null) {
    segments.push(
      formatDecisionClockTime(context.decidedAtMs, context.timeZone),
    );
  }
  return segments.join(" · ");
}

/**
 * Map `GuardianDecisionAction[]` to `ApprovalActionOption[]` so channel
 * prompt payloads can be derived from the unified decision action set.
 * The `action` field from GuardianDecisionAction maps to the `id` field
 * on ApprovalActionOption (both are canonical action identifiers).
 */
export function toApprovalActionOptions(
  actions: GuardianDecisionAction[],
): ApprovalActionOption[] {
  return actions.map((a) => ({
    id: a.action as ApprovalAction,
    label: a.label,
  }));
}

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

/** The approval prompt model sent to users via a channel. */
export interface ChannelApprovalPrompt {
  /** Human-readable description of what is being approved. */
  promptText: string;
  /** Available actions the user can take. */
  actions: ApprovalActionOption[];
  /** Instruction text for channels that only support plain text (no buttons). */
  plainTextFallback: string;
}

// ---------------------------------------------------------------------------
// Approval UI metadata (gateway callback payload)
// ---------------------------------------------------------------------------

/**
 * Tool-permission-specific details carried alongside the approval payload.
 * Channels that support rich UI (e.g. Slack Block Kit) use these fields
 * to render a detailed permission request card with risk indicators,
 * tool arguments, and requester identity.
 */
export interface PermissionRequestDetails {
  toolName: string;
  riskLevel: string;
  toolInput: Record<string, unknown>;
  /** Present for guardian-escalated requests to identify who is asking. */
  requesterIdentifier?: string;
}

/**
 * Metadata attached to gateway callback payloads so the channel adapter
 * can render approval UI and route the user's decision back to the
 * correct pending interaction.
 */
export interface ApprovalUIMetadata {
  requestId: string;
  actions: ApprovalActionOption[];
  plainTextFallback: string;
  /** When present, the approval is a tool permission request with extra context. */
  permissionDetails?: PermissionRequestDetails;
}

// ---------------------------------------------------------------------------
// Decision result
// ---------------------------------------------------------------------------

/** How the user communicated their decision. */
export type ApprovalDecisionSource =
  | "telegram_button"
  | "whatsapp_button"
  | "slack_button"
  | "slack_reaction"
  | "vellum_surface"
  | "plain_text";

/** The structured result of a user's approval decision. */
export interface ApprovalDecisionResult {
  action: ApprovalAction;
  source: ApprovalDecisionSource;
  /** Request ID extracted from callback data (button presses only). */
  requestId?: string;
}
