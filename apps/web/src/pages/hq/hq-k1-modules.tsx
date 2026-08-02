/**
 * The canonical HQ modules that had no implementation before — trust chip, lens
 * switch, day rail, Life horizons, agents-now, and waiting-on-people.
 *
 * Built from `docs/design/handoff-2026-08-01/01-work-surfaces/canonical/
 * cue-canonical.html` (K1) and WORK-SURFACES.md §2, §5, §6, §7.
 *
 * **"Every module renders, always" is retired** (v7 §A). These used to take a
 * required `Unavailable` reason so a module could never go quiet; the reason was
 * right and the mechanism was wrong. Honesty requires a lane never be silently
 * absent and never fake a number — it does not require a card. The render
 * policy now lives one level up in {@link ./hq-tiers}, which places each of
 * these in a tier and demotes an empty one to a grey line rather than dropping
 * it. So the components below are simply the CARD form of a lane: they are only
 * ever handed data that was actually queried, which is why none of them carries
 * an `unavailable` prop any more.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { C, MicroLabel, MODE_META, mono, serif } from "./hq-kit";
import { routes } from "@/utils/routes";

export type { Unavailable } from "./hq-tiers";

// ---------------------------------------------------------------------------
// Trust chip (K1, row 0)
// ---------------------------------------------------------------------------

/**
 * Autonomy tier + spend, sitting next to the greeting.
 *
 * §23 step 7: trust belongs where the work is, not buried in Settings — it is
 * the product's actual moat and it should be one tap from the deck. Spend is
 * shown beside the tier because an autonomy level without a number attached is
 * a promise with no receipt. The chip is also the contextual door to Guardrails
 * (§3: "Guardrails from a tier chip"), which is what keeps it on the deck even
 * though the rail's account line carries the same tier and the same spend.
 *
 * The tier arrives as its **id** and is rendered through {@link MODE_META}, not
 * as a capitalised copy of the enum value. `AUTONOMOUS` was the raw enum with a
 * `text-transform` on it; `⚡ Autonomous` is the label design wrote, and the
 * blurb goes on the title so the word can be checked without leaving HQ.
 *
 * Spend states its own period. `$4.10 of $50` is two numbers whose relationship
 * is implied by "of" and whose window is implied by nothing at all — §8's "never
 * a number whose meaning isn't stated" applies to the units as much as the digit.
 */
export function TrustChip({
  mode,
  spentCents,
  capCents,
}: {
  mode: keyof typeof MODE_META;
  spentCents: number | null;
  capCents: number | null;
}) {
  const money = (c: number) =>
    c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
  const meta = MODE_META[mode];
  return (
    <div
      data-slot="hq-trust-chip"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span
        title={meta.blurb}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontFamily: mono,
          fontSize: 10.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.t2,
          border: `1px solid ${C.line}`,
          borderRadius: 999,
          padding: "3px 9px",
        }}
      >
        <span aria-hidden>{meta.glyph}</span>
        {meta.label}
      </span>
      {/* Spend only renders when it is real — a "$0 of $0" chip would imply a
          cap that does not exist. */}
      {spentCents != null && capCents != null && capCents > 0 ? (
        <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
          {money(spentCents)} of {money(capCents)} this month
        </span>
      ) : null}
      <Link
        to={routes.guardrails}
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: C.t3,
          textDecoration: "none",
        }}
      >
        Trust ›
      </Link>
    </div>
  );
}

/*
 * The lens switch that used to sit beside this chip has been removed.
 *
 * It rendered `All 96 · ◎ 96 · ⌂ 0` — three numbers, two of them behind
 * unlabelled glyphs, and by construction the first two are the SAME number
 * whenever nothing personal is on the list (all = work + life). That is §8's
 * "no raw enums" and "never a number whose meaning isn't stated" in one row.
 *
 * More to the point, it did nothing: the `lens` value was state that no lane,
 * filter or query ever read, so pressing a segment changed which pill was
 * highlighted and nothing else. Life is still a lens and not a level — it is a
 * Tier-2 lane on this deck, a card when there is something personal and a line
 * saying so when there is not. When the lens is wired to actually re-spine the
 * deck, it comes back with labels on its counts.
 */

// ---------------------------------------------------------------------------
// Day rail (K1, row 2)
// ---------------------------------------------------------------------------

export interface DayCommitment {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
}

export interface DayPicture {
  commitments: DayCommitment[];
  unbookedMinutes: number;
  freeBlock: { startMs: number; endMs: number; minutes: number } | null;
}

const RAIL_START_HOUR = 8;
const RAIL_END_HOUR = 19;

/**
 * The day as a strip: commitments placed on real hours, a now-marker, and the
 * largest free block named rather than left for the user to find.
 *
 * The offer attached to the free block is the difference between a calendar and
 * a chief of staff — "you have 3 hours" is information, "use it on the Halo
 * pricing" is help. It only appears when there is something concrete to spend
 * the time on, because an offer with no subject is noise.
 */
export function DayRail({
  day,
  nowMs,
  offer,
}: {
  day: DayPicture;
  nowMs: number;
  offer?: {
    text: string;
    detail?: string;
    onAccept?: () => void;
    onDismiss?: () => void;
  } | null;
}) {
  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const pct = (ms: number) => {
    const d = new Date(ms);
    const h = d.getHours() + d.getMinutes() / 60;
    return Math.min(
      100,
      Math.max(
        0,
        ((h - RAIL_START_HOUR) / (RAIL_END_HOUR - RAIL_START_HOUR)) * 100,
      ),
    );
  };

  return (
    <section data-slot="hq-day-rail" style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel>Your day</MicroLabel>
        <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
          · {Math.floor(day.unbookedMinutes / 60)}h {day.unbookedMinutes % 60}m
          unbooked
        </span>
      </div>

      <div
        style={{
          position: "relative",
          height: 34,
          marginTop: 12,
          borderRadius: 8,
          background: C.sunken,
          overflow: "hidden",
        }}
      >
        {day.freeBlock ? (
          <div
            title="Free"
            style={{
              position: "absolute",
              left: `${pct(day.freeBlock.startMs)}%`,
              width: `${Math.max(2, pct(day.freeBlock.endMs) - pct(day.freeBlock.startMs))}%`,
              top: 0,
              bottom: 0,
              background: `color-mix(in srgb, ${C.green} 14%, transparent)`,
            }}
          />
        ) : null}
        {day.commitments.map((c) => (
          <div
            key={c.id}
            title={c.title}
            style={{
              position: "absolute",
              left: `${pct(c.startMs)}%`,
              width: `${Math.max(2, pct(c.endMs) - pct(c.startMs))}%`,
              top: 5,
              bottom: 5,
              borderRadius: 5,
              background: C.blue,
              opacity: 0.85,
            }}
          />
        ))}
        {/* Now-marker — the rail is useless without knowing where you are. */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${pct(nowMs)}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: C.danger,
          }}
        />
      </div>
      {offer ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 11,
            padding: "11px 13px",
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            background: C.surface,
          }}
        >
          <span aria-hidden style={{ color: C.green }}>
            ◷
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: C.ink }}>{offer.text}</div>
            {offer.detail ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: C.t3,
                  marginTop: 2,
                  fontFamily: mono,
                }}
              >
                {offer.detail}
              </div>
            ) : null}
          </div>
          {offer.onAccept ? (
            <button
              type="button"
              onClick={offer.onAccept}
              style={{
                fontSize: 12,
                fontWeight: 600,
                background: C.blue,
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "7px 12px",
                cursor: "pointer",
              }}
            >
              Block it
            </button>
          ) : null}
          {offer.onDismiss ? (
            <button
              type="button"
              onClick={offer.onDismiss}
              style={{
                fontSize: 12,
                background: "none",
                border: "none",
                color: C.t3,
                cursor: "pointer",
              }}
            >
              Not today
            </button>
          ) : null}
        </div>
      ) : null}
      {day.commitments.length > 0 ? (
        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 9,
            fontSize: 11.5,
            color: C.t3,
            fontFamily: mono,
          }}
        >
          {day.commitments.slice(0, 4).map((c) => (
            <span key={c.id}>
              {hhmm(c.startMs)} {c.title}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Life horizons (§2)
// ---------------------------------------------------------------------------

export type Horizon = "this_week" | "soon" | "someday";

const HORIZON_LABEL: Record<Horizon, string> = {
  this_week: "This week",
  soon: "Soon",
  someday: "Someday",
};

/**
 * Life, grouped by when rather than why.
 *
 * Personal items are time-directed, not goal-directed — "renew the passport"
 * does not ladder up to a mission, and forcing it to would turn Cue into a
 * project tool. Warm ground, `⌂`, no new accent colour (§2).
 */
export function LifeHorizons({
  groups,
}: {
  groups: { horizon: Horizon; titles: string[] }[];
}) {
  return (
    <section data-slot="hq-life" style={{ minWidth: 0 }}>
      <MicroLabel>⌂ Personal · by horizon</MicroLabel>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 7,
          marginTop: 12,
        }}
      >
        {(["this_week", "soon", "someday"] as Horizon[]).map((h) => {
          const g = groups.find((x) => x.horizon === h);
          const n = g?.titles.length ?? 0;
          return (
            <div
              key={h}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                borderRadius: 11,
                // Warm ground — the Life lens's only visual signature.
                background: "var(--mv1-life-ground, #FAF7F2)",
                border: `1px solid ${C.line}`,
              }}
            >
              <span
                style={{
                  fontFamily: mono,
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: C.t3,
                  minWidth: 74,
                }}
              >
                {HORIZON_LABEL[h]}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: n > 0 ? C.t1 : C.t3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {n > 0 ? g!.titles.slice(0, 3).join(" · ") : "—"}
              </span>
              {n > 0 ? (
                <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
                  {n}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agents, right now (K1, row 7)
// ---------------------------------------------------------------------------

export interface AgentNow {
  name: string;
  emoji: string | null;
  tier: number | string | null;
  /** What it is doing, if anything. */
  activity: string | null;
  acts: number;
  reversed: number;
}

/**
 * The staff, with receipts.
 *
 * "128 acts · 0 reversed" is the line that makes autonomy credible, and it is
 * queryable today — `agent_acts` carries both. Showing acts without reversals
 * would be marketing; the pair is a track record.
 */
export function AgentsNow({ agents }: { agents: AgentNow[] }) {
  if (agents.length === 0) return null;
  return (
    <section data-slot="hq-agents-now" style={{ marginTop: 18 }}>
      <MicroLabel>Agents, right now</MicroLabel>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 12,
        }}
      >
        {agents.slice(0, 4).map((a) => (
          <div
            key={a.name}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>
              {a.emoji ?? "◆"}
            </span>
            <span style={{ fontSize: 13, color: C.t1, minWidth: 0 }}>
              {a.name}
              {a.activity ? (
                <span style={{ color: C.t3 }}> — {a.activity}</span>
              ) : null}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontFamily: mono,
                fontSize: 11,
                color: C.t3,
                whiteSpace: "nowrap",
              }}
            >
              {a.acts} acts · {a.reversed} reversed
              {a.tier != null ? ` · Tier ${a.tier}` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Waiting on people (§7)
// ---------------------------------------------------------------------------

export interface WaitingItem {
  id: string;
  person: string;
  what: string;
  days: number;
  /** Derived state — each wants a different next move (§7). */
  state: "going_cold" | "on_time" | "chased" | "system";
}

/**
 * Waiting, as one Tier-3 sentence.
 *
 * Waiting has four states and each has a different right answer (§7) — going
 * cold wants a nudge, already-chased wants an escalation rather than a second
 * nudge, on-time wants to be forgotten, and waiting-on-a-system wants nothing
 * at all. This used to be a card that rendered up to three rows plus a Nudge
 * button. At eleven items on the deck it was three rows of chrome around a fact
 * that fits in a sentence, so v7 puts it in Tier 3 and the rows live on the
 * People surface the line links to.
 *
 * The one thing the sentence must not lose is which state is costing you time:
 * "going cold" is the only one with a clock on it, so it is named separately
 * rather than folded into a total.
 *
 * A function of the queried list, never of a count passed in — which is how the
 * number here is guaranteed to be one we actually asked for.
 */
export function waitingSentence(items: WaitingItem[]): string {
  if (items.length === 0) return "Nothing is waiting on anyone.";
  const cold = items.filter((w) => w.state === "going_cold").length;
  const people = new Set(items.map((w) => w.person)).size;
  const who =
    people === 1
      ? `${items[0]!.person} owes you something`
      : `${people} people owe you something`;
  if (cold === 0) return `${who} — all still on time.`;
  return `${who} — ${cold} ${cold === 1 ? "is" : "are"} going cold.`;
}

// ---------------------------------------------------------------------------
// Batch offer (§12)
// ---------------------------------------------------------------------------

/**
 * "3 of these are the same conversation."
 *
 * Always an offer, never automatic, always dismissible (§12) — Cue noticing
 * that several items are one item is the clearest signal it understands the
 * work, but acting on that without asking is how it gets things wrong at scale.
 */
export function BatchOffer({
  count,
  summary,
  onSee,
  onDismiss,
}: {
  count: number;
  summary: string;
  onSee?: () => void;
  onDismiss?: () => void;
}) {
  if (count < 2) return null;
  return (
    <div
      data-slot="hq-batch-offer"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        border: `1px solid color-mix(in srgb, ${C.violet} 30%, ${C.line})`,
        background: `color-mix(in srgb, ${C.violet} 5%, ${C.surface})`,
        borderRadius: 12,
      }}
    >
      <span aria-hidden style={{ color: C.violet }}>
        ⧉
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: C.ink }}>
          {count} of these are the same conversation
        </div>
        <div style={{ fontSize: 11.5, color: C.t3, marginTop: 2 }}>
          {summary}
        </div>
      </div>
      {onSee ? (
        <button
          type="button"
          onClick={onSee}
          style={{
            fontSize: 12,
            fontWeight: 600,
            border: `1px solid ${C.line2}`,
            background: C.surface,
            color: C.ink,
            borderRadius: 8,
            padding: "6px 11px",
            cursor: "pointer",
          }}
        >
          See the reply
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          style={{
            fontSize: 13,
            background: "none",
            border: "none",
            color: C.t3,
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/** Shared section wrapper so K1's rows keep one rhythm. */
export function DeckSection({
  children,
  style,
}: {
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return <section style={{ marginTop: 26, ...style }}>{children}</section>;
}

export { serif };
