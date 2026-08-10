/**
 * The volume valve's three doors — one daemon state, three places you meet it.
 *
 * Design's V2 ruling: the valve does not get a settings screen it lives in and
 * a control somewhere else. It gets three doors onto the *same* stop —
 *
 *   1. **HQ itself** — "Reaching you: Needs you ▾" at the top of Deck's rail,
 *      and the same control behind a ⚙ at the end of Glance's strip. The label
 *      tells the truth about the surface AND is the control.
 *   2. **The mission header** — a per-mission override, amber while it is on so
 *      the exception is visible, offering to reset when the mission completes.
 *   3. **Your Cue → Guardrails** — the policy page (see `../../domains/
 *      guardrails/valve-band`), which explains rather than sets.
 *
 * All three write `PUT hq/valve` (or `PUT/DELETE hq/valve/missions/:id`) and
 * read `GET hq/valve`, so there is one state and no reconciliation to get
 * wrong. This module is where that is enforced: none of the three surfaces
 * holds its own copy of the stop, its own labels, or its own idea of what a
 * stop means.
 *
 * ## The numbers
 *
 * Design's frame shows "94 a day" / "57 now" / "deadlines & errors". Those are
 * illustrations, and this file renders none of them. Every per-stop count comes
 * from `GET hq/valve?stop=<x>`, which previews a stop's `shown` without moving
 * anything — and when that preview has not landed, or fails, the row shows **no
 * number at all** rather than a zero. A stop that reads "0 now" when we simply
 * have not asked is a claim about the owner's day, and the wrong one.
 *
 * ## Fail-open, said out loud
 *
 * An item the valve has never scored is treated as *urgent*, so an empty valve
 * is wide open and switching the feature off makes Cue louder. Every door
 * carries {@link VALVE_FAIL_OPEN} where it can, and no door presents "filtered"
 * as a default or an empty state — the `only_urgent` row is never preselected
 * and the menu never implies that quiet is the resting position.
 */

import { useMemo, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  hqValveFeedbackGetOptions,
  hqValveFeedbackGetQueryKey,
  hqValveGetOptions,
  hqValveGetQueryKey,
  hqValveMissionsByMissionIdDeleteMutation,
  hqValveMissionsByMissionIdPutMutation,
  hqValvePutMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { HqValveFeedbackGetResponses } from "@/generated/daemon/types.gen";

import { C } from "./hq-kit";
import { useValveState, type ValveStop } from "./use-valve";

// ---------------------------------------------------------------------------
// The vocabulary — one definition of a stop, shared by all three doors
// ---------------------------------------------------------------------------

export const VALVE_STOP_ORDER = [
  "everything",
  "needs_you",
  "only_urgent",
] as const satisfies readonly ValveStop[];

export interface ValveStopMeta {
  /** The word the control shows: "Reaching you: **Needs you**". */
  readonly label: string;
  /**
   * The clause under the label, when there is no measured count to show. It
   * never contains a number — the numbers come from the daemon or not at all.
   */
  readonly sub: string;
  /**
   * The clause appended AFTER a measured count, e.g. "57 now · shrinks as Cue
   * learns". `null` where there is nothing true to add.
   */
  readonly countSuffix: string | null;
  /** The full sentence Guardrails uses to explain the stop. */
  readonly explains: string;
}

/**
 * Every label names the RULE that produces it (design v38 §1).
 *
 * "Needs you" was a claim about the owner's OBLIGATION, and no rule in the
 * valve can make that claim — at 264 items it was plainly false, and a label
 * that outruns its rule is the same defect as a count beside contradicting
 * copy. "Anything a person sent you" is a claim about the SENDER, which is
 * exactly what `direct_person` establishes and nothing more.
 *
 * Once responsiveness lands (have I ever replied to this sender?) a fourth
 * stop — "People you answer", ~40 — slots between the top two and becomes the
 * default. That is the genuinely useful middle: 4 is too quiet to live on and
 * 264 is barely a filter. The default stays at the middle stop before and
 * after, because over-filtering is invisible to the owner and expensive
 * (they never learn what they didn't see), while over-showing is annoying,
 * visible, and self-corrects through the ✕.
 */
export const VALVE_STOP_META: Record<ValveStop, ValveStopMeta> = {
  everything: {
    label: "Everything, including automated",
    sub: "unfiltered",
    countSuffix: "a day, unfiltered",
    explains:
      "Every open item interrupts you, automated senders included. Nothing is judged and nothing is held — this is the valve doing no work at all.",
  },
  needs_you: {
    label: "Anything a person sent you",
    sub: "the default",
    // v38 renamed the LABEL, not this clause. The "quietens" promise is a
    // standing ruling from an earlier round and is still true — `learned_down`
    // demotes a sender the owner has ✕'d — so it stays.
    countSuffix: "now · shrinks as Cue learns",
    explains:
      "Anything a person addressed to you, plus what Cue could not judge — that last part is why this stop starts loud and quietens, because each ✕ teaches it and nothing is ever thrown away. Automated senders with nothing to act on wait in Work.",
  },
  only_urgent: {
    label: "Deadlines & errors",
    sub: "the tightest stop",
    countSuffix: "now · a clock on it, or broken",
    explains:
      "Only what has a clock on it or broke: what Cue is blocked on, what is due inside a day, and people you deliberately saved. A colleague's ordinary question does not reach you here — everything else waits in Work.",
  },
};

/** The line under the menu. Filtered is not hidden, and never deleted. */
export const VALVE_FOOTER =
  "Filtered items stay in Work — this changes what interrupts, not what's kept.";

/**
 * The fail-open rule, in product language.
 *
 * Not a caveat and not fine print: it is the reason turning the valve off is
 * not the safe choice people assume it is. An unscored item is treated as
 * urgent, so an empty valve is a wide-open one.
 */
export const VALVE_FAIL_OPEN =
  "If Cue can't score something, it treats it as urgent — turning this off makes Cue louder, not quieter.";

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/**
 * What each stop would cost, previewed without moving anything.
 *
 * `GET hq/valve?stop=<x>` re-runs the filter at a hypothetical stop and returns
 * its `shown` — so the menu can be honest about the trade before you take it.
 * The result is deliberately `number | null` per stop: a query that has not
 * landed, or failed, contributes `null` and the row renders with no digit.
 * There is no `?? 0` in this module and there must never be one.
 */
export function useValveStopCounts(assistantId: string, enabled: boolean) {
  const queries = useQueries({
    queries: VALVE_STOP_ORDER.map((stop) => ({
      ...hqValveGetOptions({
        path: { assistant_id: assistantId },
        query: { stop },
      }),
      enabled: enabled && Boolean(assistantId),
      staleTime: 30_000,
    })),
  });
  return useMemo(() => {
    const out: Record<ValveStop, number | null> = {
      everything: null,
      needs_you: null,
      only_urgent: null,
    };
    VALVE_STOP_ORDER.forEach((stop, i) => {
      const q = queries[i];
      const value = q?.data?.shown;
      out[stop] = typeof value === "number" ? value : null;
    });
    return out;
  }, [queries]);
}

/** Every valve read on the page, invalidated together. One state, remember. */
function useInvalidateValve(assistantId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: hqValveGetQueryKey({ path: { assistant_id: assistantId } }),
      // Query-key prefix: the preview reads carry a `stop` in their key, and
      // they are exactly the ones that go stale the moment the stop moves.
      exact: false,
    });
    void queryClient.invalidateQueries({
      queryKey: hqValveFeedbackGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  };
}

export function useSetValveStop(assistantId: string) {
  const invalidate = useInvalidateValve(assistantId);
  return useMutation({ ...hqValvePutMutation(), onSettled: invalidate });
}

export function useSetMissionValveStop(assistantId: string) {
  const invalidate = useInvalidateValve(assistantId);
  return useMutation({
    ...hqValveMissionsByMissionIdPutMutation(),
    onSettled: invalidate,
  });
}

export function useClearMissionValveStop(assistantId: string) {
  const invalidate = useInvalidateValve(assistantId);
  return useMutation({
    ...hqValveMissionsByMissionIdDeleteMutation(),
    onSettled: invalidate,
  });
}

/** The read half of the feedback route, straight off the generated SDK. */
export type ValveTeaching = HqValveFeedbackGetResponses[200];

/**
 * What the ✕ has taught.
 *
 * `null` means **we could not ask**, and is deliberately NOT the same value as
 * `{demotedSenders: 0}`, which means the ✕ has genuinely taught nothing yet.
 * Guardrails renders those two as different sentences (see
 * {@link taughtSentence}); collapsing them is how a broken read becomes a
 * confident claim about the owner's habits.
 */
export function useValveTeaching(assistantId: string) {
  const query = useQuery({
    ...hqValveFeedbackGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });
  return { teaching: query.data ?? null, isLoading: query.isLoading };
}

/**
 * "34 senders demoted", or the honest alternative.
 *
 * Three outcomes, three sentences, and the middle one is the one products
 * usually get wrong: a fresh account has taught the valve nothing, and printing
 * "0 senders demoted" dresses that up as a result. `null` teaching is a fourth
 * case again — we could not ask, which is not a claim about anything.
 */
export function taughtSentence(teaching: ValveTeaching | null): string {
  if (!teaching) return "Cue couldn't read what the ✕ has taught it.";
  const { demotedSenders, taught, threshold } = teaching;
  if (demotedSenders > 0) {
    return `${demotedSenders} sender${demotedSenders === 1 ? "" : "s"} demoted — they reach Work, not you.`;
  }
  if (taught.length > 0) {
    return `Nothing demoted yet — ${taught.length} ${taught.length === 1 ? "subject has" : "subjects have"} one correction, and it takes ${threshold} before Cue quiets anyone.`;
  }
  return "You haven't used the ✕ yet, so Cue has learnt nothing to quiet.";
}

/**
 * A menu row's second line: what this stop would cost, or the em-dash.
 *
 * Pure, and separated from the row that draws it, because this is the one rule
 * in the door most worth being able to break on purpose: a stop whose preview
 * has not landed must print **no digit**. "0 a day, unfiltered" is not a
 * loading state — it is a claim that nothing would reach you, made about an
 * account we have not counted.
 */
export function stopCaption(stop: ValveStop, count: number | null): string {
  const meta = VALVE_STOP_META[stop];
  if (count == null) return `— ${meta.sub}`;
  return `${count} ${meta.countSuffix ?? meta.sub}`;
}

// ---------------------------------------------------------------------------
// Door 1 — the control on HQ itself
// ---------------------------------------------------------------------------

/** One menu row: the stop, its measured cost, and no digit when unmeasured. */
function StopRow({
  stop,
  count,
  active,
  busy,
  onPick,
}: {
  stop: ValveStop;
  count: number | null;
  active: boolean;
  busy: boolean;
  onPick: (stop: ValveStop) => void;
}) {
  const meta = VALVE_STOP_META[stop];
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={busy}
      onClick={() => onPick(stop)}
      data-slot="valve-stop"
      data-valve-stop={stop}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        font: "inherit",
        background: active
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : "transparent",
        border: "none",
        borderTop: `1px solid ${C.line}`,
        padding: "9px 12px",
        cursor: busy ? "progress" : "pointer",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: active ? 700 : 500,
          color: active ? C.blueText : C.t1,
        }}
      >
        {/* Never colour alone — the active stop carries a ✓ as well. */}
        {meta.label}
        {active ? <span aria-hidden> ✓</span> : null}
      </div>
      {/* The unavailable twin lives in `stopCaption`: an em-dash, never a
          confident zero. */}
      <div
        data-slot="valve-stop-caption"
        style={{ fontSize: 10, color: "var(--hq-muted)", marginTop: 1 }}
      >
        {stopCaption(stop, count)}
      </div>
    </button>
  );
}

/**
 * "Reaching you: Needs you ▾" — the label that is also the control.
 *
 * Rendered at the top of Deck's rail in full, and behind a ⚙ at the end of
 * Glance's strip (`compact`). Both are the same component and the same state:
 * there is no second copy of this to drift.
 *
 * When the valve read has not landed the label says so and the control is
 * disabled — an affordance that would write a stop we cannot currently read is
 * how a surface ends up asserting a state it does not have.
 */
export function ValveDoor({
  assistantId,
  compact = false,
}: {
  assistantId: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { state, isError } = useValveState(assistantId);
  const counts = useValveStopCounts(assistantId, open);
  const setStop = useSetValveStop(assistantId);

  const stop = state?.stop ?? null;
  const label = stop ? VALVE_STOP_META[stop].label : null;
  const pick = (next: ValveStop) => {
    setStop.mutate({
      path: { assistant_id: assistantId },
      body: { stop: next },
    });
    setOpen(false);
  };

  const summary = isError
    ? "Reaching you: couldn't read"
    : label == null
      ? "Reaching you: reading…"
      : `Reaching you: ${label}`;

  return (
    <div data-slot="hq-valve-door" style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? summary : undefined}
        title={compact ? summary : undefined}
        disabled={label == null}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: compact ? undefined : "100%",
          font: "inherit",
          fontSize: compact ? 12 : 10.5,
          fontWeight: 600,
          color: label == null ? "var(--hq-muted)" : C.t1,
          background: compact ? "transparent" : C.surface,
          border: compact ? "none" : `1px solid ${C.line}`,
          borderRadius: 9,
          padding: compact ? "6px 8px" : "8px 11px",
          cursor: label == null ? "default" : "pointer",
        }}
      >
        {compact ? (
          <span aria-hidden>⚙</span>
        ) : (
          <>
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: label == null ? "var(--hq-muted)" : C.blue,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, textAlign: "left" }}>{summary}</span>
            <span aria-hidden style={{ color: "var(--hq-muted)", fontSize: 9 }}>
              ▾
            </span>
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="What reaches you"
          data-slot="hq-valve-menu"
          style={{
            position: "absolute",
            zIndex: 40,
            top: "calc(100% + 6px)",
            [compact ? "right" : "left"]: 0,
            width: 230,
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            overflow: "hidden",
            boxShadow: "0 14px 30px -14px rgba(11,23,54,.35)",
          }}
        >
          {VALVE_STOP_ORDER.map((s) => (
            <StopRow
              key={s}
              stop={s}
              count={counts[s]}
              active={s === stop}
              busy={setStop.isPending}
              onPick={pick}
            />
          ))}
          <div
            style={{
              fontSize: 9.5,
              color: "var(--hq-muted)",
              lineHeight: 1.5,
              padding: "9px 12px",
              borderTop: `1px solid ${C.line}`,
            }}
          >
            {VALVE_FOOTER}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Door 2 — the per-mission override, on the mission's own header
// ---------------------------------------------------------------------------

/**
 * "Everything reaches you ▾" on a mission header — amber while overridden.
 *
 * A hot mission gets bumped where you are already looking when you care that
 * much. The chip is quiet while the mission simply follows the global stop and
 * **amber the moment it does not**, so an exception can never be invisible; and
 * when the mission is no longer live it offers to put the exception back rather
 * than leaving a bumped stop running against a finished goal.
 *
 * `missionStatus` is taken rather than derived so this component cannot decide
 * on its own what "completed" means — the mission page already knows.
 */
export function MissionValveChip({
  assistantId,
  missionId,
  missionStatus,
}: {
  assistantId: string;
  missionId: string;
  missionStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const { state } = useValveState(assistantId);
  const setMission = useSetMissionValveStop(assistantId);
  const clearMission = useClearMissionValveStop(assistantId);

  const override =
    state?.missionOverrides.find((o) => o.missionId === missionId) ?? null;
  const globalStop = state?.stop ?? null;
  const finished =
    missionStatus === "achieved" || missionStatus === "abandoned";

  // Nothing to say until the valve has answered. A chip offering to override a
  // stop we have not read would be writing blind.
  if (globalStop == null) return null;

  const effective = override?.stop ?? globalStop;
  const pick = (next: ValveStop) => {
    setOpen(false);
    if (next === globalStop) {
      clearMission.mutate({
        path: { assistant_id: assistantId, missionId },
      });
      return;
    }
    setMission.mutate({
      path: { assistant_id: assistantId, missionId },
      body: { stop: next },
    });
  };

  return (
    <div data-slot="mission-valve-chip" style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          font: "inherit",
          fontSize: 9.5,
          // Amber while overridden, and the word "override" is in the label —
          // the state is never carried by the colour alone.
          color: override ? C.amberText : "var(--hq-muted)",
          background: override
            ? `color-mix(in srgb, ${C.amber} 12%, transparent)`
            : "transparent",
          border: `1px solid ${override ? `color-mix(in srgb, ${C.amber} 45%, transparent)` : C.line}`,
          borderRadius: 99,
          padding: "3px 9px",
          cursor: "pointer",
        }}
      >
        {override ? (
          <span aria-hidden>‖</span>
        ) : (
          <span aria-hidden style={{ opacity: 0.7 }}>
            ⚙
          </span>
        )}
        {VALVE_STOP_META[effective].label} reaches you
        {override ? " · override" : ""}
        <span aria-hidden>▾</span>
      </button>

      {override && finished ? (
        <div
          data-slot="mission-valve-reset"
          style={{
            fontSize: 10,
            color: C.amberText,
            marginTop: 6,
            lineHeight: 1.45,
          }}
        >
          This mission is {missionStatus} and still overridden.{" "}
          <button
            type="button"
            onClick={() =>
              clearMission.mutate({
                path: { assistant_id: assistantId, missionId },
              })
            }
            style={{
              font: "inherit",
              color: C.amberText,
              background: "none",
              border: "none",
              padding: 0,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Put it back to {VALVE_STOP_META[globalStop].label} ›
          </button>
        </div>
      ) : null}

      {open ? (
        <div
          role="menu"
          aria-label="What this mission sends you"
          style={{
            position: "absolute",
            zIndex: 40,
            top: "calc(100% + 6px)",
            right: 0,
            width: 218,
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            overflow: "hidden",
            boxShadow: "0 14px 30px -14px rgba(11,23,54,.35)",
          }}
        >
          {VALVE_STOP_ORDER.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === effective}
              onClick={() => pick(s)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                font: "inherit",
                fontSize: 11.5,
                fontWeight: s === effective ? 700 : 500,
                color: s === effective ? C.blueText : C.t1,
                background: "transparent",
                border: "none",
                borderTop: `1px solid ${C.line}`,
                padding: "8px 11px",
                cursor: "pointer",
              }}
            >
              {VALVE_STOP_META[s].label}
              {s === effective ? <span aria-hidden> ✓</span> : null}
              {s === globalStop ? (
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--hq-muted)",
                    marginLeft: 6,
                  }}
                >
                  everywhere else
                </span>
              ) : null}
            </button>
          ))}
          <div
            style={{
              fontSize: 9.5,
              color: "var(--hq-muted)",
              lineHeight: 1.5,
              padding: "9px 11px",
              borderTop: `1px solid ${C.line}`,
            }}
          >
            {VALVE_FOOTER}
          </div>
        </div>
      ) : null}
    </div>
  );
}
