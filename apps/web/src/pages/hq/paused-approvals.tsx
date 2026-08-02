/**
 * Paused approvals, decidable in place.
 *
 * These are not work items. They are runs that stopped mid-flight because they
 * reached a high-consequence action — a send, a payment, a publish, a delete —
 * which `assistant/src/tools/outbound-send.ts` hard-checkpoints regardless of
 * trust. Until somebody answers, the run does not continue.
 *
 * The deck used to carry a card per approval. Retiring that board was right —
 * they were cards wrapped around one sentence — but it left desktop able to
 * COUNT paused approvals and not answer them: the top one reached the next-move
 * card, and the remainder got a line reading "N more approvals are paused for
 * your decision · Decide ›" whose door led to the review queue, which only
 * completes work items and has no confirm call at all. A link labelled Decide
 * that cannot decide is worse than no link.
 *
 * So the line stays a line and grows a disclosure. The deck does not gain a
 * card, and the count is capped for the same reason needs-you is: at three
 * paused approvals or thirty, only the number moves.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  confirmPostMutation,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "./hq-kit";

/** Never render more than this many rows. See "the deck never grows". */
export const PAUSED_APPROVAL_CAP = 4;

export interface PausedApproval {
  requestId: string;
  /** What Cue is asking to do. Falls back through kind, then a plain phrase. */
  label: string;
}

/**
 * Read the interaction list into the two fields this surface needs.
 *
 * The payload is `Record<string, unknown>` in the generated client, so this is
 * the one place that narrows it. An entry with no `requestId` is dropped rather
 * than rendered undecidable — a row whose buttons cannot work is the thing this
 * component exists to remove.
 */
export function readPausedApprovals(raw: unknown): PausedApproval[] {
  if (!Array.isArray(raw)) return [];
  const out: PausedApproval[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const requestId = typeof rec.requestId === "string" ? rec.requestId : null;
    if (!requestId) continue;
    const toolName = typeof rec.toolName === "string" ? rec.toolName : null;
    const kind = typeof rec.kind === "string" ? rec.kind : null;
    out.push({
      requestId,
      label: toolName ?? kind ?? "Waiting on your decision",
    });
  }
  return out;
}

export function PausedApprovals({
  assistantId,
  approvals,
}: {
  assistantId: string;
  approvals: PausedApproval[];
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const key = pendinginteractionsGetQueryKey({
    path: { assistant_id: assistantId },
  });
  const decide = useMutation({
    ...confirmPostMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  if (approvals.length === 0) return null;
  const shown = approvals.slice(0, PAUSED_APPROVAL_CAP);
  const n = approvals.length;

  return (
    <div data-slot="hq-paused-approvals" style={{ marginTop: 11 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 9,
          fontSize: 12.5,
          color: "var(--hq-muted)",
        }}
      >
        {/* Glyph, not colour alone. */}
        <span aria-hidden style={{ color: C.amberText }}>
          ‖
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {n} {n === 1 ? "run is" : "runs are"} paused for your decision.
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            fontFamily: mono,
            fontSize: 11,
            color: "var(--hq-muted)",
            cursor: "pointer",
          }}
        >
          {open ? "Hide" : "Decide"} ›
        </button>
      </div>

      {open ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginTop: 9,
            paddingLeft: 18,
          }}
        >
          {shown.map((approval) => (
            <div
              key={approval.requestId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontSize: 12.5,
                color: C.t1,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {approval.label}
              </span>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({
                    path: { assistant_id: assistantId },
                    body: { requestId: approval.requestId, decision: "allow" },
                  })
                }
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  background: C.amberText,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "5px 11px",
                  cursor: decide.isPending ? "default" : "pointer",
                }}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({
                    path: { assistant_id: assistantId },
                    body: { requestId: approval.requestId, decision: "deny" },
                  })
                }
                style={{
                  fontSize: 11.5,
                  background: "transparent",
                  color: C.t2,
                  border: `1px solid ${C.line}`,
                  borderRadius: 8,
                  padding: "5px 11px",
                  cursor: decide.isPending ? "default" : "pointer",
                }}
              >
                Decline
              </button>
            </div>
          ))}
          {n > shown.length ? (
            <div
              style={{
                fontFamily: mono,
                fontSize: 11,
                color: "var(--hq-muted)",
              }}
            >
              {shown.length} of {n} — decide these and the rest follow.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
