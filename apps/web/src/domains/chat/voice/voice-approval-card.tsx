/**
 * VoiceApprovalCard — the mid-call approval moment (design v37 §W2;
 * `cue-design-answers-v37.html`, "MID-CALL APPROVAL — ROOM MINIMIZES
 * IMMEDIATELY" — its inline styles are the spec).
 *
 * Rendered in the CONVERSATION VIEW while a live-voice turn is parked on a
 * pending confirmation: the room has already demoted (the ladder owner
 * collapses on `approval_pending` — immediately, approval ≠ reveal), the
 * fixed phrase has been spoken, and this card is what the user is being
 * asked to look at. Amber `‖` treatment; the why in one line of trust
 * language (carried verbatim on the wire); three answers:
 *
 *  - **Approve** / **Deny** — resolve through the existing
 *    `POST /v1/confirm` path (`submitConfirmation`), exactly like the chat
 *    card. The daemon's `approval_resolved` then promotes the room back.
 *  - **Ask me after** — a first-class DEFERRAL, not a deny: dismisses this
 *    card locally and sends NOTHING (no `/v1/confirm`, nothing on the voice
 *    socket). The pending approval rides on in the normal review surfaces —
 *    the chat approval card stays answerable — and the daemon keeps treating
 *    it as pending (narration stays down; at call end the bridge's existing
 *    unresolved-turn semantics resolve it).
 *
 * Shared by the desktop conversation slot and the mobile thread-voice strip
 * — same component, same copy, per the "reuse the same component" ruling.
 */

import { useState } from "react";

import { submitConfirmation } from "@/domains/chat/api/interactions";
import { toolActivityWords } from "@/domains/chat/voice/live-voice/tool-activity-words";
import type { LiveVoicePendingApproval } from "@/domains/chat/voice/live-voice/live-voice-store";

// ---------------------------------------------------------------------------
// v37 §W2 literals (inspected from the rendered frame)
// ---------------------------------------------------------------------------

const AMBER = "#E0A64B";
const TEXT = "#F4F4F6";
const BODY = "#C9C9D4";
const MUTED = "#9A9AA8";
const MONO = "'DM Mono', monospace";

const CARD: React.CSSProperties = {
  background: "#14100D",
  border: "1.5px solid rgba(224,166,75,.45)",
  borderRadius: 14,
  padding: "13px 15px",
  boxShadow: "0 0 0 4px rgba(224,166,75,.08)",
  color: TEXT,
};

const BADGE: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 7,
  background: "rgba(224,166,75,.15)",
  color: AMBER,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 700,
  flexShrink: 0,
};

const SECONDARY_BUTTON: React.CSSProperties = {
  background: "rgba(255,255,255,.07)",
  border: "1px solid rgba(255,255,255,.13)",
  borderRadius: 11,
  padding: "10px 14px",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

export interface VoiceApprovalCardProps {
  approval: LiveVoicePendingApproval;
  /** Assistant the confirmation belongs to — the `/v1/confirm` path param. */
  assistantId: string;
  /**
   * "Ask me after": dismiss this card locally. The caller clears the store's
   * `pendingApproval` (which also promotes the room back) and MUST NOT
   * resolve or deny the confirmation — deferring is first-class.
   */
  onDeferred: () => void;
  /**
   * A decision was submitted (allow/deny accepted by the daemon). Optional:
   * the `approval_resolved` frame clears the store either way; this lets the
   * caller dismiss optimistically.
   */
  onDecided?: (decision: "allow" | "deny") => void;
}

/** Title line: the daemon's input summary when it has one, else the tool in words. */
function approvalTitle(approval: LiveVoicePendingApproval): string {
  const summary = approval.summary?.trim();
  if (summary) return summary;
  return toolActivityWords(approval.toolName) ?? approval.toolName;
}

export function VoiceApprovalCard({
  approval,
  assistantId,
  onDeferred,
  onDecided,
}: VoiceApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);

  const decide = (decision: "allow" | "deny") => {
    if (submitting) return;
    setSubmitting(true);
    void submitConfirmation(assistantId, approval.requestId, decision)
      .then((result) => {
        if (result.ok) onDecided?.(decision);
      })
      .finally(() => setSubmitting(false));
  };

  // The detail line composes risk + trust language with the frame's " · "
  // convention; the trust copy arrives on the wire (single owner), with the
  // spec wording as the fallback for a daemon that omitted it.
  const detailParts: string[] = [];
  if (approval.riskLevel) detailParts.push(`${approval.riskLevel} risk`);
  detailParts.push(approval.trustLine ?? "this is the part I can't do alone.");

  return (
    <div style={CARD} data-testid="voice-approval-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={BADGE}>
          ‖
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0 }}>
          {approvalTitle(approval)}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 9,
            color: MUTED,
            flexShrink: 0,
            letterSpacing: "0.04em",
          }}
        >
          {approval.toolName}
        </span>
      </div>
      <div
        style={{ fontSize: 11, color: BODY, marginTop: 8, lineHeight: 1.55 }}
      >
        {detailParts.join(" · ")}
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 11 }}>
        <button
          type="button"
          disabled={submitting}
          onClick={() => decide("allow")}
          style={{
            flex: 1,
            background: AMBER,
            color: "#211E16",
            border: "none",
            borderRadius: 11,
            padding: 10,
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            opacity: submitting ? 0.6 : 1,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => decide("deny")}
          style={{ ...SECONDARY_BUTTON, color: TEXT }}
        >
          Deny
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onDeferred}
          style={{ ...SECONDARY_BUTTON, color: MUTED }}
        >
          Ask me after
        </button>
      </div>
    </div>
  );
}
