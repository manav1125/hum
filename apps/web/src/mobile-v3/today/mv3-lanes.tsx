/**
 * The mobile lane roster and its rail (v8 M2, brief §13.1).
 *
 * **At 390px a lane is a card or a line, never between.** Every absorbed-lane
 * card builder below returns `null`, so those lanes never take a card on the
 * phone — that single difference is the whole of "mobile is not a
 * shrink-to-fit". Desktop can afford a middle size because horizontal space is
 * cheap; the phone forces the question "does this deserve a card *today*?",
 * which is the question that fixed the desktop deck.
 *
 * §13.1 then answered the question that left: the phone was producing NINE grey
 * lines, four of them reporting that things which never happened had not
 * happened. A lane answers a standing question; an event either happened or it
 * didn't. So the rail is **four lines** — Arrivals, Waiting, Rhythms, Pulse —
 * and:
 *
 *   · in-motion is absorbed by the census bar, which states "N doing";
 *   · the day is absorbed by the day strip; Life by the needs-you list;
 *   · the batch offer and the filing correction are events, absent when absent.
 *
 * Everything else — the ids, the invariants, the builders — is the SAME module
 * the desktop deck uses (`@/pages/hq/hq-tiers`). That is deliberate: if mobile
 * kept its own list, a lane could be present on one surface and silently absent
 * on the other, and nothing would catch it.
 *
 * Extracted from the screen so the rules are testable without mounting a
 * scroll driver, an aurora and four live queries — which now includes the rail
 * itself, because "how many lines does a quiet phone show?" is the question
 * §13.1 turned on.
 */

import type { CSSProperties, ReactElement } from "react";
import { useNavigate } from "react-router";

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
  absorbed,
  event,
  fromUnavailable,
  known,
  laneSlotsFor,
  LANE_META,
  tier1,
  tier3,
  unavailable,
  TIER1_IDS,
  TIER2_IDS,
  TIER3_IDS,
  type LaneId,
  type LaneLine,
  type LaneSlot,
} from "@/pages/hq/hq-tiers";
import type { HqSchedule, HqWorkItem, Mission } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { mv3Mono } from "../mv3-kit";
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
    // Absorbed: the census bar at the foot of the screen states "N doing",
    // which is the answer to "is anything running?". A second grey line saying
    // the same thing in words was the noise §13.1 removed. It still gets a
    // line if the query fails — see `absorbed`.
    in_motion: absorbed(
      "in_motion",
      known({ running, queued: cameIn }),
      () =>
        // No card at 390px: a lane is a card or a line, never between, and the
        // running work already has the orbit and the WORKING NOW rows.
        null,
    ),
    // Absorbed: the day reaches the owner through the day strip, not through a
    // sentence in a grey rail.
    day: absorbed("day", fromUnavailable(day, dayUnavailable), () => null),
    // Absorbed: personal items appear in needs-you like everything else; the
    // horizon peek is a card when it is non-empty, which mobile does not build.
    life: absorbed(
      "life",
      fromUnavailable(lifeGroups, lifeUnavailable),
      () => null,
    ),
    // An event. Nobody wonders "was there a batch I missed?" — so when there
    // is no offer there is nothing, rather than a line reporting the absence
    // of a feature that does not exist yet.
    batch: event(
      "batch",
      unavailable<null>("Cue isn't grouping arrivals into batches yet."),
      () => null,
    ),
    // An event: a filing correction takes the screen when it happens. Mobile
    // has no takeover built yet, so it renders nothing — and when the takeover
    // arrives it plugs in here as this event's card.
    correction: event(
      "correction",
      known(cameIn.filter((i) => !i.projectId)),
      () => null,
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

/* -------------------------------------------------------------------------- */
/* The rail                                                                   */
/* -------------------------------------------------------------------------- */

/** One line: glyph + full sentence + the door, tappable across its width. */
export function Mv3TierLine({ id, line }: { id: LaneId; line: LaneLine }) {
  const navigate = useNavigate();
  const meta = LANE_META[id];
  const href = line.href ?? meta.href;
  return (
    <div
      data-lane={id}
      data-slot="mv3-tier-line"
      role="button"
      tabIndex={0}
      onClick={() => {
        haptic.light();
        navigate(href);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(href);
      }}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        padding: "9px 6px",
        // --mv3-muted is #9A9AA8 dark / #5A6672 light. Never #5B5B68.
        color: "var(--mv3-muted)",
        fontSize: 12.5,
        lineHeight: 1.45,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          fontFamily: mv3Mono,
          fontSize: 12,
          width: 13,
          flexShrink: 0,
          color:
            line.tone === "attention" ? "var(--mv3-amber)" : "var(--mv3-muted)",
        }}
      >
        {meta.glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{line.sentence}</span>
      <span
        aria-hidden
        style={{ fontSize: 12, flexShrink: 0, color: "var(--mv3-faint)" }}
      >
        ›
      </span>
    </div>
  );
}

/**
 * The rail at 390px — **four lines**, the same four desktop shows.
 *
 * It reads the SAME roster the cards came from, so nothing can fall between
 * the two: `laneSlotsFor` throws if a slot is neither card, line nor a
 * warranted absence, and if a standing lane is the absence. The order is
 * Tier 3 first, which is v7 §A's order and the order the desktop rail uses;
 * the only thing that ever joins the four is an absorbed lane that could not
 * be queried, which says so in words.
 */
export function Mv3TierRail({
  lanes,
  style,
}: {
  lanes: Record<LaneId, LaneSlot>;
  style?: CSSProperties;
}) {
  const { lines } = laneSlotsFor(lanes);
  const order: readonly LaneId[] = [...TIER3_IDS, ...TIER2_IDS, ...TIER1_IDS];
  const railLines = [...lines].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
  );
  if (railLines.length === 0) return null;
  return (
    <div
      data-slot="mv3-tier-rail"
      style={{
        borderTop: "1px solid var(--mv3-line)",
        paddingTop: 6,
        ...style,
      }}
    >
      {railLines.map((slot) => (
        <Mv3TierLine key={slot.id} id={slot.id} line={slot.line} />
      ))}
    </div>
  );
}
