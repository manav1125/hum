/**
 * Door 3 of the volume valve (design V2) — **the policy page**.
 *
 * HQ is where you feel the valve, the mission header is where you override it,
 * and this is where you understand it. So this band explains rather than
 * abbreviates: all three stops with their full sentences, every per-mission
 * override listed by name, what the ✕ has actually taught, and the fail-open
 * rule stated in product language.
 *
 * Three things this file refuses to do, each of which the surface has got wrong
 * before somewhere in this product:
 *
 *   · **It does not hold its own copy of the stop.** Every read and write goes
 *     through `pages/hq/valve-doors`, which is the same module HQ and the
 *     mission header use. One daemon state, three doors.
 *   · **It does not print an unmeasured number.** A stop with no landed preview
 *     shows an em-dash; "34 senders demoted" appears only when the banding
 *     rules genuinely demote that many senders, and a fresh account is told it
 *     has taught nothing rather than shown a zero dressed as a result.
 *   · **It does not present quiet as the safe default.** The valve fails open —
 *     an item Cue cannot score is treated as urgent — so switching it off makes
 *     Cue *louder*. That sentence is the loudest thing in the band, because the
 *     opposite is what everyone assumes.
 */

import { useMemo } from "react";

import {
  taughtSentence,
  useClearMissionValveStop,
  useSetValveStop,
  useValveStopCounts,
  useValveTeaching,
  VALVE_FAIL_OPEN,
  VALVE_FOOTER,
  VALVE_STOP_META,
  VALVE_STOP_ORDER,
} from "@/pages/hq/valve-doors";
import { useValveState, type ValveStop } from "@/pages/hq/use-valve";

const C = {
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  amber: "var(--mv1-amber)",
  blueText: "var(--mv1-blue-text)",
  amberText: "var(--mv1-amber-text)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";

/**
 * Muted text, on the token named for its GROUND and role rather than its value
 * — the rule the v35 answers asked for after the ninth recurrence of this
 * class. `--gr-muted` is the theme-following alias injected by the page's own
 * `GrStyle`; `--mv1-t3` is a chrome grey that dips under 4:1 on the dark
 * canvas, and this band is nothing but small grey type.
 */
const MUTED = "var(--gr-muted)";

function StopCard({
  stop,
  active,
  count,
  busy,
  onPick,
}: {
  stop: ValveStop;
  active: boolean;
  count: number | null;
  busy: boolean;
  onPick: (stop: ValveStop) => void;
}) {
  const meta = VALVE_STOP_META[stop];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={busy}
      onClick={() => onPick(stop)}
      data-slot="guardrails-valve-stop"
      data-valve-stop={stop}
      style={{
        display: "block",
        textAlign: "left",
        font: "inherit",
        flex: "1 1 240px",
        minWidth: 200,
        background: active
          ? `color-mix(in srgb, ${C.blue} 7%, ${C.surface})`
          : C.surface,
        border: `1px solid ${active ? `color-mix(in srgb, ${C.blue} 45%, ${C.line})` : C.line}`,
        borderRadius: 12,
        padding: "13px 15px",
        cursor: busy ? "progress" : "pointer",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: active ? 700 : 600,
            color: active ? C.blueText : C.t1,
          }}
        >
          {/* The mark, not only the tint — the active stop says so in glyph. */}
          {active ? "◉ " : "○ "}
          {meta.label}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: mono,
            fontSize: 10.5,
            color: MUTED,
            whiteSpace: "nowrap",
          }}
        >
          {count == null ? (
            // The unavailable twin: a pending number is an em-dash, never a
            // confident zero.
            <span title="Cue hasn't been able to count this stop yet">—</span>
          ) : (
            `${count} would reach you`
          )}
        </span>
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: C.t2,
          lineHeight: 1.55,
          marginTop: 6,
        }}
      >
        {meta.explains}
      </div>
      {active ? (
        <div
          style={{
            fontFamily: mono,
            fontSize: 9.5,
            letterSpacing: "0.1em",
            color: C.blueText,
            marginTop: 8,
          }}
        >
          CURRENT
        </div>
      ) : null}
    </button>
  );
}

export function ValveBand({ assistantId }: { assistantId: string }) {
  const { state, isError } = useValveState(assistantId);
  // The policy page always wants the comparison — this is the surface whose
  // job is to explain the trade, so the previews are not gated on a menu.
  const counts = useValveStopCounts(assistantId, true);
  const setStop = useSetValveStop(assistantId);
  const clearMission = useClearMissionValveStop(assistantId);
  const { teaching, isLoading: teachingLoading } = useValveTeaching(assistantId);

  const overrides = useMemo(
    () => state?.missionOverrides ?? [],
    [state?.missionOverrides],
  );

  if (isError) {
    return (
      <div style={{ fontSize: 12.5, color: C.amberText }}>
        Cue couldn&rsquo;t read your volume valve, so this page can&rsquo;t say
        where it is set. Nothing has changed — the valve is still running.
      </div>
    );
  }

  return (
    <div data-slot="guardrails-valve">
      <div
        role="radiogroup"
        aria-label="What reaches you"
        style={{ display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        {VALVE_STOP_ORDER.map((stop) => (
          <StopCard
            key={stop}
            stop={stop}
            active={state?.stop === stop}
            count={counts[stop]}
            busy={setStop.isPending || state == null}
            onPick={(next) =>
              setStop.mutate({
                path: { assistant_id: assistantId },
                body: { stop: next },
              })
            }
          />
        ))}
      </div>

      <div
        style={{
          fontSize: 11.5,
          color: MUTED,
          marginTop: 10,
          lineHeight: 1.55,
        }}
      >
        {VALVE_FOOTER}
      </div>

      {/*
        The fail-open rule, in the loudest voice on the band.

        Not a footnote: it is the sentence that stops somebody turning the valve
        off "to be safe". An unscored item is treated as urgent, so an empty
        valve is a wide-open one.
      */}
      <div
        data-slot="guardrails-valve-failopen"
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          marginTop: 14,
          padding: "12px 14px",
          borderRadius: 11,
          border: `1px solid color-mix(in srgb, ${C.amber} 30%, ${C.line})`,
          background: `color-mix(in srgb, ${C.amber} 6%, ${C.surface})`,
        }}
      >
        <span aria-hidden style={{ color: C.amberText, fontSize: 13 }}>
          !
        </span>
        <div style={{ fontSize: 12.5, color: C.t1, lineHeight: 1.55 }}>
          {VALVE_FAIL_OPEN}
        </div>
      </div>

      {/* Per-mission overrides — named, and removable from here. */}
      <div style={{ marginTop: 18 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.blueS,
          }}
        >
          ACTIVE OVERRIDES
        </div>
        {state == null ? (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            Still reading the valve…
          </div>
        ) : overrides.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            No mission is overriding the global stop.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 1,
              marginTop: 9,
              border: `1px solid ${C.line}`,
              borderRadius: 11,
              overflow: "hidden",
              background: C.line,
            }}
          >
            {overrides.map((o) => (
              <div
                key={o.missionId}
                data-slot="guardrails-valve-override"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: C.surface,
                  padding: "10px 13px",
                }}
              >
                <span aria-hidden style={{ color: C.amberText, fontSize: 12 }}>
                  ‖
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: C.t1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {/* A deleted mission keeps its override row rather than
                      vanishing — a rule still in force with no name attached is
                      exactly the thing a policy page must not hide. */}
                  {o.missionTitle ?? "A mission Cue can no longer name"}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: mono,
                    fontSize: 10,
                    color: C.amberText,
                    whiteSpace: "nowrap",
                  }}
                >
                  {VALVE_STOP_META[o.stop].label}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    clearMission.mutate({
                      path: { assistant_id: assistantId, missionId: o.missionId },
                    })
                  }
                  style={{
                    font: "inherit",
                    fontSize: 11,
                    color: C.blueText,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                    whiteSpace: "nowrap",
                  }}
                >
                  Reset
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* What the ✕ has taught. */}
      <div style={{ marginTop: 18 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 10,
            letterSpacing: "0.14em",
            color: C.blueS,
          }}
        >
          WHAT THE ✕ HAS TAUGHT
        </div>
        <div
          data-slot="guardrails-valve-taught"
          style={{
            fontSize: 12.5,
            color: C.t1,
            marginTop: 8,
            lineHeight: 1.55,
          }}
        >
          {teachingLoading ? "Reading what you've taught Cue…" : taughtSentence(teaching)}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: MUTED,
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          A demoted sender still reaches Work with everything else — nothing is
          deleted, and saying &ldquo;this mattered&rdquo; on one of their items
          genuinely undoes it rather than merely stopping the count.
        </div>
      </div>
    </div>
  );
}
