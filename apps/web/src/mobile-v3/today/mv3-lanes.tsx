/**
 * The mobile lane roster (v8 M2).
 *
 * **At 390px there is no Tier 2: a lane is a card or a line, never between.**
 * Every Tier-2 card builder below returns `null`, so those lanes always demote
 * into the grey rail — that single difference is the whole of "mobile is not a
 * shrink-to-fit". Desktop can afford a middle tier because horizontal space is
 * cheap; the phone forces the question "does this lane deserve a card *today*?",
 * which is the question that fixed the desktop deck.
 *
 * Everything else — the lane ids, the two invariants, the builders — is the
 * SAME module the desktop deck uses (`@/pages/hq/hq-tiers`). That is
 * deliberate: if mobile kept its own list, a lane could be present on one
 * surface and silently absent on the other, and nothing would catch it.
 *
 * Extracted from the screen so the tier rules are testable without mounting a
 * scroll driver, an aurora and four live queries.
 */

import type { ReactElement } from "react";

import {
  arrivalsSentence,
  pulseSentence,
  type ArrivalsSummary,
} from "@/pages/hq/hq-deck";
import {
  waitingSentence,
  type DayPicture,
  type Horizon,
  type Unavailable,
  type WaitingItem,
} from "@/pages/hq/hq-k1-modules";
import {
  fromUnavailable,
  known,
  tier1,
  tier2,
  tier3,
  unavailable,
  type LaneId,
  type LaneSlot,
} from "@/pages/hq/hq-tiers";
import type { HqSchedule, HqWorkItem, Mission } from "@/pages/hq/use-missions";
import { routes } from "@/utils/routes";

export interface Mv3LaneInput {
  /** The one needs-you number, computed by HqPage (invariant 2). */
  glanceCount: number;
  reviewError: boolean;
  done: HqWorkItem[];
  doneError: boolean;
  missions: Mission[];
  missionsError: boolean;
  running: HqWorkItem[];
  cameIn: HqWorkItem[];
  day: DayPicture | null;
  dayUnavailable?: Unavailable;
  lifeGroups: { horizon: Horizon; titles: string[] }[];
  lifeUnavailable?: Unavailable;
  arrivals: ArrivalsSummary;
  arrivalsError: boolean;
  waiting: WaitingItem[];
  waitingUnavailable?: Unavailable;
  schedules: HqSchedule[];
  schedulesError: boolean;
  /** Sources currently observed AND healthy. Existing != working. */
  watchingCount: number;
  heartbeatRuns: number | null;
  /** The three Tier-1 cards, supplied by the screen. */
  cards: {
    needsYou: (count: number) => ReactElement;
    delivered: (items: HqWorkItem[]) => ReactElement;
    missions: (missions: Mission[]) => ReactElement;
  };
}

export function buildMv3Lanes(input: Mv3LaneInput): Record<LaneId, LaneSlot> {
  const {
    glanceCount,
    reviewError,
    done,
    doneError,
    missions,
    missionsError,
    running,
    cameIn,
    day,
    dayUnavailable,
    lifeGroups,
    lifeUnavailable,
    arrivals,
    arrivalsError,
    waiting,
    waitingUnavailable,
    schedules,
    schedulesError,
    watchingCount,
    heartbeatRuns,
    cards,
  } = input;

  const needsYouState = reviewError
    ? unavailable<number>("Cue couldn't read your review queue just now.")
    : known(glanceCount);
  const deliveredState = doneError
    ? unavailable<HqWorkItem[]>("Cue couldn't read what it finished today.")
    : known(done);
  const lanes: Record<LaneId, LaneSlot> = {
    needs_you: tier1("needs_you", needsYouState, cards.needsYou),
    delivered: tier1("delivered", deliveredState, cards.delivered),
    missions: tier1(
      "missions",
      missionsError
        ? unavailable<Mission[]>("Cue couldn't load your missions just now.")
        : known(missions),
      cards.missions,
    ),
    in_motion: tier2(
      "in_motion",
      known({ running, queued: cameIn }),
      () => null,
      (p) => ({
        sentence:
          p.running.length === 0 && p.queued.length === 0
            ? "Nothing is running and nothing is queued."
            : p.running.length === 0
              ? `Nothing is running — ${p.queued.length} queued.`
              : `Cue is working on ${p.running.length} ${p.running.length === 1 ? "thing" : "things"}.`,
      }),
    ),
    day: tier2(
      "day",
      fromUnavailable(day, dayUnavailable),
      () => null,
      (d) => ({
        sentence:
          d == null
            ? "Cue is still reading your calendar."
            : d.commitments.length === 0
              ? `Nothing is booked today — ${Math.floor(d.unbookedMinutes / 60)}h free.`
              : `${d.commitments.length} on your calendar today.`,
      }),
    ),
    life: tier2(
      "life",
      fromUnavailable(lifeGroups, lifeUnavailable),
      () => null,
      (groups) => {
        const n = groups.reduce((total, g) => total + g.titles.length, 0);
        return {
          sentence:
            n === 0
              ? "Nothing personal is on your list."
              : `${n} personal ${n === 1 ? "thing" : "things"} on your list.`,
        };
      },
    ),
    batch: tier2(
      "batch",
      // Shorter than desktop's on purpose: at 390px a two-line grey sentence
      // out-weighs the lane it belongs to. The promise it drops ("it will
      // offer, never merge") lives on the surface the line links to.
      unavailable<null>("Cue isn't grouping arrivals into batches yet."),
      () => null,
      () => ({ sentence: "Cue isn't batching anything." }),
    ),
    correction: tier2(
      "correction",
      known(cameIn.filter((i) => !i.projectId)),
      () => null,
      (items) => ({
        sentence:
          items.length === 0
            ? "Everything that arrived found a home."
            : `${items.length} ${items.length === 1 ? "arrival hasn't" : "arrivals haven't"} found a home yet.`,
        tone: items.length > 0 ? "attention" : "muted",
      }),
    ),
    arrivals: tier3(
      "arrivals",
      arrivalsError
        ? unavailable<ArrivalsSummary>("Cue couldn't read what arrived today.")
        : known(arrivals),
      (a) => ({
        sentence: arrivalsSentence(a),
        href: routes.cameIn,
        tone: a.kept > 0 ? "attention" : "muted",
      }),
    ),
    waiting: tier3(
      "waiting",
      fromUnavailable(waiting, waitingUnavailable),
      (items) => ({
        sentence: waitingSentence(items),
        tone: items.some((w) => w.state === "going_cold")
          ? "attention"
          : "muted",
      }),
    ),
    rhythms: tier3(
      "rhythms",
      schedulesError
        ? unavailable<HqSchedule[]>(
            "Cue couldn't read your schedules just now.",
          )
        : known(schedules),
      (ss) => ({
        sentence:
          ss.length === 0
            ? "Nothing runs on a schedule yet."
            : `${ss.length} ${ss.length === 1 ? "rhythm runs" : "rhythms run"} on their own.`,
      }),
    ),
    pulse: tier3("pulse", known({ sources: watchingCount }), (p) => ({
      sentence: pulseSentence(p.sources, heartbeatRuns, null),
    })),
  };

  return lanes;
}
