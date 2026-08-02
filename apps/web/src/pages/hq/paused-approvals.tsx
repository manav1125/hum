/**
 * Paused runs, as needs-you rows.
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
 * The first fix was a line with a disclosure. Design overturned it, and the
 * reasoning is better than mine: "needs you" is DEFINED as things blocked on a
 * human decision, and a stopped run is the most literal instance of that in the
 * product. A separate lane does not under-rank it — it breaks the one-definition
 * rule, which is precisely why the door ended up pointing at a destination that
 * could not act.
 *
 * So these are needs-you rows now, sorted above everything else in the lane,
 * counted in the badge and the headline like anything else there.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  confirmPostMutation,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "./hq-kit";

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

/**
 * One paused run, rendered as the top of the needs-you list.
 *
 * `⏸` rather than `‖`: the honest difference is "a run is stopped", not "a
 * thing is waiting". Same amber, different glyph, because a reader scanning the
 * lane needs to know which rows will not move again until they act.
 */
export function PausedNeedsYouRow({
  assistantId,
  approval,
}: {
  assistantId: string;
  approval: PausedApproval;
}) {
  const queryClient = useQueryClient();
  const key = pendinginteractionsGetQueryKey({
    path: { assistant_id: assistantId },
  });
  const decide = useMutation({
    ...confirmPostMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <div
      data-slot="hq-paused-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "11px 14px",
        border: `1px solid color-mix(in srgb, ${C.amber} 34%, ${C.line})`,
        background: `color-mix(in srgb, ${C.amber} 6%, ${C.surface})`,
        borderRadius: 13,
      }}
    >
      <span aria-hidden style={{ color: C.amberText, fontSize: 13 }}>
        ⏸
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, color: C.ink }}>
          {approval.label}
        </div>
        {/* Names what is held, so the row says why nothing is moving. */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            color: "var(--hq-muted)",
            marginTop: 3,
          }}
        >
          A run is stopped here until you decide.
        </div>
      </div>
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
          padding: "6px 12px",
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
          padding: "6px 12px",
          cursor: decide.isPending ? "default" : "pointer",
        }}
      >
        Decline
      </button>
    </div>
  );
}
