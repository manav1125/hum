/**
 * Morning Brief — the 7:30 tap-through ritual (spec frames 5 dark / 13 light).
 *
 * A three-beat story, not a list:
 *   Beat 1 · WHILE YOU SLEPT — "Cue finished N things." + the ◱/✓ item rows
 *            rising in stagger. When nothing happened overnight the beat
 *            opens calm ("All quiet overnight.") instead.
 *   Beat 2 · ONE THING NEEDS YOU — the single ask (amber card, one action).
 *            Skipped when the daemon reports no ask.
 *   Beat 3 · YOUR DAY AHEAD — times + titles, then "Start my day →".
 *
 * Whole-canvas tap advances beats (buttons stop propagation); the end of the
 * story lands on Today (/assistant/hq). All motion is transform/opacity via
 * the shared mv3 keyframes; reduced-motion freezes to static frames through
 * the `[data-mv3]` rule in mv3.css.
 *
 * Data: GET /brief/morning through the authed daemon client (see
 * ./use-morning-brief.ts). Beat-2 actions call the declared endpoint/method
 * verbatim; approvals carry the `{requestId, decision}` confirm body.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { client } from "@/generated/daemon/client.gen";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { microLabel, mv3Mono, rise } from "../mv3-kit";
import { markRitualRead } from "../today/ritual-progress";
import {
  useMorningBrief,
  morningBriefQueryKey,
  type BriefAsk,
  type BriefAskAction,
  type DayEntry,
  type MorningBrief,
  type OvernightItem,
} from "./use-morning-brief";

const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

type BeatId = "overnight" | "quiet" | "ask" | "day";

/** Resolve the story's beats from the data — never an empty story. */
function resolveBeats(brief: MorningBrief | null): BeatId[] {
  if (!brief) return [];
  const beats: BeatId[] = [];
  beats.push(brief.overnight.length > 0 ? "overnight" : "quiet");
  if (brief.ask) beats.push("ask");
  beats.push("day");
  return beats;
}

/* ------------------------------------------------------------------------- */
/* Shared bits                                                               */
/* ------------------------------------------------------------------------- */

/** Twinkle stars (dark only — frame 13's light brief carries none). */
function Stars() {
  const dots: Array<{ top: string; left: string; size: number }> = [
    { top: "16%", left: "20%", size: 2 },
    { top: "24%", left: "78%", size: 1.5 },
    { top: "72%", left: "14%", size: 1.5 },
    { top: "80%", left: "80%", size: 2 },
  ];
  return (
    <>
      {dots.map((d, i) => (
        <span
          key={i}
          className="mv3-brief-star"
          aria-hidden
          style={{
            position: "absolute",
            top: d.top,
            left: d.left,
            width: d.size,
            height: d.size,
            borderRadius: "50%",
            background: i % 2 === 0 ? "#ffffff" : "#9DB9F5",
            animation: `mv3BriefTwinkle ${3.4 + i * 0.4}s ease-in-out ${i * 0.7}s infinite`,
          }}
        />
      ))}
    </>
  );
}

/** Gradient headline text — text → accent (frames 5/13). */
function gradientText(endColor: string): React.CSSProperties {
  return {
    background: `linear-gradient(120deg, var(--mv3-text) 40%, ${endColor})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
}

const headline: React.CSSProperties = {
  fontSize: 42,
  fontWeight: 700,
  letterSpacing: "-1.1px",
  lineHeight: 1.08,
  marginTop: 14,
  color: "var(--mv3-text)",
};

/** One overnight row — glass, state chip, title, project/agent tag. */
function OvernightRow({
  item,
  delay,
}: {
  item: OvernightItem;
  delay: number;
}) {
  const review = item.state === "review";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        background: "var(--mv3-card)",
        border: "1px solid var(--mv3-card-border)",
        borderRadius: 16,
        padding: "12px 14px",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        boxShadow: "var(--mv3-card-shadow)",
        ...rise(delay),
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          flexShrink: 0,
          background: review
            ? "color-mix(in srgb, var(--mv3-violet) 16%, transparent)"
            : "color-mix(in srgb, var(--mv3-green) 14%, transparent)",
          color: review ? "var(--mv3-violet)" : "var(--mv3-green)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
        }}
      >
        {review ? "◱" : "✓"}
      </span>
      <span
        style={{
          fontSize: 13.5,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--mv3-text)",
        }}
      >
        {item.title}
      </span>
      {item.project || item.agent ? (
        <span style={{ fontSize: 11, color: "var(--mv3-muted)", flexShrink: 0 }}>
          {item.agent ?? item.project}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Beats                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Calm loading shimmer shown while GET /brief/morning is in flight — the
 * page previously rendered `null` here, leaving a blank screen for the
 * whole round-trip on the flagship morning surface. Same silhouette as the
 * overnight beat (micro label, headline, three rows) so the real content
 * lands without a layout jump. Motion is opacity-only (`mv3BriefShimmer`)
 * and frozen by the shared [data-mv3] reduced-motion rule.
 */
function BriefSkeleton() {
  const bar = (
    width: string | number,
    height: number,
    radius = 10,
    delay = 0,
  ): React.CSSProperties => ({
    width,
    height,
    borderRadius: radius,
    background: "var(--mv3-card)",
    border: "1px solid var(--mv3-card-border)",
    animation: `mv3BriefShimmer 1.6s ease-in-out ${delay}s infinite`,
  });
  return (
    <div aria-hidden>
      <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-micro)" }}>
        Morning brief
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <div style={bar("72%", 38, 12, 0)} />
        <div style={bar("48%", 38, 12, 0.15)} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 28 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={bar("100%", 46, 16, 0.3 + i * 0.15)} />
        ))}
      </div>
    </div>
  );
}

function OvernightBeat({ items }: { items: OvernightItem[] }) {
  const n = items.length;
  return (
    <>
      <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-micro)", ...rise(0) }}>
        While you slept
      </div>
      <div style={{ ...headline, fontSize: 44, letterSpacing: "-1.2px", lineHeight: 1.06, ...rise(0.15) }}>
        Cue finished
        <br />
        <span style={gradientText("var(--mv3-ring-active)")}>
          {n} {n === 1 ? "thing" : "things"}.
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 28 }}>
        {items.slice(0, 5).map((item, i) => (
          <OvernightRow key={item.id} item={item} delay={0.35 + i * 0.15} />
        ))}
        {/* Count honesty (UAT 2026-07-21): the headline counts everything,
            so the rows must account for the remainder instead of silently
            showing 5 of 6. */}
        {n > 5 ? (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              padding: "2px 4px",
              ...rise(0.35 + 5 * 0.15),
            }}
          >
            +{n - 5} more — they’re all on Today
          </div>
        ) : null}
      </div>
    </>
  );
}

function QuietBeat() {
  return (
    <>
      <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-micro)", ...rise(0) }}>
        While you slept
      </div>
      <div style={{ ...headline, fontSize: 44, letterSpacing: "-1.2px", lineHeight: 1.06, ...rise(0.15) }}>
        All quiet
        <br />
        <span style={gradientText("var(--mv3-ring-active)")}>overnight.</span>
      </div>
      <div
        style={{
          fontSize: 15,
          color: "var(--mv3-muted)",
          lineHeight: 1.6,
          marginTop: 16,
          ...rise(0.3),
        }}
      >
        Nothing needed you while you were away.
      </div>
    </>
  );
}

function AskBeat({
  assistantId,
  ask,
  onDone,
}: {
  assistantId: string;
  ask: BriefAsk;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const act = useMutation({
    mutationFn: async (action: BriefAskAction) => {
      // The declared endpoint/method, verbatim. Approvals resolve through the
      // confirm contract, which carries {requestId, decision} in the body.
      const decision =
        action.kind === "approve"
          ? "allow"
          : action.kind === "decline"
            ? "deny"
            : null;
      const opts = {
        url: action.endpoint,
        ...(decision ? { body: { requestId: ask.id, decision } } : {}),
        throwOnError: true,
      } as const;
      const method = action.method.toUpperCase();
      if (method === "GET") await client.get(opts);
      else if (method === "PATCH") await client.patch(opts);
      else if (method === "DELETE") await client.delete(opts);
      else await client.post(opts);
    },
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({
        queryKey: morningBriefQueryKey(assistantId),
      });
      onDone();
    },
  });

  const primary =
    ask.actions.find((a) => a.kind === "approve") ?? ask.actions[0];
  const secondary = ask.actions.filter((a) => a !== primary);
  const attribution = [ask.agent, ask.project].filter(Boolean).join(" · ");

  const run = (action: BriefAskAction) => {
    haptic.medium();
    if (action.kind === "open_thread") {
      // A review ask belongs in the review pager (frame 16), seeded at this
      // item — its run conversation is usually empty and reads as a dead end
      // (QA night P1-3). `ask.id` IS the work-item id for review asks.
      if (ask.kind === "review") {
        navigate(`${routes.reviewQueue}?item=${encodeURIComponent(ask.id)}`);
        return;
      }
      if (ask.conversationId)
        navigate(routes.conversation(ask.conversationId));
      return;
    }
    act.mutate(action);
  };

  return (
    <>
      <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-amber-text)", ...rise(0) }}>
        One thing needs you
      </div>
      <div style={{ ...headline, fontSize: 34, letterSpacing: "-0.9px", ...rise(0.15) }}>
        {ask.title}
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--mv3-amber-card-bg)",
          border: "1px solid var(--mv3-amber-card-border)",
          borderRadius: 20,
          padding: 16,
          marginTop: 28,
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          boxShadow: "var(--mv3-amber-card-shadow)",
          ...rise(0.35),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 11,
              flexShrink: 0,
              background:
                "color-mix(in srgb, var(--mv3-amber) 16%, transparent)",
              color: "var(--mv3-amber)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            ‖
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: "var(--mv3-text)" }}>
              {attribution || "Cue"}
            </div>
            <div style={{ fontSize: 12, color: "var(--mv3-amber)", marginTop: 2 }}>
              waited for your OK
            </div>
          </div>
        </div>
        {primary ? (
          <button
            type="button"
            className="cue-pressable"
            disabled={act.isPending}
            onClick={() => run(primary)}
            style={{
              width: "100%",
              background: "var(--mv3-amber-fill)",
              color: "var(--mv3-amber-on-fill)",
              border: "none",
              borderRadius: 13,
              padding: 12,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              marginTop: 13,
              cursor: "pointer",
              minHeight: 44,
              opacity: act.isPending ? 0.6 : 1,
            }}
          >
            {primary.label}
          </button>
        ) : null}
        {secondary.length > 0 ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {secondary.map((action) => (
              <button
                key={action.id}
                type="button"
                className="cue-pressable"
                disabled={act.isPending}
                onClick={() => run(action)}
                style={{
                  flex: 1,
                  background: "var(--mv3-btn2-bg)",
                  color: "var(--mv3-muted)",
                  border: "1px solid var(--mv3-btn2-border)",
                  borderRadius: 13,
                  padding: 10,
                  fontSize: 13,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  minHeight: 44,
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** "10:30" from an ISO time, in the user's locale. */
function timeLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

const DAY_TICKS = [
  "var(--mv3-accent)",
  "var(--mv3-green)",
  "var(--mv3-violet-glyph)",
  "var(--mv3-teal)",
];

function DayBeat({ day, onStart }: { day: DayEntry[]; onStart: () => void }) {
  const meetings = day.filter((d) => d.kind === "event").length;
  const line2 =
    day.length === 0
      ? "Nothing scheduled."
      : meetings > 0
        ? `${meetings} ${meetings === 1 ? "meeting" : "meetings"} today.`
        : `${day.length} ${day.length === 1 ? "thing" : "things"} due.`;
  return (
    <>
      <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-green)", ...rise(0) }}>
        Your day ahead
      </div>
      <div style={{ ...headline, ...rise(0.15) }}>
        <span style={gradientText("var(--mv3-green)")}>{line2}</span>
      </div>
      {day.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 24,
            ...rise(0.3),
          }}
        >
          {day.slice(0, 5).map((entry, i) => (
            <div
              key={`${entry.title}-${i}`}
              style={{ display: "flex", gap: 11, alignItems: "center" }}
            >
              <span
                style={{
                  fontFamily: mv3Mono,
                  fontSize: 11,
                  color: "var(--mv3-muted)",
                  width: 48,
                  flexShrink: 0,
                }}
              >
                {timeLabel(entry.time) ?? "—"}
              </span>
              <span
                aria-hidden
                style={{
                  width: 3,
                  height: 26,
                  borderRadius: 2,
                  flexShrink: 0,
                  background: DAY_TICKS[i % DAY_TICKS.length],
                }}
              />
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: "var(--mv3-text)",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.title}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="cue-pressable"
        onClick={(e) => {
          e.stopPropagation();
          onStart();
        }}
        style={{
          width: "max-content",
          background: "var(--mv3-text)",
          color: "var(--mv3-bg)",
          border: "none",
          borderRadius: 15,
          padding: "14px 26px",
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "inherit",
          marginTop: 30,
          cursor: "pointer",
          minHeight: 44,
          boxShadow:
            "0 12px 36px -10px color-mix(in srgb, var(--mv3-text) 30%, transparent)",
          ...rise(0.45),
        }}
      >
        Start my day →
      </button>
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* Screen                                                                    */
/* ------------------------------------------------------------------------- */

export function BriefPage() {
  const navigate = useNavigate();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { brief, isLoading, isError } = useMorningBrief(assistantId);
  const [beatIndex, setBeatIndex] = useState(0);

  // The push and Today's ritual slot are ONE door — so arriving through
  // either records the brief as read, and the slot behind this screen
  // collapses to its one-line form instead of asking again for something the
  // owner is looking at. Marking it here rather than in the slot is the whole
  // point: an owner who only ever taps the notification never sees the slot.
  useEffect(() => {
    markRitualRead("brief");
  }, []);

  const beats = useMemo(() => resolveBeats(brief), [brief]);
  const beat: BeatId | null = beats[beatIndex] ?? null;

  // The aurora sinks as the story progresses (spec: briefAurY per beat).
  const aurY = 20 + beatIndex * 20;

  const finish = () => {
    haptic.success();
    navigate(routes.hq);
  };

  const advance = () => {
    if (beats.length === 0) return;
    haptic.light();
    if (beatIndex >= beats.length - 1) {
      finish();
      return;
    }
    setBeatIndex((i) => i + 1);
  };

  return (
    <div
      data-mv3
      data-slot="mv3-brief"
      onClick={advance}
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {/* Page-local keyframes + theme gates (mv3.css is owned elsewhere). All
          transform/opacity; frozen by the shared [data-mv3] reduced-motion rule. */}
      <style>{`
        @keyframes mv3BriefTwinkle { 0%, 100% { opacity: .15; } 50% { opacity: .9; } }
        @keyframes mv3BriefShimmer { 0%, 100% { opacity: .35; } 50% { opacity: .75; } }
        .mv3-brief-star { display: none; }
        [data-theme="dark"] .mv3-brief-star,
        [data-theme="velvet"] .mv3-brief-star { display: block; }
      `}</style>

      {/* Deep centered aurora (frame 5) — static blur, transform-only drift;
          vertical center steps down per beat via translateY transition. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: "-20%",
          background:
            "radial-gradient(46% 36% at 50% 30%, var(--mv3-aurora), transparent 68%)",
          filter: "blur(32px)",
          transform: `translateY(${(aurY - 30) * 0.5}%)`,
          transition: "transform 1s ease",
          pointerEvents: "none",
          willChange: "transform",
        }}
      />
      <Stars />

      {/* Story progress — one segment per beat, filled by scaleX. */}
      <div
        style={{
          display: "flex",
          gap: 5,
          padding: `calc(${SAFE_TOP} + 10px) 22px 0`,
          flexShrink: 0,
          position: "relative",
          zIndex: 5,
        }}
      >
        {(beats.length > 0 ? beats : [0, 1, 2]).map((_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 99,
              background: "var(--mv3-track)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                background: "var(--mv3-text)",
                transform: `scaleX(${i <= beatIndex && beats.length > 0 ? 1 : 0})`,
                transformOrigin: "left",
                transition: "transform .4s ease",
              }}
            />
          </span>
        ))}
      </div>

      {/* The beat canvas. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 30px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {isLoading || !assistantId ? (
          <BriefSkeleton />
        ) : isError || !brief ? (
          <div onClick={(e) => e.stopPropagation()}>
            <div style={{ ...microLabel, fontSize: 11, letterSpacing: "0.16em", color: "var(--mv3-micro)" }}>
              Morning brief
            </div>
            <div style={{ ...headline, fontSize: 34 }}>
              Couldn&rsquo;t load your brief.
            </div>
            <button
              type="button"
              className="cue-pressable"
              onClick={finish}
              style={{
                width: "max-content",
                background: "var(--mv3-text)",
                color: "var(--mv3-bg)",
                border: "none",
                borderRadius: 15,
                padding: "14px 26px",
                fontSize: 15,
                fontWeight: 600,
                fontFamily: "inherit",
                marginTop: 26,
                cursor: "pointer",
                minHeight: 44,
              }}
            >
              Go to Today →
            </button>
          </div>
        ) : beat === "overnight" ? (
          <div key="overnight">
            <OvernightBeat items={brief.overnight} />
          </div>
        ) : beat === "quiet" ? (
          <div key="quiet">
            <QuietBeat />
          </div>
        ) : beat === "ask" && brief.ask ? (
          <div key="ask">
            <AskBeat
              assistantId={assistantId}
              ask={brief.ask}
              onDone={advance}
            />
          </div>
        ) : (
          <div key="day">
            <DayBeat day={brief.day} onStart={finish} />
          </div>
        )}
      </div>

      {/* "tap to continue" footer. */}
      <div
        style={{
          flexShrink: 0,
          padding: "0 0 10px",
          position: "relative",
          zIndex: 5,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 11, color: "var(--mv3-muted)", paddingBottom: 6 }}>
          {beats.length > 0 && beatIndex < beats.length - 1
            ? "tap to continue"
            : " "}
        </div>
      </div>
    </div>
  );
}
