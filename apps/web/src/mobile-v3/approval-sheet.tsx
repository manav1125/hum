/**
 * The approval sheet (v22 M4) — what **Review** opens on a paused run.
 *
 * Design was asked whether Approve should be inline on the row or behind a
 * sheet, and answered *neither*:
 *
 *   "The row gets one **Review** button that opens a sheet showing amount,
 *    recipient, which ceiling was hit, and that it can't be recalled. An inline
 *    Approve on £4,200 is a mis-tap away from a real transfer, and a two-button
 *    row at 390px puts destructive and constructive 8px apart. In the sheet:
 *    Approve is full-width and alone; Not now / Decline share a second row."
 *
 * That geometry is the spec and it is enforced here, not remembered: `Approve`
 * is the only child of its row, and `Not now` / `Decline` live in a separate
 * flex row underneath. `approval-sheet.test.tsx` asserts the aloneness, because
 * "two buttons crept back onto one row" is exactly the change that would look
 * harmless in a diff.
 *
 * ## These are real runs, and the facts are only as real as the payload
 *
 * A paused run is a run that reached a send, a payment, a publish or a delete —
 * `assistant/src/tools/outbound-send.ts` hard-checkpoints that class regardless
 * of trust, so nothing continues until somebody answers. **An approval you
 * cannot answer from your phone is the one that actually costs the owner
 * something**, so this sheet has a live confirm mutation, not a link.
 *
 * The facts below it are read from the confirmation's own tool input, and every
 * one of them is optional on the wire. A row whose value the payload does not
 * carry is **omitted**, never filled with a plausible number — the deck's
 * never-a-fake-number rule applies hardest to the surface whose button moves
 * money. What is always shown is the tool Cue is asking to run, verbatim, and
 * the reason it stopped.
 *
 * ## "Which ceiling was hit" is drawn but not stored
 *
 * The frame reads *"over your £1,000 ceiling"*. There is no per-payment ceiling
 * anywhere in this product: `budget-api.ts` caps LLM **spend**, and the thing
 * that actually stops this run is the hard checkpoint in `outbound-send.ts`,
 * which is a class rule with no number in it. So the "why it stopped" row
 * states the real rule, and shows a ceiling ONLY when the request payload names
 * one. Printing a ceiling the product does not enforce would be a fake number
 * on the one screen where a fake number is a transfer.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  confirmPostMutation,
  pendinginteractionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { haptic } from "@/utils/haptics";

import { SheetShell } from "./sheet-shell";
import { microLabel, mv3Mono, secondaryBtn } from "./mv3-kit";

/* -------------------------------------------------------------------------- */
/* Reading the wire                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One stopped run.
 *
 * `input` arrives from a second, conversation-scoped read: the unfiltered
 * `pending-interactions` list is a diagnostic shape carrying only ids, kinds
 * and the tool name (`approval-routes.ts`), while the conversation-scoped read
 * returns `confirmations[]` with the whole tool `input`. That is where the
 * amount and the recipient live, and it is why the sheet is worth opening.
 */
export interface PausedRun {
  requestId: string;
  conversationId: string | null;
  /** Verbatim. Never prettified into something that isn't the tool's name. */
  toolName: string | null;
  kind: string | null;
  riskLevel: string | null;
  /** The tool arguments, once the detail read lands. `null` before that. */
  input: Record<string, unknown> | null;
  /**
   * The detail read has settled — so an absent amount is genuinely absent
   * rather than not-yet-fetched. The sheet says which of those two it is.
   */
  detailKnown: boolean;
}

/**
 * Narrow the unfiltered `pending-interactions` list.
 *
 * An entry with no `requestId` is dropped rather than rendered: a Review button
 * that opens a sheet whose Approve cannot resolve to a request is precisely the
 * dead affordance this whole surface exists to remove.
 */
export function readPausedRuns(raw: unknown): PausedRun[] {
  if (!Array.isArray(raw)) return [];
  const out: PausedRun[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.requestId !== "string" || rec.requestId.length === 0)
      continue;
    out.push({
      requestId: rec.requestId,
      conversationId:
        typeof rec.conversationId === "string" ? rec.conversationId : null,
      toolName: typeof rec.toolName === "string" ? rec.toolName : null,
      kind: typeof rec.kind === "string" ? rec.kind : null,
      riskLevel: typeof rec.riskLevel === "string" ? rec.riskLevel : null,
      input: null,
      detailKnown: false,
    });
  }
  return out;
}

/**
 * Pull one confirmation's tool input out of a conversation-scoped read.
 *
 * Returns `undefined` when the payload holds no entry for this request — which
 * is different from an entry with an empty input, and the caller distinguishes
 * them: the first leaves `detailKnown` false, the second sets it true and the
 * sheet then honestly says the request named no amount.
 */
export function readConfirmationInput(
  raw: unknown,
  requestId: string,
): Record<string, unknown> | undefined {
  const list = (raw as { confirmations?: unknown } | null | undefined)
    ?.confirmations;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.requestId !== requestId) continue;
    const input = rec.input;
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }
    return {};
  }
  return undefined;
}

/** A scalar worth printing. Objects and arrays are structure, not a fact. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstOf(
  input: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const v = scalar(input[key]);
    if (v !== null) return v;
  }
  return null;
}

/** Keys that carry a sum of money in the connector payloads Cue checkpoints. */
const AMOUNT_KEYS = ["amount", "amountUsd", "amount_usd", "total", "value"];
const CURRENCY_KEYS = ["currency", "currencyCode", "currency_code"];
/** Keys that name where the act lands — a person, a channel or a URL. */
const RECIPIENT_KEYS = [
  "to",
  "recipient",
  "recipientEmail",
  "recipient_email",
  "toEmail",
  "to_email",
  "email",
  "phone",
  "channel",
  "chatId",
  "chat_id",
  "url",
];
/**
 * Keys that would name a limit the request itself was measured against. None of
 * Cue's own checkpoints write one today; this reads a connector that does
 * rather than asserting nobody ever will.
 */
const CEILING_KEYS = ["ceiling", "limit", "cap", "threshold"];

export interface ApprovalFacts {
  /** `"£4,200"`-shaped when the payload named one, else null. */
  amount: string | null;
  recipient: string | null;
  /** Only when the payload itself names a limit. Never inferred. */
  ceiling: string | null;
  /** The tool, verbatim. Always known — it is what the list read carries. */
  action: string;
  /** Cue's own words for why nothing is moving. Never empty. */
  why: string;
}

/**
 * The one honest reason, in Cue's voice.
 *
 * Not configurable per tool and not derived from a ceiling that does not exist:
 * the checkpoint is a class rule ("this reaches outside, or can't be undone"),
 * and stating the rule is both true and more useful than a number.
 */
export const HARD_CHECKPOINT_REASON =
  "It reaches outside Cue. Sends, payments, publishes and deletes always stop here.";

/** The irreversibility line. The sheet's whole reason for existing. */
export const NOT_RECALLABLE_LINE =
  "This happens immediately and cannot be recalled.";

export function approvalFacts(run: PausedRun): ApprovalFacts {
  const amountRaw = firstOf(run.input, AMOUNT_KEYS);
  const currency = firstOf(run.input, CURRENCY_KEYS);
  return {
    amount:
      amountRaw === null
        ? null
        : currency
          ? `${currency} ${amountRaw}`
          : amountRaw,
    recipient: firstOf(run.input, RECIPIENT_KEYS),
    ceiling: firstOf(run.input, CEILING_KEYS),
    action: run.toolName ?? run.kind ?? "an action Cue did not name",
    why: run.riskLevel
      ? `${HARD_CHECKPOINT_REASON} (risk: ${run.riskLevel})`
      : HARD_CHECKPOINT_REASON,
  };
}

/** The sheet's headline. A question, because the sheet asks one. */
export function approvalTitle(run: PausedRun): string {
  return `Approve ${approvalFacts(run).action}?`;
}

/* -------------------------------------------------------------------------- */
/* The sheet                                                                  */
/* -------------------------------------------------------------------------- */

/** One label/value line in the facts block. Absent values render nothing. */
function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: "amber";
}) {
  if (value === null) return null;
  return (
    <div
      data-slot="approval-fact"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 14,
        padding: "3px 0",
      }}
    >
      <span
        style={{
          fontSize: 12,
          flexShrink: 0,
          color:
            tone === "amber" ? "var(--mv3-amber-text)" : "var(--mv3-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          minWidth: 0,
          textAlign: "right",
          overflowWrap: "anywhere",
          color: tone === "amber" ? "var(--mv3-amber-text)" : "var(--mv3-text)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The approval sheet.
 *
 * `onDecided` fires only after the confirm call resolves. A sheet that closed
 * optimistically would be a no-op reported as a success, which is the same
 * failure as the Decide link that could not decide.
 */
export function ApprovalSheet({
  assistantId,
  run,
  open,
  onClose,
}: {
  assistantId: string;
  run: PausedRun;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  // v1 mobile keeps two verbs on the sheet; the temporary tiers
  // (allow_10m / allow_conversation) live behind a "More options"
  // disclosure so the primary geometry (Approve full-width and ALONE)
  // is untouched.
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const facts = approvalFacts(run);

  const decide = useMutation({
    ...confirmPostMutation(),
    onError: (error: Error) => {
      haptic.error();
      // Cue reports its own errors first, verbatim, first person. The sheet
      // stays open: a failed approval that dismissed itself is indistinguishable
      // from an approved one, which on this screen is a real transfer.
      setFailed(
        error?.message
          ? `I couldn't record that: ${error.message}`
          : "I couldn't record that decision.",
      );
    },
    onSuccess: () => {
      haptic.success();
      // Both keys: the unfiltered list drives the row, the scoped one drives
      // this sheet's own facts. Leaving either stale re-renders a decided run.
      void queryClient.invalidateQueries({
        queryKey: pendinginteractionsGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      if (run.conversationId) {
        void queryClient.invalidateQueries({
          queryKey: pendinginteractionsGetQueryKey({
            path: { assistant_id: assistantId },
            query: { conversationId: run.conversationId },
          }),
        });
      }
      onClose();
    },
  });

  const send = (
    decision: "allow" | "allow_10m" | "allow_conversation" | "deny",
  ) => {
    setFailed(null);
    haptic.medium();
    decide.mutate({
      path: { assistant_id: assistantId },
      body: { requestId: run.requestId, decision },
    });
  };

  return (
    <SheetShell open={open} onClose={onClose} label="Review a paused run">
      <div data-slot="mv3-approval-sheet">
        {/* The state, as a glyph and a word — never colour alone. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            role="img"
            aria-label="Paused"
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              background:
                "color-mix(in srgb, var(--mv3-amber) 18%, transparent)",
              color: "var(--mv3-amber-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ‖
          </span>
          <span style={{ ...microLabel, color: "var(--mv3-amber-text)" }}>
            Cue paused itself
          </span>
        </div>

        <h2
          style={{
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: "-0.4px",
            lineHeight: 1.25,
            margin: "9px 0 0",
            overflowWrap: "anywhere",
          }}
        >
          {approvalTitle(run)}
        </h2>

        {/* The facts. Every row is conditional; none is ever invented. */}
        <div
          style={{
            background: "var(--mv3-token-well)",
            border: "1px solid var(--mv3-token-well-border)",
            borderRadius: 13,
            padding: "13px 14px",
            marginTop: 12,
          }}
        >
          <Fact label="Amount" value={facts.amount} />
          <Fact label="To" value={facts.recipient} />
          <Fact label="Action" value={facts.action} />
          <Fact label="Ceiling" value={facts.ceiling} />
          <div
            style={{
              borderTop: "1px solid var(--mv3-line)",
              marginTop: 6,
              paddingTop: 8,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--mv3-amber-text)",
            }}
          >
            <span style={{ fontWeight: 600 }}>Why it stopped · </span>
            {facts.why}
          </div>
          {/*
            The honest gap. When the detail read has not settled we say so;
            when it HAS settled and the payload named no sum, we say that
            instead. A blank where an amount belongs reads as a rendering bug.
          */}
          {facts.amount === null ? (
            <div
              data-slot="approval-amount-absent"
              style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "var(--mv3-muted)",
                marginTop: 6,
              }}
            >
              {run.detailKnown
                ? "This request doesn't name a sum."
                : "Still reading the request details."}
            </div>
          ) : null}
        </div>

        {/* What approving does. The line the row physically cannot carry. */}
        <div
          style={{
            background: "color-mix(in srgb, var(--mv3-accent) 9%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--mv3-accent) 25%, transparent)",
            borderRadius: 12,
            padding: "11px 13px",
            marginTop: 9,
          }}
        >
          <div
            style={{
              fontFamily: mv3Mono,
              fontSize: 9,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--mv3-micro)",
              marginBottom: 6,
            }}
          >
            If you approve
          </div>
          <div
            style={{
              fontSize: 11.5,
              lineHeight: 1.5,
              color: "var(--mv3-text)",
            }}
          >
            {NOT_RECALLABLE_LINE} The run then continues on its own.
          </div>
        </div>

        {failed ? (
          <div
            role="alert"
            style={{
              marginTop: 9,
              padding: "10px 12px",
              borderRadius: 12,
              background: "var(--mv3-fail-card-bg)",
              border: "1px solid var(--mv3-fail-card-border)",
              color: "var(--mv3-fail-text)",
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            <span aria-hidden style={{ marginRight: 6 }}>
              ◼
            </span>
            {failed}
          </div>
        ) : null}

        {/*
          Approve is full-width and ALONE. Not a style choice — design's R4
          ruling, because consequential and destructive must never be adjacent
          at thumb width. The test asserts this row has one child.
        */}
        <div data-slot="approval-primary-row" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="cue-pressable"
            disabled={decide.isPending}
            onClick={() => send("allow")}
            style={{
              width: "100%",
              background: "var(--mv3-amber-fill)",
              color: "var(--mv3-amber-on-fill)",
              border: "none",
              borderRadius: 13,
              padding: 14,
              fontSize: 14.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: decide.isPending ? "default" : "pointer",
            }}
          >
            {decide.isPending ? "Recording your decision…" : "Approve"}
          </button>
        </div>
        <div
          data-slot="approval-secondary-row"
          style={{ display: "flex", gap: 8, marginTop: 8 }}
        >
          <button
            type="button"
            className="cue-pressable"
            disabled={decide.isPending}
            onClick={() => {
              haptic.light();
              onClose();
            }}
            style={{ ...secondaryBtn, flex: 1, padding: 11, fontSize: 12.5 }}
          >
            Not now
          </button>
          <button
            type="button"
            className="cue-pressable"
            disabled={decide.isPending}
            onClick={() => send("deny")}
            style={{
              flex: 1,
              background: "var(--mv3-fail-card-bg)",
              color: "var(--mv3-fail-text)",
              border: "1px solid var(--mv3-fail-card-border)",
              borderRadius: 12,
              padding: 11,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: decide.isPending ? "default" : "pointer",
            }}
          >
            Decline
          </button>
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--mv3-muted)",
            textAlign: "center",
            padding: "11px 0 0",
            lineHeight: 1.5,
          }}
        >
          Not now leaves the run stopped. Decline ends it.
        </div>

        {/*
          Temporary approval tiers, behind a disclosure. Each approves THIS
          action and additionally auto-approves eligible follow-up prompts in
          the same conversation — but never another hard-checkpointed send /
          payment / publish / delete: those stop here every time regardless.
          Rows render only when the run names its conversation; a grant that
          cannot name its scope is not offered.
        */}
        {run.conversationId ? (
          <div data-slot="approval-more-options" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="cue-pressable"
              disabled={decide.isPending}
              onClick={() => {
                haptic.light();
                setShowMoreOptions((v) => !v);
              }}
              aria-expanded={showMoreOptions}
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: "var(--mv3-muted)",
                fontSize: 11.5,
                fontFamily: "inherit",
                padding: 6,
                cursor: decide.isPending ? "default" : "pointer",
              }}
            >
              {showMoreOptions ? "Fewer options" : "More options"}
            </button>
            {showMoreOptions ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 6,
                }}
              >
                <button
                  type="button"
                  className="cue-pressable"
                  disabled={decide.isPending}
                  onClick={() => send("allow_10m")}
                  style={{ ...secondaryBtn, padding: 11, fontSize: 12.5 }}
                >
                  Approve &amp; allow for 10 minutes
                </button>
                <button
                  type="button"
                  className="cue-pressable"
                  disabled={decide.isPending}
                  onClick={() => send("allow_conversation")}
                  style={{ ...secondaryBtn, padding: 11, fontSize: 12.5 }}
                >
                  Approve &amp; allow for this conversation
                </button>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--mv3-muted)",
                    textAlign: "center",
                    lineHeight: 1.5,
                  }}
                >
                  Sends, payments, publishes and deletes still stop here every
                  time.
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </SheetShell>
  );
}
