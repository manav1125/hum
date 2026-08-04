/**
 * The paused-run row on HQ (v22 M1 / v23 C1) — **one Review button, and that
 * is the whole row's job.**
 *
 * The row that shipped before this carried an inline Approve beside a Deny,
 * 8px apart, on a card whose subtitle might read "£4,200 to Mafai Ma". Design
 * overturned it and the reasoning is the spec:
 *
 *   "An inline Approve on £4,200 is a mis-tap away from a real transfer, and a
 *    two-button row at 390px puts destructive and constructive 8px apart."
 *
 * So the consequence lives in `../approval-sheet`, and the row's only job is to
 * be legible enough that opening the sheet is an informed act: what stopped,
 * roughly what it was about to do, and how long it has been waiting.
 *
 * ## Two reads, because the list read is a diagnostic shape
 *
 * `GET pending-interactions` with no filter returns ids, kinds and tool names
 * and nothing else (`approval-routes.ts` — that branch is explicitly the
 * "diagnostic mode"). The amount and the recipient live in the tool `input`,
 * which only the conversation-scoped branch returns. So the rows come from one
 * unfiltered read and the FACTS come from a per-conversation read fired only
 * for the runs actually on screen.
 *
 * That second read is bounded by the same rule as everything else on this deck:
 * the deck never grows, so neither does the request count. `DETAIL_CAP` is the
 * ceiling, and it is the ceiling on rendered rows too.
 */

import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { pendinginteractionsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { haptic } from "@/utils/haptics";

import { GlassCard } from "../glass-card";
import { microLabel, mv3Mono } from "../mv3-kit";
import {
  ApprovalSheet,
  readConfirmationInput,
  readPausedRuns,
  type PausedRun,
} from "../approval-sheet";

/**
 * How many stopped runs get their detail fetched, and how many get a row.
 *
 * One number for both on purpose: fetching detail for a run that is not on
 * screen is a request nobody reads, and rendering a row whose sheet would open
 * empty is the affordance this file exists to remove.
 */
export const DETAIL_CAP = 3;

export interface PausedRunsResult {
  runs: PausedRun[];
  /** The scan itself failed — distinct from "nothing is paused". */
  isError: boolean;
  isLoading: boolean;
}

/**
 * Every run stopped at a checkpoint, with the top `DETAIL_CAP` enriched.
 *
 * A run whose detail read failed still gets a row. Failing open is deliberate
 * and it is the same rule the `⌗` strip follows: a judgement about CONTENT may
 * hide something; a timeout may not. A paused run hidden by a flaky second
 * request is a run that never gets answered.
 */
export function usePausedRuns(assistantId: string): PausedRunsResult {
  const list = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: assistantId.length > 0,
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  const base = useMemo(
    () => readPausedRuns(list.data?.interactions),
    [list.data],
  );

  // One detail read per distinct conversation among the shown runs — several
  // stopped runs in one conversation come back in a single response. Derived
  // from `base`, which is itself memoised on the list read, so this list is
  // referentially stable for as long as the answer is.
  const conversationIds = useMemo(() => {
    const seen: string[] = [];
    for (const run of base.slice(0, DETAIL_CAP)) {
      if (run.conversationId && !seen.includes(run.conversationId)) {
        seen.push(run.conversationId);
      }
    }
    return seen;
  }, [base]);

  const details = useQueries({
    queries: conversationIds.map((conversationId) => ({
      ...pendinginteractionsGetOptions({
        path: { assistant_id: assistantId },
        query: { conversationId },
      }),
      retry: false,
      staleTime: 30_000,
    })),
  });

  // `useQueries` returns a fresh array every render, so it can never be a
  // dependency. This key changes exactly when an answer changes.
  const detailKey = details
    .map((d) => (d.isSuccess ? "ok" : d.isError ? "err" : "…"))
    .join("|");

  const runs = useMemo(() => {
    return base.map((run, i) => {
      if (i >= DETAIL_CAP || !run.conversationId) return run;
      const at = conversationIds.indexOf(run.conversationId);
      const query = at >= 0 ? details[at] : undefined;
      if (!query || !query.isSuccess) return run;
      const input = readConfirmationInput(query.data, run.requestId);
      // `undefined` means this read carried no entry for the request at all —
      // not the same as an entry whose input is empty, and the sheet says so.
      if (input === undefined) return { ...run, detailKnown: true };
      return { ...run, input, detailKnown: true };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, conversationIds, detailKey]);

  return { runs, isError: list.isError, isLoading: list.isLoading };
}

/** How long it has been stopped, when the payload lets us say. */
function waitedLabel(run: PausedRun): string | null {
  const since = run.input?.["requestedAt"] ?? run.input?.["createdAt"];
  if (typeof since !== "number" || !Number.isFinite(since)) return null;
  const mins = Math.floor((Date.now() - since) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The lead row: the amber card whose only control is **Review**.
 *
 * `‖` rather than a colour: no state on this deck is colour-only, and the same
 * glyph on the sheet's header is what makes the two read as one thing.
 */
export function Mv3PausedRunRow({
  assistantId,
  run,
  style,
}: {
  assistantId: string;
  run: PausedRun;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const waited = waitedLabel(run);
  const subject = run.toolName ?? run.kind ?? null;

  return (
    <>
      <GlassCard
        tint="amber"
        data-slot="mv3-paused-run"
        radius={16}
        padding="12px 13px"
        blur={false}
        style={style}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            role="img"
            aria-label="Paused"
            style={{
              width: 18,
              height: 18,
              borderRadius: 6,
              background:
                "color-mix(in srgb, var(--mv3-amber) 20%, transparent)",
              color: "var(--mv3-amber-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            ‖
          </span>
          <span
            style={{
              ...microLabel,
              fontFamily: mv3Mono,
              fontSize: 8.5,
              color: "var(--mv3-amber-text)",
              flex: 1,
            }}
          >
            Paused · waiting on you
          </span>
          {waited ? (
            <span style={{ fontSize: 9.5, color: "var(--mv3-muted)" }}>
              {waited}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            marginTop: 7,
            color: "var(--mv3-text)",
          }}
        >
          A run stopped before it acted
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--mv3-muted)",
            marginTop: 3,
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          }}
        >
          {subject
            ? `${subject} · it reaches outside Cue`
            : "It reaches outside Cue, so it waits for you."}
        </div>
        {/*
          One control. The sheet carries amount, recipient, why it stopped and
          that it can't be recalled — none of which fits here, and without
          which Approve would be a guess.
        */}
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            setOpen(true);
          }}
          style={{
            width: "100%",
            background: "var(--mv3-amber-fill)",
            color: "var(--mv3-amber-on-fill)",
            border: "none",
            borderRadius: 11,
            padding: 10,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "inherit",
            marginTop: 10,
            cursor: "pointer",
          }}
        >
          Review
        </button>
      </GlassCard>
      <ApprovalSheet
        assistantId={assistantId}
        run={run}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * The runs below the lead one, as compact `‖` rows.
 *
 * Same single door — tapping the row opens the same sheet. A compact row with
 * its own inline verbs would re-create exactly the geometry R4 removed.
 */
export function Mv3PausedRunLine({
  assistantId,
  run,
}: {
  assistantId: string;
  run: PausedRun;
}) {
  const [open, setOpen] = useState(false);
  const subject = run.toolName ?? run.kind ?? "a stopped run";
  return (
    <>
      <button
        type="button"
        className="cue-pressable"
        data-slot="mv3-paused-run-line"
        onClick={() => {
          haptic.light();
          setOpen(true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          textAlign: "left",
          background: "var(--mv3-card)",
          border: "1px solid var(--mv3-amber-card-border)",
          borderRadius: 15,
          padding: "11px 13px",
          font: "inherit",
          color: "var(--mv3-text)",
          cursor: "pointer",
        }}
      >
        <span
          role="img"
          aria-label="Paused"
          style={{
            width: 18,
            height: 18,
            borderRadius: 6,
            background: "color-mix(in srgb, var(--mv3-amber) 15%, transparent)",
            color: "var(--mv3-amber-text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 9,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          ‖
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 12.5,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subject}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 9.5,
              color: "var(--mv3-muted)",
              marginTop: 1,
            }}
          >
            Stopped until you decide
          </span>
        </span>
        <span
          aria-hidden
          style={{ fontSize: 10.5, color: "var(--mv3-micro)", flexShrink: 0 }}
        >
          Review
        </span>
      </button>
      <ApprovalSheet
        assistantId={assistantId}
        run={run}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
