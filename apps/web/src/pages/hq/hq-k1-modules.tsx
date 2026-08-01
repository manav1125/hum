/**
 * The canonical HQ modules that had no implementation before — trust chip, lens
 * switch, day rail, Life horizons, agents-now, and waiting-on-people.
 *
 * Built from `docs/design/handoff-2026-08-01/01-work-surfaces/canonical/
 * cue-canonical.html` (K1) and WORK-SURFACES.md §2, §5, §6, §7.
 *
 * **Every module renders, always.** Where the data behind one does not exist
 * yet it shows the addendum's A2 interim treatment — a specific, named reason —
 * rather than being omitted. A missing module is indistinguishable from a calm
 * one, and the deck's job is to be readable in ten seconds *and* honest about
 * what it cannot see. That is why these take an explicit `unavailable` reason
 * instead of a nullable payload: "no data" and "not connected" are different
 * sentences and the caller has to say which.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { C, MicroLabel, mono, serif } from "./hq-kit";
import { routes } from "@/utils/routes";

/** Why a module has nothing to show. Never rendered as silence. */
export type Unavailable = {
  /** One sentence, specific. "Not connected" — never "no data". */
  reason: string;
  /** Optional route that would fix it. */
  fixHref?: string;
  fixLabel?: string;
};

function ModuleNote({ note }: { note: Unavailable }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: C.t3,
        lineHeight: 1.5,
        marginTop: 9,
      }}
    >
      {note.reason}
      {note.fixHref ? (
        <>
          {" "}
          <Link
            to={note.fixHref}
            style={{ color: C.blueText, textDecoration: "none" }}
          >
            {note.fixLabel ?? "Set it up"} ›
          </Link>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trust chip (K1, row 0)
// ---------------------------------------------------------------------------

/**
 * Autonomy tier + spend, sitting next to the greeting.
 *
 * §23 step 7: trust belongs where the work is, not buried in Settings — it is
 * the product's actual moat and it should be one tap from the deck. Spend is
 * shown beside the tier because an autonomy level without a number attached is
 * a promise with no receipt.
 */
export function TrustChip({
  mode,
  spentCents,
  capCents,
}: {
  mode: string;
  spentCents: number | null;
  capCents: number | null;
}) {
  const money = (c: number) =>
    c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`;
  return (
    <div
      data-slot="hq-trust-chip"
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <span
        style={{
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
        {mode}
      </span>
      {/* Spend only renders when it is real — a "$0 of $0" chip would imply a
          cap that does not exist. */}
      {spentCents != null && capCents != null && capCents > 0 ? (
        <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
          {money(spentCents)} of {money(capCents)}
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

// ---------------------------------------------------------------------------
// Lens switch (§2 — work by why, life by when)
// ---------------------------------------------------------------------------

export type Lens = "all" | "work" | "life";

/**
 * The Life lens is a lens, not a level (§2).
 *
 * Same engine, same rows, different spine: work groups by mission, life groups
 * by horizon. Rendering it as a switch rather than a nav item is the whole
 * point — a separate "Personal" page would make Cue a project tool with a
 * second inbox, and would put the privacy boundary in the wrong place.
 */
export function LensSwitch({
  lens,
  counts,
  onChange,
}: {
  lens: Lens;
  counts: { all: number; work: number; life: number };
  onChange: (next: Lens) => void;
}) {
  const opts: { key: Lens; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.all },
    { key: "work", label: "◎", n: counts.work },
    { key: "life", label: "⌂", n: counts.life },
  ];
  return (
    <div
      data-slot="hq-lens"
      role="group"
      aria-label="Work or life"
      style={{ display: "inline-flex", gap: 4 }}
    >
      {opts.map((o) => {
        const on = lens === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            style={{
              fontFamily: mono,
              fontSize: 11,
              padding: "4px 10px",
              borderRadius: 999,
              cursor: "pointer",
              border: `1px solid ${on ? C.line2 : "transparent"}`,
              background: on ? C.surface : "transparent",
              color: on ? C.ink : C.t3,
            }}
          >
            {o.label} {o.n}
          </button>
        );
      })}
    </div>
  );
}

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
  unavailable,
}: {
  day: DayPicture | null;
  nowMs: number;
  offer?: { text: string; detail?: string; onAccept?: () => void; onDismiss?: () => void } | null;
  unavailable?: Unavailable;
}) {
  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const pct = (ms: number) => {
    const d = new Date(ms);
    const h = d.getHours() + d.getMinutes() / 60;
    return Math.min(
      100,
      Math.max(0, ((h - RAIL_START_HOUR) / (RAIL_END_HOUR - RAIL_START_HOUR)) * 100),
    );
  };

  return (
    <section data-slot="hq-day-rail" style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel>Your day</MicroLabel>
        {day ? (
          <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
            · {Math.floor(day.unbookedMinutes / 60)}h{" "}
            {day.unbookedMinutes % 60}m unbooked
          </span>
        ) : null}
      </div>

      {unavailable ? (
        <ModuleNote note={unavailable} />
      ) : day == null ? null : (
        <>
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
        </>
      )}
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
  unavailable,
}: {
  groups: { horizon: Horizon; titles: string[] }[];
  unavailable?: Unavailable;
}) {
  return (
    <section data-slot="hq-life" style={{ minWidth: 0 }}>
      <MicroLabel>⌂ Life · by horizon</MicroLabel>
      {unavailable ? (
        <ModuleNote note={unavailable} />
      ) : (
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
                  <span
                    style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}
                  >
                    {n}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
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
export function AgentsNow({
  agents,
  unavailable,
}: {
  agents: AgentNow[];
  unavailable?: Unavailable;
}) {
  return (
    <section data-slot="hq-agents-now" style={{ marginTop: 26 }}>
      <MicroLabel>Agents, right now</MicroLabel>
      {unavailable ? (
        <ModuleNote note={unavailable} />
      ) : (
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
      )}
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

const WAITING_COPY: Record<WaitingItem["state"], string> = {
  going_cold: "going cold",
  on_time: "on time",
  chased: "already chased",
  system: "waiting on a system",
};

/**
 * Waiting has four states and each has a different right answer (§7).
 *
 * Going cold wants a nudge; already-chased wants an escalation, not a second
 * nudge; on-time wants to be forgotten; waiting-on-a-system wants nothing at
 * all, and saying so IS the value. Collapsing them into one "waiting" list is
 * what makes a follow-up tool nagging rather than useful.
 */
export function WaitingOnPeople({
  items,
  onNudge,
  unavailable,
}: {
  items: WaitingItem[];
  onNudge?: (id: string) => void;
  unavailable?: Unavailable;
}) {
  return (
    <section data-slot="hq-waiting" style={{ marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <MicroLabel>Waiting on people</MicroLabel>
        {!unavailable && items.length > 0 ? (
          <span style={{ fontFamily: mono, fontSize: 11, color: C.t3 }}>
            · {items.length}
          </span>
        ) : null}
      </div>
      {unavailable ? (
        <ModuleNote note={unavailable} />
      ) : items.length === 0 ? (
        <div style={{ fontSize: 12, color: C.t3, marginTop: 9 }}>
          Nothing is waiting on anyone.
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 12,
          }}
        >
          {items.slice(0, 3).map((w) => (
            <div
              key={w.id}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: C.sunken,
                  color: C.t2,
                  fontSize: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {w.person.slice(0, 1).toUpperCase()}
              </span>
              <span style={{ fontSize: 13, color: C.t1, minWidth: 0 }}>
                {w.person} · {w.what}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: mono,
                  fontSize: 11,
                  color: w.state === "going_cold" ? C.amberText : C.t3,
                  whiteSpace: "nowrap",
                }}
              >
                {w.days}d — {WAITING_COPY[w.state]}
              </span>
              {/* A nudge is only offered where a nudge is the right move. */}
              {w.state === "going_cold" && onNudge ? (
                <button
                  type="button"
                  onClick={() => onNudge(w.id)}
                  style={{
                    fontSize: 11.5,
                    border: `1px solid ${C.line2}`,
                    background: C.surface,
                    color: C.ink,
                    borderRadius: 8,
                    padding: "4px 9px",
                    cursor: "pointer",
                  }}
                >
                  Nudge
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
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
