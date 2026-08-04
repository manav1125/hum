/**
 * The HQ census — **the hinge between Glance and Deck**.
 *
 * HQ is one surface at two densities. Glance shows a footer strip of five
 * tappable numbers; Deck shows five live rail tiles. Design's rule is that
 * those are *the same data, collapsed vs expanded* — "nothing appears or
 * disappears between views, it gains detail". This module is where that stops
 * being an intention and becomes a property of the code:
 *
 *   **Both densities render from one exhaustive `Record<HqLaneId, HqLaneReading>`
 *   built by one function.** The strip cannot show a number the rail does not,
 *   because there is only one number, minted once, in here.
 *
 * ## The three rules this file enforces
 *
 * **1 · A lane can never be silently absent.** {@link buildHqCensus} returns an
 * exhaustive record — TypeScript will not let the literal omit an id — and
 * {@link GLANCE_SLOT} / {@link DECK_SLOT} declare, per lane, where it renders
 * in *each* density. Neither slot has a "nowhere" member, so a lane that shows
 * up in Deck and quietly vanishes from Glance is not expressible.
 *
 * Two lanes are asymmetric, and that asymmetry is design's own frame rather
 * than a hole: `needs_you` is a strip number in Glance and the *centre column*
 * in Deck (it gains rows); `in_motion` is a rail tile in Deck and rides the
 * greeting subline in Glance (the phone-sized version of the same fact). Both
 * are declared, and {@link stripCells} / {@link railTiles} assert at runtime
 * that the ordered tuples match the declarations exactly — drop a lane from
 * either order and it throws rather than disappearing.
 *
 * **2 · Never a fake number.** Every stat is a function of a
 * {@link LaneState} the caller actually queried, minted through
 * {@link counted} — the same opaque `Queried` brand the tier machinery uses,
 * which has no literal. A lane we could not read produces
 * `{ kind: "unknown", why }`, and the surfaces render the sentence instead of
 * a digit. There is deliberately no third option: a zero we did not measure is
 * a claim, not an absence.
 *
 * **3 · A number you can tap must be reachable by tapping it.** Every reading
 * carries an `href` *and* a `deck` slot, and the Glance strip routes to that
 * slot. A lane whose stat is `unknown` is not tappable — an unreachable number
 * and a fabricated one are the same defect.
 *
 * ## What the numbers actually are
 *
 * Each is named here because the label is half the honesty:
 *
 *   · `needs_you` — the ONE needs-you set (invariant 2): `awaiting_review`
 *     items assigned to you, plus paused runs, plus the next move when it is
 *     neither. Computed once by the page and shared with the sidebar badge.
 *   · `blocked` — missions whose ring is `blocked` (paused, budget-stopped or
 *     abandoned). Blocked-ness is drawn ONCE, here, and the Missions tile is
 *     the only place it appears.
 *   · `holding` — queued work items. The detail line splits out the ones the
 *     pre-run assessor is holding for a word from you, because "none need you"
 *     is false the moment one of them has a `clarify`/`blocked` verdict.
 *   · `filed` — arrivals filed by the gate over **the window the daemon
 *     actually reports**. HQ asks for `since=today` in its own timezone, and
 *     when the daemon confirms it bounded the day there, the label reads
 *     TODAY. When the daemon reports a trailing window instead — an older
 *     build, a dropped parameter, a rolled-back route — the label reverts to
 *     `· 24H` on its own. See {@link FiledWindow}: the label is derived from
 *     what came back, never from what was asked for.
 *   · `in_motion` — running work items, plus live schedules and the next fire.
 *   · `watching` — watchers that are enabled AND not currently erroring.
 *     Existing is not working; the erroring ones are named, never counted in.
 *
 * The valve (C1) shrinks what reaches these lanes upstream, in the watcher
 * pipeline. Nothing here needs to know whether it has landed: these read
 * whatever the daemon returns, so a post-valve account simply reports smaller
 * true numbers than a pre-valve one.
 */

import { relativeTime } from "@/domains/activity/theme";
import { routes } from "@/utils/routes";

import { holdsForYou } from "./assessment-kit";
import type { ArrivalsSummary } from "./hq-deck";
import { counted, type LaneState } from "./hq-tiers";
import {
  ringStatusFor,
  type HqSchedule,
  type HqWorkItem,
  type Mission,
} from "./use-missions";

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

export type HqLaneId =
  "needs_you" | "blocked" | "holding" | "filed" | "in_motion" | "watching";

export const HQ_LANE_IDS = [
  "needs_you",
  "blocked",
  "holding",
  "filed",
  "in_motion",
  "watching",
] as const;

/** Compile-time proof the tuple covers the union. */
type UncoveredLane = Exclude<HqLaneId, (typeof HQ_LANE_IDS)[number]>;
const _everyLaneIsListed: UncoveredLane extends never ? true : never = true;
void _everyLaneIsListed;

/**
 * Where a lane renders in Glance. **No "nowhere" member, on purpose.**
 *
 * `strip` is one of the five footer numbers. `subline` is the greeting's
 * second line — smaller, but still a statement on the screen, which is what
 * stops "collapsed" from becoming "dropped".
 */
export type GlanceSlot = "strip" | "subline";

/**
 * Where a lane renders in Deck. Also with no "nowhere".
 *
 * `rail` is one of the five 300px tiles. `centre` is the main column, which is
 * where needs-you expands from a number into capped rows.
 */
export type DeckSlot = "rail" | "centre";

export const GLANCE_SLOT: Record<HqLaneId, GlanceSlot> = {
  needs_you: "strip",
  blocked: "strip",
  holding: "strip",
  filed: "strip",
  in_motion: "subline",
  watching: "strip",
};

export const DECK_SLOT: Record<HqLaneId, DeckSlot> = {
  needs_you: "centre",
  blocked: "rail",
  holding: "rail",
  filed: "rail",
  in_motion: "rail",
  watching: "rail",
};

/** Design's Glance order: Need you · Blocked · Holding · Filed · Watching. */
export const STRIP_ORDER = [
  "needs_you",
  "blocked",
  "holding",
  "filed",
  "watching",
] as const satisfies readonly HqLaneId[];

/** Design's Deck rail order: Missions · Holding · Came in · In motion · Watching. */
export const RAIL_ORDER = [
  "blocked",
  "holding",
  "filed",
  "in_motion",
  "watching",
] as const satisfies readonly HqLaneId[];

// ---------------------------------------------------------------------------
// A reading
// ---------------------------------------------------------------------------

/**
 * A lane's number, or the sentence saying why there isn't one.
 *
 * `unknown` is not "zero we didn't check" — it prints no digit at all. That
 * distinction is the whole point: a count that is really a page size, a drained
 * window or an unreachable query must not be rendered as a fact.
 */
export type LaneStat =
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "unknown"; readonly why: string };

/**
 * Tone always travels with a glyph — no state on this surface is carried by
 * colour alone (the contrast rule, and the reason every strip cell prints its
 * mark).
 */
export type LaneTone = "neutral" | "good" | "attention" | "alarm";

export interface HqLaneReading {
  readonly id: HqLaneId;
  /** Mono all-caps footer label — "NEED YOU", "FILED · 24H". */
  readonly stripLabel: string;
  /** The Deck tile's heading — "Missions", "Cue is holding". */
  readonly tileTitle: string;
  readonly glyph: string;
  readonly tone: LaneTone;
  readonly stat: LaneStat;
  /**
   * The expanded sentence. A pure function of the same payload the stat came
   * from, so it can never carry a number the lane did not query.
   */
  readonly detail: string;
  /**
   * A second, quieter sentence the surface must show wherever it shows the
   * lane — the valve's honesty note.
   *
   * It is separate from {@link detail} because the two have different homes.
   * `detail` is the rail tile's body, and needs-you has no rail tile; its
   * caveat has to reach GLANCE, where the lane is nothing but a number. Folding
   * this into `detail` is how "57 need you" spent a render looking like a
   * valve-filtered 57 when the valve had never judged one of them.
   */
  readonly caveat: string | null;
  /** The door this lane opens when you leave HQ for it. */
  readonly href: string;
  readonly glance: GlanceSlot;
  readonly deck: DeckSlot;
}

export type HqCensus = Record<HqLaneId, HqLaneReading>;

// ---------------------------------------------------------------------------
// Shared derivations — used by BOTH the census and the tiles that draw them
// ---------------------------------------------------------------------------

/**
 * The blocked missions.
 *
 * Exported because the rail's Missions tile draws rings from the mission list
 * while the strip prints a count: if each derived "blocked" its own way they
 * could disagree, and the tile sitting beside the number is exactly where that
 * would be visible. One function, both callers.
 */
export function blockedMissions(missions: Mission[]): Mission[] {
  return missions.filter((m) => ringStatusFor(m) === "blocked");
}

/** Queued items the pre-run assessor is holding for a word from the owner. */
export function heldForYou(items: HqWorkItem[]): HqWorkItem[] {
  return items.filter((item) => holdsForYou(item) !== null);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A watcher, narrowed to what the census needs to be honest about it. */
export interface WatcherReading {
  readonly id: string;
  readonly name: string;
  /**
   * When the watcher last *polled*. Deliberately not called "last hit" — a
   * poll clock is not evidence anything arrived, and reporting it as one is a
   * mistake this surface has made before.
   */
  readonly lastPollAt: number | null;
}

/**
 * What the volume valve is doing, right now, over ALL open work.
 *
 * Both densities read these off the census, which is the whole answer to "wire
 * the strip to a filtered count and the rail to an unfiltered one and the hinge
 * breaks": there is one source, and it is this.
 */
export interface ValveFacts {
  /** Where the owner set the control. */
  stop: "everything" | "needs_you" | "only_urgent";
  /** Open work the valve is holding back. Still in Work, a stop-change away. */
  held: number;
  /**
   * Of what IS in front of you, how many are there only because the valve has
   * never sized them up. Unknown is the loudest band by design, so this number
   * means the valve is doing LESS than the lane suggests — never more.
   */
  unbanded: number;
}

/**
 * What the arrivals response said its own lower bound was.
 *
 * This exists so the FILED label is a function of the answer rather than of
 * the question. HQ asks for `since=today`; if that parameter is ever dropped,
 * unhonoured, or served by a daemon that predates it, the response comes back
 * describing a trailing window and this type carries that fact all the way to
 * the label — which then says `· 24H` again with no code change and no lie in
 * between.
 *
 * `unstated` is the third case on purpose: a bound with no calendar meaning
 * (an explicit instant) has no honest short label, so the surface says nothing
 * about the window rather than picking the nearest-sounding one.
 */
export type FiledWindow =
  | { readonly kind: "local_day"; readonly timeZone: string | null }
  | { readonly kind: "trailing"; readonly hours: number }
  | { readonly kind: "unstated" };

/**
 * Read the window off an arrivals response.
 *
 * Deliberately tolerant of a response that has never heard of `bound`: an
 * older daemon returns `windowHours` and nothing else, and that must degrade
 * to the trailing label rather than to a crash or to a confident "today".
 */
export function filedWindowOf(payload: {
  bound?: string | null;
  windowHours?: number | null;
  timeZone?: string | null;
}): FiledWindow {
  if (payload.bound === "local_day") {
    return { kind: "local_day", timeZone: payload.timeZone ?? null };
  }
  // No `bound` at all is the old contract, which was always trailing.
  if (
    (payload.bound == null || payload.bound === "trailing_window") &&
    typeof payload.windowHours === "number"
  ) {
    return { kind: "trailing", hours: payload.windowHours };
  }
  return { kind: "unstated" };
}

/** The mono strip label's window clause — empty when there is nothing true to say. */
function filedStripLabel(window: FiledWindow): string {
  switch (window.kind) {
    case "local_day":
      return "FILED TODAY";
    case "trailing":
      return `FILED · ${window.hours}H`;
    case "unstated":
      return "FILED";
  }
}

/** The same window, in the detail sentence's voice. */
function filedWindowPhrase(window: FiledWindow): string {
  switch (window.kind) {
    case "local_day":
      return "today";
    case "trailing":
      return `last ${window.hours}h`;
    case "unstated":
      return "so far";
  }
}

export interface HqCensusInput {
  /** The one needs-you number, computed once by the page (invariant 2). */
  needsYou: LaneState<number>;
  /**
   * The valve's own census. `unavailable` while it has not answered — a valve
   * we could not read must not render as a valve that is holding nothing.
   */
  valve: LaneState<ValveFacts>;
  /** Open missions (achieved ones excluded by the caller). */
  missions: LaneState<Mission[]>;
  /** Queued work items. */
  holding: LaneState<HqWorkItem[]>;
  /**
   * The arrivals census AND the window it actually covers. The window is part
   * of the payload rather than a constant here, because the label is only
   * honest if it comes from the same response as the count.
   */
  arrivals: LaneState<ArrivalsSummary & { window: FiledWindow }>;
  inMotion: LaneState<{ running: HqWorkItem[]; schedules: HqSchedule[] }>;
  /** Watchers split by health. `live` = enabled and not erroring. */
  watching: LaneState<{
    live: WatcherReading[];
    failing: WatcherReading[];
  }>;
}

// ---------------------------------------------------------------------------
// Sentences (pure, so they are testable without a DOM)
// ---------------------------------------------------------------------------

function needsYouDetail(n: number): string {
  if (n === 0) return "Nothing needs you. Go do something else.";
  return `${n} ${n === 1 ? "thing needs" : "things need"} you.`;
}

/**
 * The sentence that stops an unfiltered lane passing for a filtered one.
 *
 * `unbanded` items are in front of you because the valve has never sized them
 * up, not because it decided they mattered. Saying so is the difference between
 * "the valve chose these six" and "the valve has not looked at five of these
 * six" — and only one of those is true on the day it ships.
 */
function unbandedNote(v: ValveFacts, shown: number): string | null {
  if (v.unbanded <= 0) return null;
  if (shown > 0 && v.unbanded >= shown) {
    return `The valve hasn't sized ${shown === 1 ? "this one" : "any of these"} up yet — ${shown === 1 ? "it's" : "they're"} loud by default`;
  }
  return `${v.unbanded} of ${shown} not sized up by the valve yet`;
}

function missionsDetail(missions: Mission[]): string {
  const total = missions.length;
  if (total === 0) return "No missions yet — Cue still catches what comes in.";
  const blocked = blockedMissions(missions).length;
  const many = total === 1 ? "mission" : "missions";
  if (blocked === 0) return `${total} ${many} · none blocked.`;
  return `${total} ${many} · ${blocked} blocked on your call.`;
}

function holdingDetail(items: HqWorkItem[]): string {
  const n = items.length;
  if (n === 0) return "Nothing is queued.";
  const held = heldForYou(items).length;
  const queued = `${n} queued`;
  if (held === 0) return `${queued} — none of them are waiting on you.`;
  return `${queued} · ${held} waiting on a word from you.`;
}

/**
 * What the valve is holding back, appended to the holding lane.
 *
 * It is stated rather than counted into the number above it, because the two
 * are different sets: the stat is work Cue has queued to DO, and this is work
 * the valve has decided not to interrupt you with. Folding them would produce
 * one number that answers neither question. The door is All work, which asks
 * for no stop and therefore shows every one of them.
 */
function valveHeldNote(v: ValveFacts): string | null {
  if (v.held <= 0) return null;
  return `${v.held} more held back — in Work, nothing lost`;
}

function filedDetail(a: ArrivalsSummary & { window: FiledWindow }): string {
  const window = filedWindowPhrase(a.window);
  if (a.total === 0) {
    // Refusing to say "all quiet": nothing arriving because nothing is
    // watching is a different fact, and the watching lane one tile down is
    // where that gets answered.
    return a.window.kind === "local_day"
      ? "Nothing has arrived today."
      : `Nothing arrived in the ${window}.`;
  }
  const kept =
    a.kept > 0 ? ` · ${a.kept} kept for you` : " · none needed surfacing";
  return `${a.filed} filed${kept} — ${window}, nothing lost.`;
}

function inMotionDetail(p: {
  running: HqWorkItem[];
  schedules: HqSchedule[];
}): string {
  const head =
    p.running.length === 0
      ? "Nothing is running"
      : `${p.running.length} running`;
  if (p.schedules.length === 0) return `${head} · nothing on a schedule.`;
  const many = p.schedules.length === 1 ? "rhythm" : "rhythms";
  const next = relativeTime(p.schedules[0]!.nextRunAt);
  return `${head} · ${p.schedules.length} ${many}${next ? ` · next ${next}` : ""}.`;
}

function watchingDetail(p: {
  live: WatcherReading[];
  failing: WatcherReading[];
}): string {
  if (p.live.length === 0 && p.failing.length === 0) {
    return "Nothing is watched yet — Cue only works when you ask.";
  }
  if (p.failing.length > 0) {
    const which =
      p.failing.length === 1
        ? p.failing[0]!.name
        : `${p.failing.length} sources`;
    return p.live.length === 0
      ? `${which} can't be reached — nothing is being watched.`
      : `${p.live.length} watching · ${which} can't be reached.`;
  }
  const names = p.live
    .slice(0, 3)
    .map((w) => w.name)
    .join(" · ");
  // The poll clock, named as a poll clock. `lastPollAt` says Cue looked; it
  // says nothing whatever about anything having arrived.
  const polls = p.live
    .map((w) => w.lastPollAt)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const last = polls.length > 0 ? relativeTime(Math.max(...polls)) : null;
  return last ? `${names} · checked ${last}` : `${names} · not checked yet`;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Turn a queried payload into a stat, or into the reason there isn't one.
 *
 * `counted` is the only mint for a `Queried`, and it refuses an `unavailable`
 * lane — so this function is the single choke point through which a number can
 * reach either density, and it physically cannot be handed a literal.
 */
function statOf<T>(state: LaneState<T>, of: (payload: T) => number): LaneStat {
  const q = counted(state, of);
  if (q == null) {
    return {
      kind: "unknown",
      why:
        state.kind === "unavailable" ? state.reason : "Cue couldn't read it.",
    };
  }
  return { kind: "count", value: q.value };
}

/** The detail sentence, or the unavailable reason. Same choke point, in words. */
function detailOf<T>(
  state: LaneState<T>,
  sentence: (payload: T) => string,
): string {
  return state.kind === "known" ? sentence(state.payload) : state.reason;
}

/**
 * A valve fact about this lane, or null — only ever when the valve answered.
 *
 * A valve we could not read contributes nothing, exactly like every other
 * unqueried number on this surface: `?? 0` here would have every first paint
 * claim the valve is holding nothing back.
 */
function valveNote(
  valve: LaneState<ValveFacts>,
  note: (facts: ValveFacts) => string | null,
): string | null {
  if (valve.kind !== "known") return null;
  const extra = note(valve.payload);
  return extra ? `${extra}.` : null;
}

function toneFor(stat: LaneStat, hot: (n: number) => LaneTone): LaneTone {
  return stat.kind === "count" ? hot(stat.value) : "neutral";
}

/**
 * Build every lane, once, for both densities.
 *
 * The return type is exhaustive: adding an `HqLaneId` without adding it here is
 * a compile error, which is the structural half of "a lane can never be
 * silently absent".
 */
export function buildHqCensus(input: HqCensusInput): HqCensus {
  const needsYouStat = statOf(input.needsYou, (n) => n);
  const blockedStat = statOf(
    input.missions,
    (ms) => blockedMissions(ms).length,
  );
  const holdingStat = statOf(input.holding, (items) => items.length);
  const filedStat = statOf(input.arrivals, (a) => a.filed);
  const inMotionStat = statOf(input.inMotion, (p) => p.running.length);
  const watchingStat = statOf(input.watching, (p) => p.live.length);

  // A lane we could not read has no window to describe, so it gets the bare
  // label — same rule as the stat above it: no reading, no claim.
  const filedWindow: FiledWindow =
    input.arrivals.kind === "known"
      ? input.arrivals.payload.window
      : { kind: "unstated" };

  return {
    needs_you: {
      id: "needs_you",
      stripLabel: "NEED YOU",
      tileTitle: "Needs you",
      glyph: "‖",
      tone: toneFor(needsYouStat, (n) => (n > 0 ? "attention" : "good")),
      stat: needsYouStat,
      detail: detailOf(input.needsYou, needsYouDetail),
      // The lane is post-valve, so it has to be able to say when the valve has
      // not actually judged what is in it — and to say it on GLANCE, where the
      // lane is a bare number with nowhere else to put the truth.
      caveat: valveNote(input.valve, (v) =>
        needsYouStat.kind === "count" && needsYouStat.value > 0
          ? unbandedNote(v, needsYouStat.value)
          : null,
      ),
      href: routes.reviewQueue,
      glance: GLANCE_SLOT.needs_you,
      deck: DECK_SLOT.needs_you,
    },
    blocked: {
      id: "blocked",
      stripLabel: "BLOCKED",
      tileTitle: "Missions",
      glyph: "◼",
      tone: toneFor(blockedStat, (n) => (n > 0 ? "alarm" : "neutral")),
      stat: blockedStat,
      detail: detailOf(input.missions, missionsDetail),
      caveat: null,
      href: routes.allWork,
      glance: GLANCE_SLOT.blocked,
      deck: DECK_SLOT.blocked,
    },
    holding: {
      id: "holding",
      stripLabel: "HOLDING",
      tileTitle: "Cue is holding",
      glyph: "◷",
      tone: "neutral",
      stat: holdingStat,
      detail: detailOf(input.holding, holdingDetail),
      caveat: valveNote(input.valve, valveHeldNote),
      href: routes.allWork,
      glance: GLANCE_SLOT.holding,
      deck: DECK_SLOT.holding,
    },
    filed: {
      id: "filed",
      // The window comes off the response, never off a hope. HQ asks for
      // `since=today`, but this label reads the bound the daemon says it
      // actually used — so the day the parameter stops being honoured, the
      // label stops saying TODAY by itself. A label that lies about its window
      // is a fake number with extra steps.
      stripLabel: filedStripLabel(filedWindow),
      tileTitle: "Came in",
      glyph: "↴",
      tone: "neutral",
      stat: filedStat,
      detail: detailOf(input.arrivals, filedDetail),
      caveat: null,
      href: routes.allWork,
      glance: GLANCE_SLOT.filed,
      deck: DECK_SLOT.filed,
    },
    in_motion: {
      id: "in_motion",
      stripLabel: "IN MOTION",
      tileTitle: "In motion",
      glyph: "◉",
      tone: "neutral",
      stat: inMotionStat,
      detail: detailOf(input.inMotion, inMotionDetail),
      caveat: null,
      href: routes.allWork,
      glance: GLANCE_SLOT.in_motion,
      deck: DECK_SLOT.in_motion,
    },
    watching: {
      id: "watching",
      stripLabel: "WATCHING",
      tileTitle: "Watching",
      glyph: "✧",
      tone:
        input.watching.kind === "known" && input.watching.payload.failing.length
          ? "alarm"
          : toneFor(watchingStat, (n) => (n > 0 ? "good" : "attention")),
      stat: watchingStat,
      detail: detailOf(input.watching, watchingDetail),
      caveat: null,
      href: routes.automations,
      glance: GLANCE_SLOT.watching,
      deck: DECK_SLOT.watching,
    },
  };
}

// ---------------------------------------------------------------------------
// The two views onto it
// ---------------------------------------------------------------------------

function readingsFor(
  census: HqCensus,
  order: readonly HqLaneId[],
  expected: (id: HqLaneId) => boolean,
  what: string,
): HqLaneReading[] {
  const missing = HQ_LANE_IDS.filter(
    (id) => expected(id) && !order.includes(id),
  );
  if (missing.length > 0) {
    // A lane declared for this density but left out of its order would be
    // exactly the silent disappearance the hinge exists to prevent — so it is
    // a throw, not a filtered-out row.
    throw new Error(
      `HQ ${what} order is missing declared lane(s): ${missing.join(", ")}.`,
    );
  }
  const stray = order.filter((id) => !expected(id));
  if (stray.length > 0) {
    throw new Error(
      `HQ ${what} order carries lane(s) not declared for it: ${stray.join(", ")}.`,
    );
  }
  return order.map((id) => census[id]);
}

/**
 * The Glance footer, in design's order. Throws if a strip lane went missing.
 *
 * `order` is a parameter rather than a closed-over constant purely so the guard
 * itself is testable: a check nobody has ever seen fail is a check you are
 * trusting, not one you have verified.
 */
export function stripCells(
  census: HqCensus,
  order: readonly HqLaneId[] = STRIP_ORDER,
): HqLaneReading[] {
  return readingsFor(
    census,
    order,
    (id) => GLANCE_SLOT[id] === "strip",
    "strip",
  );
}

/** The Deck rail, in design's order. Throws if a rail lane went missing. */
export function railTiles(
  census: HqCensus,
  order: readonly HqLaneId[] = RAIL_ORDER,
): HqLaneReading[] {
  return readingsFor(census, order, (id) => DECK_SLOT[id] === "rail", "rail");
}

/** The lanes Glance carries in the greeting subline rather than the strip. */
export function sublineLanes(census: HqCensus): HqLaneReading[] {
  return HQ_LANE_IDS.filter((id) => GLANCE_SLOT[id] === "subline").map(
    (id) => census[id],
  );
}

/**
 * Is this number safe to offer as a tap target?
 *
 * Only a queried count is. An `unknown` stat has no lane state to scroll to and
 * no digit to justify the affordance — and a tappable number that cannot be
 * reached by tapping it is the same defect as an invented one.
 */
export function isTappable(reading: HqLaneReading): boolean {
  return reading.stat.kind === "count";
}
