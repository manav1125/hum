/**
 * The day strip (v23 C1) — the first thing HQ carries, and the smallest
 * possible picture of today.
 *
 * Desktop draws a `DayRail` with real hour ticks, a now-marker and a named free
 * block. At 390px the ticks are noise, so this is the same data compressed to a
 * 16px band: booked time solid, unbooked time recessed, and the one free block
 * worth spending named inside itself.
 *
 * ## Three rules it obeys, and each one has cost somebody a day
 *
 * **A failed fetch is an error state, never an empty one.** `unavailable`
 * renders Cue's own sentence about not being able to read the calendar. A
 * silent absence here is indistinguishable from a genuinely empty day, which is
 * the difference between "you're free" and "I don't know".
 *
 * **An empty day says why.** "Nothing is booked" is a fact worth stating; a
 * blank band is a rendering bug.
 *
 * **The free block's label is a computed minute count or it is absent.** There
 * is no fallback phrasing, because the alternative to a real number here is a
 * fake one and this band's whole value is that "3h free" is true.
 *
 * **A free block that has already ended is not free.** The daemon computes the
 * largest gap across the whole working window, so at 23:11 the block it returns
 * may have closed eleven hours ago. Rendering it as a teal, present-tense offer
 * is a fake number in the most load-bearing place on the screen — the minutes
 * are real, but "you have 15m free" is not true any more. Past gaps fall back
 * to plain idle and drop out of the sentence. See {@link activeFreeBlock}.
 *
 * **The band says its own sentence, out loud.** It used to carry the sentence
 * as an `aria-label` and nothing else, which left sighted readers a run of
 * unlabelled bars — indistinguishable from placeholder art, and reported as
 * exactly that ("that calendar doesn't seem to be connected to anything").
 * A picture of your day that cannot say whose day it is has not earned trust.
 */

import { useEffect, useState } from "react";

import type { DayPicture, Unavailable } from "@/pages/hq/hq-k1-modules";

import { mv3Mono } from "../mv3-kit";

/** The window the band covers. Same 8→19 as the desktop rail. */
export const RAIL_START_HOUR = 8;
export const RAIL_END_HOUR = 19;

interface Segment {
  kind: "busy" | "idle" | "free";
  /** Flex weight, in minutes. Never zero — a zero-weight segment vanishes. */
  minutes: number;
  label: string | null;
}

/** "3h free" / "45m free". Minutes below a quarter hour are not a block. */
export function freeLabel(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes < 15) return null;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest}m free`;
  if (rest === 0) return `${hours}h free`;
  return `${hours}h ${rest}m free`;
}

/**
 * The free block, but only while it is still ahead of you.
 *
 * `largestFreeBlock` covers the whole 09:00–18:00 working window, so it keeps
 * being returned long after it has passed. An offer you can no longer take is
 * not an offer, so once the block has ended the band shows the gap as ordinary
 * unbooked time and says nothing about it.
 */
export function activeFreeBlock(
  day: DayPicture,
  nowMs: number,
): DayPicture["freeBlock"] {
  const block = day.freeBlock;
  if (!block) return null;
  return block.endMs > nowMs ? block : null;
}

/**
 * A per-minute clock for the band.
 *
 * The screen stamps `Date.now()` once per mount, which is right for the rail's
 * bounds (they do not move) and wrong for the free block: a session left open
 * across lunch would go on advertising a gap that closed while it sat there.
 * Minute granularity is all the band can express, so that is all it ticks at.
 */
export function useDayClock(initialMs: number): number {
  const [now, setNow] = useState(initialMs);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 60_000);
    // WKWebView throttles or suspends timers on a backgrounded tab, which is
    // precisely the case that matters here: the phone goes in a pocket at
    // noon and comes out at eleven. Catching up on resume is what stops the
    // band greeting him with a free block that ended hours ago.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}

function railBounds(nowMs: number): { start: number; end: number } {
  const start = new Date(nowMs);
  start.setHours(RAIL_START_HOUR, 0, 0, 0);
  const end = new Date(nowMs);
  end.setHours(RAIL_END_HOUR, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * Turn the day into a run of weighted segments.
 *
 * Exported because this is the whole of the band's honesty and it is worth
 * testing without a DOM: overlapping commitments merge (two calendars showing
 * the same meeting must not read as two meetings back to back), everything is
 * clamped to the rail, and the free block only becomes its own segment when it
 * actually lands inside an idle stretch.
 */
export function daySegments(day: DayPicture, nowMs: number): Segment[] {
  const { start, end } = railBounds(nowMs);
  const span = end - start;
  if (span <= 0) return [];

  const busy = day.commitments
    .map((c) => ({
      from: Math.max(start, Math.min(end, c.startMs)),
      to: Math.max(start, Math.min(end, c.endMs)),
    }))
    .filter((c) => c.to > c.from)
    .sort((a, b) => a.from - b.from);

  const merged: { from: number; to: number }[] = [];
  for (const block of busy) {
    const last = merged[merged.length - 1];
    if (last && block.from <= last.to) last.to = Math.max(last.to, block.to);
    else merged.push({ ...block });
  }

  // Only a block you can still take earns the teal treatment and the label.
  const block = activeFreeBlock(day, nowMs);
  const free = block
    ? {
        from: Math.max(start, Math.min(end, block.startMs)),
        to: Math.max(start, Math.min(end, block.endMs)),
        minutes: block.minutes,
      }
    : null;

  const out: Segment[] = [];
  const idle = (from: number, to: number) => {
    if (to <= from) return;
    // The free block is an idle stretch that earned a name. Split around it.
    if (free && free.to > from && free.from < to) {
      idle2(from, Math.max(from, free.from));
      out.push({
        kind: "free",
        minutes: Math.max(1, (Math.min(to, free.to) - Math.max(from, free.from)) / 60_000),
        label: freeLabel(free.minutes),
      });
      idle2(Math.min(to, free.to), to);
      return;
    }
    idle2(from, to);
  };
  const idle2 = (from: number, to: number) => {
    if (to <= from) return;
    out.push({ kind: "idle", minutes: (to - from) / 60_000, label: null });
  };

  let cursor = start;
  for (const block of merged) {
    idle(cursor, block.from);
    out.push({
      kind: "busy",
      minutes: (block.to - block.from) / 60_000,
      label: null,
    });
    cursor = block.to;
  }
  idle(cursor, end);
  return out;
}

/** The band's sentence, shown and announced. Says what the bars say. */
export function daySentence(day: DayPicture, nowMs: number): string {
  const count = day.commitments.length;
  const block = activeFreeBlock(day, nowMs);
  const free = block ? freeLabel(block.minutes) : null;
  const booked =
    count === 0
      ? "Nothing is booked today"
      : `${count} ${count === 1 ? "commitment" : "commitments"} today`;
  return free ? `${booked} · ${free}` : booked;
}

const FILL: Record<Segment["kind"], string> = {
  busy: "var(--mv3-text)",
  idle: "var(--mv3-track)",
  free: "color-mix(in srgb, var(--mv3-teal) 22%, transparent)",
};

export function Mv3DayStrip({
  day,
  unavailable,
  nowMs,
  style,
}: {
  day: DayPicture | null;
  unavailable?: Unavailable;
  /** Hoisted by the caller — reading the clock during render is impure. */
  nowMs: number;
  style?: React.CSSProperties;
}) {
  // Cue reports its own errors first, verbatim, first person.
  if (unavailable) {
    return (
      <div
        data-slot="mv3-day-strip"
        role="status"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11.5,
          color: "var(--mv3-fail-text)",
          padding: "3px 2px",
          ...style,
        }}
      >
        <span aria-hidden style={{ fontFamily: mv3Mono }}>
          ◼
        </span>
        <span>{unavailable.reason}</span>
      </div>
    );
  }
  if (!day) return null;

  const segments = daySegments(day, nowMs);
  const sentence = daySentence(day, nowMs);

  if (segments.every((s) => s.kind !== "busy")) {
    // An empty day is a fact, and one worth the row. The band would be a
    // single flat bar carrying no information, so the sentence stands alone.
    return (
      <div
        data-slot="mv3-day-strip"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11.5,
          color: "var(--mv3-muted)",
          padding: "3px 2px",
          ...style,
        }}
      >
        <span aria-hidden style={{ fontFamily: mv3Mono, width: 13 }}>
          ◱
        </span>
        <span>{sentence}. Nothing is holding your day.</span>
      </div>
    );
  }

  return (
    <div
      data-slot="mv3-day-strip"
      style={{ display: "flex", flexDirection: "column", gap: 5, ...style }}
    >
      {/* The bars are the picture; the sentence below is the accessible name,
          so the band itself is decorative rather than a second announcement. */}
      <div aria-hidden style={{ display: "flex", gap: 2, height: 16 }}>
        {segments.map((segment, i) => (
          <div
            key={i}
            style={{
              flex: Math.max(0.4, segment.minutes),
              minWidth: segment.label ? 44 : 3,
              borderRadius: 4,
              background: FILL[segment.kind],
              ...(segment.kind === "free"
                ? {
                    border:
                      "1px dashed color-mix(in srgb, var(--mv3-teal) 50%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }
                : {}),
            }}
          >
            {segment.label ? (
              <span
                style={{
                  fontSize: 8,
                  fontWeight: 600,
                  color: "var(--mv3-teal-text)",
                  whiteSpace: "nowrap",
                }}
              >
                {segment.label}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div
        data-slot="mv3-day-sentence"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11.5,
          color: "var(--mv3-muted)",
          padding: "0 2px",
        }}
      >
        <span aria-hidden style={{ fontFamily: mv3Mono, width: 13 }}>
          ◱
        </span>
        <span>{sentence}</span>
      </div>
    </div>
  );
}
