/**
 * Desktop control — web W5 (parity+ serif HQ) + mobile frames 71/72.
 *
 * "Cue acts on your Mac; the phone/web is the remote." One route, device-
 * branched like `cue-live-page.tsx`:
 *   • on a phone  → the mobile-v3 organizer remote (frames 71/72).
 *   • on the web  → the serif desktop-control surface (W5): the plan/consent
 *                   card, the live run, and the which-Mac target picker.
 *
 * Honesty — what's wired to real data vs. pending a daemon emission:
 *   • WHICH MAC — REAL. Read from `GET organizer/session` → `targets`
 *     (host_bash-capable hub clients, scoped to the caller). Connected Macs
 *     show "online"; when none are connected the picker says so. Offline
 *     "last seen 3d ago · Wake" for a *disconnected* Mac needs persistence the
 *     daemon doesn't keep yet — flagged inline, never faked.
 *   • LIVE RUN — REAL, and never more confident than its source. It reuses
 *     `GET cuelive/session`, whose `active` flag only means "a Mac called in
 *     within the last two minutes" and whose `goal` survives a run that simply
 *     stopped reporting. So this surface claims "running" only when a Mac is on
 *     the other end AND a step landed inside the freshness window; otherwise it
 *     says it is waiting, or that nothing has reported. A step is labelled
 *     `verified` only when the observation carries the daemon's own verify
 *     beat — a recorded step is "done", not verified.
 *   • Both panels resolve the same {@link MacLink}, so the run card and the
 *     which-Mac picker can never claim opposite things about the connection.
 *   • PLAN / CONSENT — driven by `organizer/session`'s `plan`, which stays
 *     inactive until the desktop-organizer skill reports its plan back into the
 *     daemon (see `routes/organizer-session.ts`). Until then the card shows the
 *     honest "nothing awaiting approval" state rather than a mocked plan.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  cueliveSessionGetOptions,
  organizerSessionGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  cueliveSessionPausePost,
  cueliveSessionStopPost,
} from "@/generated/daemon/sdk.gen";
import type {
  CueliveSessionGetResponse,
  OrganizerSessionGetResponse,
} from "@/generated/daemon/types.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";

import { OrganizerRemotePage } from "@/mobile-v3/organizer/organizer-remote-page";

const POLL_MS = 5_000;

/**
 * How long a run may go without the Mac reporting a step before this surface
 * stops calling it "running". The act loop reports on every step and its own
 * model call is capped at 20s, so a minute and a half of silence means the run
 * is not progressing — whatever the daemon's coarse 2-minute "active" window
 * still says.
 */
const RUN_STALE_MS = 90_000;

const serif = "'Instrument Serif', Georgia, serif";
const mono = "'DM Mono', ui-monospace, monospace";

const C = {
  blue: "var(--mv1-blue)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
  violet: "var(--mv1-violet)",
} as const;

type OrgSession = OrganizerSessionGetResponse["session"];
type Target = OrganizerSessionGetResponse["targets"][number];
type LiveSession = CueliveSessionGetResponse;
type LiveObservation = LiveSession["observations"][number];

/**
 * One reconciled answer to "is a Mac on the other end of this?", shared by the
 * run card and the which-Mac picker so the two can never contradict each other.
 *
 * They read different daemon state and neither alone is the truth:
 *   · `organizer/session.targets` — host_bash hub subscribers, scoped to the
 *     calling actor and fail-closed. Authoritative when non-empty; a Mac whose
 *     subscription carries no principal is invisible here even while it works.
 *   · `cuelive/session` — a global in-memory recorder of the calls a Mac makes.
 *     Fresh observations prove a Mac is talking to Cue, but can't name it.
 */
type MacLink =
  /** The roster names at least one connected Mac. */
  | { state: "connected" }
  /** Nothing in the roster, but a Mac reported a step just now. */
  | { state: "reporting" }
  /** No roster entry and no recent report — nothing is on the other end. */
  | { state: "none" };

function newestObservationAt(live: LiveSession | null): number | null {
  const at = live?.observations?.[0]?.at;
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function resolveMacLink(
  targets: Target[],
  live: LiveSession | null,
  now: number,
): MacLink {
  if (targets.length > 0) return { state: "connected" };
  const last = newestObservationAt(live);
  if (live?.active && last !== null && now - last <= RUN_STALE_MS) {
    return { state: "reporting" };
  }
  return { state: "none" };
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const microLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.t3,
};

const panel: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: 20,
};

const scopeTag = (kind: "read" | "write"): CSSProperties => ({
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.04em",
  padding: "2px 7px",
  borderRadius: 5,
  color: kind === "write" ? C.amber : C.t2,
  background:
    kind === "write"
      ? "color-mix(in srgb, var(--mv1-amber) 14%, transparent)"
      : "var(--mv1-sunken)",
  border: `1px solid ${C.line}`,
});

/* ── plan / consent card ───────────────────────────────────────────────── */

/** Derive the consent step list from the organizer category plan. */
function planSteps(session: OrgSession) {
  const plan = session.plan;
  if (!plan) return [];
  const included = plan.categories.filter((c) => c.included);
  const steps: { n: number; label: string; scope: "read" | "write" }[] = [
    {
      n: 1,
      label: `Scan ${plan.root} — ${plan.scannedCount} items`,
      scope: "read",
    },
  ];
  included.forEach((c, i) => {
    steps.push({
      n: i + 2,
      label: `Move ${c.count} ${c.label.toLowerCase()} → ${plan.archiveBase}`,
      scope: "write",
    });
  });
  return steps;
}

function PlanCard({
  session,
  machine,
}: {
  session: OrgSession;
  machine: string | null;
}) {
  const plan = session.plan;

  if (!plan) {
    return (
      <div style={panel}>
        <div style={microLabel}>Cue wants to act on your Mac</div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 22,
            color: C.t1,
            marginTop: 10,
          }}
        >
          Nothing awaiting your approval
        </div>
        <div
          style={{ fontSize: 13.5, color: C.t2, marginTop: 6, lineHeight: 1.5 }}
        >
          When a cloud conversation asks Cue to act on {machine ?? "your Mac"} —
          organize a folder, move files — the plan appears here for you to
          approve, scope, or deny before anything runs.
        </div>
      </div>
    );
  }

  const steps = planSteps(session);
  return (
    <div style={panel}>
      <div style={microLabel}>
        Cue wants to act on your Mac{machine ? ` · via Cloud → ${machine}` : ""}
      </div>
      <div
        style={{ fontFamily: serif, fontSize: 24, color: C.t1, marginTop: 8 }}
      >
        Organize {plan.root}
      </div>
      <div style={{ fontSize: 13, color: C.t2, marginTop: 4 }}>
        {steps.length} steps · file operations in {plan.root}
      </div>

      <ol style={{ listStyle: "none", margin: "16px 0 0", padding: 0 }}>
        {steps.map((s) => (
          <li
            key={s.n}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "9px 0",
              borderTop: `1px solid ${C.line}`,
              fontSize: 14,
              color: C.t1,
            }}
          >
            <span
              style={{ fontFamily: mono, fontSize: 12, color: C.t3, width: 16 }}
            >
              {s.n}
            </span>
            <span style={{ flex: 1 }}>{s.label}</span>
            <span style={scopeTag(s.scope)}>{s.scope}</span>
          </li>
        ))}
      </ol>

      <div
        style={{
          ...microLabel,
          borderTop: `1px solid ${C.line}`,
          paddingTop: 12,
          marginTop: 4,
          textTransform: "none",
          letterSpacing: 0,
          fontSize: 12,
          color: C.t2,
        }}
      >
        Move, never delete · everything undoable via manifest
      </div>

      <div
        style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}
      >
        <button
          type="button"
          style={{
            background: C.blue,
            color: "#fff",
            border: "none",
            borderRadius: 9,
            padding: "9px 16px",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Approve &amp; run
        </button>
        <button
          type="button"
          style={{
            background: C.sunken,
            color: C.t1,
            border: `1px solid ${C.line}`,
            borderRadius: 9,
            padding: "9px 16px",
            fontSize: 13.5,
            cursor: "pointer",
          }}
        >
          Always allow in {plan.root} ✦
        </button>
        <button
          type="button"
          style={{
            background: "none",
            color: C.t2,
            border: `1px solid ${C.line}`,
            borderRadius: 9,
            padding: "9px 16px",
            fontSize: 13.5,
            cursor: "pointer",
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/* ── live run (reuses the Cue Live overlay loop) ───────────────────────── */

/** A bare `Step 4` marker — a counter, not something that happened. */
const BARE_STEP = /^step\s+\d+$/i;

/**
 * The daemon writes act-step summaries as `Step N — <goal>` / `Run finished —
 * <goal>`, so every row repeats the request the card already shows as its
 * headline. Strip that echo and keep only the part that says what happened.
 */
export function stripGoalEcho(summary: string, goalText: string): string {
  const s = summary.trim();
  const goal = goalText.trim();
  if (!goal) return s;
  if (s === goal) return "";
  const suffix = ` — ${goal}`;
  return s.endsWith(suffix) ? s.slice(0, -suffix.length).trim() : s;
}

/**
 * The verify beat is the ONLY evidence the daemon has that a step landed, and
 * it sets it only where a host round-trip actually reported back. A `done`
 * observation without one means "recorded", not "verified" — say that.
 */
export function stepStatusLabel(ob: {
  status: LiveObservation["status"];
  verify?: LiveObservation["verify"];
}): string {
  if (ob.verify) return ob.verify;
  if (ob.status === "held") return "held";
  if (ob.status === "active") return "working";
  return "done";
}

export interface StepRow {
  id: number;
  text: string;
  status: LiveObservation["status"];
  verify?: LiveObservation["verify"];
}

/**
 * Rows the daemon can actually back. Drops the goal echo, drops rows whose
 * only content was a step counter, and drops repeats — a step list that
 * restates the request four times is noise pretending to be progress.
 */
export function stepRows(
  observations: LiveObservation[],
  goalText: string,
  limit = 6,
): StepRow[] {
  const rows: StepRow[] = [];
  const seen = new Set<string>();
  for (const ob of observations) {
    const head = stripGoalEcho(ob.summary ?? "", goalText);
    const detail = (ob.detail ?? "").trim();
    // No detail and nothing but a counter left → the row said nothing.
    const text = detail || (BARE_STEP.test(head) ? "" : head);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    rows.push({
      id: ob.id,
      text,
      status: ob.status,
      verify: ob.verify ?? undefined,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** The honest headline for the run card, given the goal and the Mac link. */
export type RunPhase = "running" | "waiting" | "stalled" | "ended";

export function runPhase(
  goal: { done: boolean },
  link: MacLink,
  lastStepAt: number | null,
  now: number,
): RunPhase {
  if (goal.done) return "ended";
  if (link.state === "none") return "waiting";
  if (lastStepAt === null || now - lastStepAt > RUN_STALE_MS) return "stalled";
  return "running";
}

function LiveRun({
  live,
  assistantId,
  link,
  now,
}: {
  live: LiveSession | null;
  assistantId: string;
  link: MacLink;
  now: number;
}) {
  const queryClient = useQueryClient();
  const sessionKey = cueliveSessionGetOptions({
    path: { assistant_id: assistantId },
  }).queryKey;

  const pause = useMutation({
    mutationFn: async (paused: boolean) => {
      const { data } = await cueliveSessionPausePost({
        path: { assistant_id: assistantId },
        body: { paused },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(sessionKey, data),
  });
  const stop = useMutation({
    mutationFn: async () => {
      const { data } = await cueliveSessionStopPost({
        path: { assistant_id: assistantId },
        throwOnError: true,
      });
      return data;
    },
    onSuccess: (data) => queryClient.setQueryData(sessionKey, data.session),
  });

  if (!live?.goal) {
    const last = relativeTime(live?.lastSeenAt);
    return (
      <div style={panel}>
        <div style={microLabel}>Live run</div>
        <div
          style={{ fontSize: 13.5, color: C.t2, marginTop: 8, lineHeight: 1.5 }}
        >
          No run in flight. When Cue drives your Mac, the steps it reports
          stream here — the web view of the overlay loop, pausable.
          {last ? ` Last active ${last}.` : ""}
        </div>
      </div>
    );
  }

  const goal = live.goal;
  const paused = live.paused;
  const lastStepAt = newestObservationAt(live);
  const phase = runPhase(goal, link, lastStepAt, now);
  const rows = stepRows(live.observations, goal.text);
  const sinceLastStep = relativeTime(live.observations[0]?.at ?? null);

  // The eyebrow may only claim what the daemon can back. "Running" needs a Mac
  // on the other end AND a step reported inside the freshness window; anything
  // else says plainly what is actually true.
  const eyebrow =
    phase === "ended"
      ? goal.stoppedRemotely
        ? "Last run · stopped"
        : "Last run · finished"
      : phase === "waiting"
        ? "Waiting for a Mac"
        : phase === "stalled"
          ? "No step reported"
          : paused
            ? `Paused from the web · step ${goal.step}`
            : `Running on ${live.watching?.appName ?? "your Mac"} · step ${goal.step}`;
  const eyebrowColor =
    phase === "running" && !paused
      ? C.green
      : phase === "ended"
        ? C.t3
        : C.amber;

  const note =
    phase === "waiting"
      ? "No Mac is connected, so nothing is executing. Cue will not start this run until one is — open Cue on your Mac to pair it."
      : phase === "stalled"
        ? `Your Mac hasn’t reported a step${sinceLastStep ? ` since ${sinceLastStep}` : ""}. Cue can’t confirm this is still moving — stop it and ask again if it stays like this.`
        : null;

  // Pause only means something while a run is genuinely in flight. Stop stays
  // available on an open goal: it arms a one-shot abort the Mac consumes on its
  // next call, which is honest even when the Mac has gone quiet.
  const canPause = phase === "running";
  const canStop = phase !== "ended";

  return (
    <div style={panel}>
      <div style={{ ...microLabel, color: eyebrowColor }}>{eyebrow}</div>
      <div
        style={{ fontFamily: serif, fontSize: 20, color: C.t1, marginTop: 8 }}
      >
        {goal.text}
      </div>

      {note ? (
        <div
          style={{ fontSize: 13, color: C.t2, marginTop: 8, lineHeight: 1.5 }}
        >
          {note}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          {rows.map((row) => (
            <div
              key={row.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 0",
                fontSize: 13.5,
                color: row.status === "active" ? C.t1 : C.t2,
              }}
            >
              <span
                aria-hidden
                style={{
                  color:
                    row.status === "active"
                      ? C.blue
                      : row.status === "held"
                        ? C.amber
                        : row.verify === "verified"
                          ? C.green
                          : C.t3,
                }}
              >
                {row.status === "active"
                  ? "◷"
                  : row.status === "held"
                    ? "⏸"
                    : row.verify === "verified"
                      ? "✓"
                      : "·"}
              </span>
              <span style={{ flex: 1 }}>{row.text}</span>
              <span style={{ fontFamily: mono, fontSize: 10, color: C.t3 }}>
                {stepStatusLabel(row)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: C.t3, marginTop: 12 }}>
          No step detail reported — Cue has the goal but nothing has come back
          describing what it did.
        </div>
      )}

      {canPause || canStop ? (
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {canPause ? (
            <button
              type="button"
              disabled={pause.isPending}
              onClick={() => pause.mutate(!paused)}
              style={{
                background: C.sunken,
                color: C.t1,
                border: `1px solid ${C.line}`,
                borderRadius: 9,
                padding: "8px 16px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
              style={{
                background:
                  "color-mix(in srgb, var(--mv1-danger) 12%, transparent)",
                color: "var(--mv1-danger)",
                border:
                  "1px solid color-mix(in srgb, var(--mv1-danger) 35%, transparent)",
                borderRadius: 9,
                padding: "8px 16px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ■ Stop
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── which-Mac picker ──────────────────────────────────────────────────── */

function WhichMac({
  targets,
  selectedId,
  onSelect,
  link,
}: {
  targets: Target[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  link: MacLink;
}) {
  return (
    <div style={panel}>
      <div style={microLabel}>Which Mac</div>
      {targets.length === 0 ? (
        <div
          style={{
            fontSize: 13.5,
            color: C.t2,
            marginTop: 10,
            lineHeight: 1.5,
          }}
        >
          {link.state === "reporting" ? (
            <>
              A Mac is reporting steps to Cue right now, but it isn&rsquo;t
              listed as a paired target for your account — so Cue can&rsquo;t
              name it or aim a new run at it. Reopen Cue on that Mac to pair it
              properly.
            </>
          ) : (
            <>
              No Mac is connected right now. The run can&rsquo;t start until one
              is — open Cue on your Mac to pair it.
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {targets.map((t) => {
            const selected = t.clientId === selectedId;
            return (
              <button
                key={t.clientId}
                type="button"
                onClick={() => onSelect(t.clientId)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  textAlign: "left",
                  background: selected ? "var(--mv1-blue-wash)" : C.sunken,
                  border: `1px solid ${selected ? C.blue : C.line}`,
                  borderRadius: 10,
                  padding: "11px 13px",
                  cursor: "pointer",
                }}
              >
                <span aria-hidden style={{ fontSize: 18 }}>
                  💻
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.t1 }}>
                    {t.machineName ?? "Mac"}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontFamily: mono,
                      fontSize: 10.5,
                      color: C.green,
                      marginTop: 2,
                    }}
                  >
                    online · {t.interfaceId}
                  </span>
                </span>
                {selected ? (
                  <span aria-hidden style={{ color: C.blue }}>
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <div
        style={{
          fontSize: 11.5,
          color: C.t3,
          marginTop: 12,
          lineHeight: 1.5,
        }}
      >
        Only Macs connected right now are listed. An offline Mac&rsquo;s
        &ldquo;last seen · Wake&rdquo; state needs disconnected-client history
        the daemon doesn&rsquo;t keep yet.
      </div>
    </div>
  );
}

/* ── web surface + device-branching entry ──────────────────────────────── */

function DesktopControlWeb() {
  const assistantId = useActiveAssistantId();

  const orgQuery = useQuery({
    ...organizerSessionGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId,
    refetchInterval: POLL_MS,
  });
  const liveQuery = useQuery({
    ...cueliveSessionGetOptions({ path: { assistant_id: assistantId ?? "" } }),
    enabled: !!assistantId,
    refetchInterval: POLL_MS,
  });

  const targets = orgQuery.data?.targets ?? [];
  const session = orgQuery.data?.session ?? null;
  const live = liveQuery.data ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    targets.find((t) => t.clientId === selectedId) ?? targets[0] ?? null;
  const machine = session?.machineName ?? selected?.machineName ?? null;

  // Both panels below read this one answer, so they cannot disagree about
  // whether a Mac is on the other end. "Now" is the last time either query
  // actually reached the daemon (success or failure) rather than a clock read
  // in render: it advances on the POLL_MS cadence, and it stops advancing when
  // the daemon stops answering — which is precisely when a run must not keep
  // being described as fresh.
  const now = Math.max(
    liveQuery.dataUpdatedAt,
    liveQuery.errorUpdatedAt,
    orgQuery.dataUpdatedAt,
    orgQuery.errorUpdatedAt,
  );
  const link = resolveMacLink(targets, live, now);

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 760,
        margin: "0 auto",
        padding: "24px 20px 60px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <div>
        <div style={{ fontFamily: serif, fontSize: 30, color: C.t1 }}>
          Desktop control
        </div>
        <div
          style={{ fontSize: 14, color: C.t2, marginTop: 4, lineHeight: 1.5 }}
        >
          Cue acts on your Mac; this is the remote. Approve the plan, watch the
          verified-steps run, pick which Mac — the work runs there, not here.
        </div>
      </div>

      {session ? (
        <PlanCard session={session} machine={machine} />
      ) : (
        <div style={panel}>
          <div style={microLabel}>Cue wants to act on your Mac</div>
          <div style={{ fontSize: 13.5, color: C.t2, marginTop: 8 }}>
            {orgQuery.isLoading
              ? "Checking your Mac…"
              : "Couldn't reach your Cue instance."}
          </div>
        </div>
      )}

      <LiveRun
        live={live}
        assistantId={assistantId ?? ""}
        link={link}
        now={now}
      />

      <WhichMac
        targets={targets}
        selectedId={selected?.clientId ?? null}
        onSelect={setSelectedId}
        link={link}
      />
    </div>
  );
}

export function DesktopControlPage() {
  const isMobile = useIsMobile();
  if (isMobile) return <OrganizerRemotePage />;
  return <DesktopControlWeb />;
}
