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
 *   • LIVE RUN — REAL. This is the web view of the Cue Live overlay loop, so it
 *     reuses `GET cuelive/session` (verified act steps, pausable/stoppable) —
 *     the exact honest source the mobile remote viewer uses.
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

function LiveRun({
  live,
  assistantId,
}: {
  live: LiveSession | null;
  assistantId: string;
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

  if (!live?.active || !live.goal) {
    const last = relativeTime(live?.lastSeenAt);
    return (
      <div style={panel}>
        <div style={microLabel}>Live run</div>
        <div
          style={{ fontSize: 13.5, color: C.t2, marginTop: 8, lineHeight: 1.5 }}
        >
          No run in flight. When Cue drives your Mac, its verified steps stream
          here — the web view of the overlay loop, pausable.
          {last ? ` Last active ${last}.` : ""}
        </div>
      </div>
    );
  }

  const goal = live.goal;
  const paused = live.paused;
  const steps = live.observations.slice(0, 6);

  return (
    <div style={panel}>
      <div style={{ ...microLabel, color: paused ? C.amber : C.green }}>
        {paused ? "Paused from the web" : "Running on"}{" "}
        {live.watching?.appName ?? "your Mac"} · step {goal.step}
      </div>
      <div
        style={{ fontFamily: serif, fontSize: 20, color: C.t1, marginTop: 8 }}
      >
        {goal.text}
      </div>

      <div style={{ marginTop: 14 }}>
        {steps.map((ob) => (
          <div
            key={ob.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 0",
              fontSize: 13.5,
              color: ob.status === "active" ? C.t1 : C.t2,
            }}
          >
            <span
              aria-hidden
              style={{
                color:
                  ob.status === "active"
                    ? C.blue
                    : ob.status === "held"
                      ? C.amber
                      : C.green,
              }}
            >
              {ob.status === "active" ? "◷" : ob.status === "held" ? "⏸" : "✓"}
            </span>
            <span style={{ flex: 1 }}>{ob.summary}</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.t3 }}>
              {ob.status === "active"
                ? "verifying"
                : ob.status === "held"
                  ? "held"
                  : "verified"}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
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
      </div>
    </div>
  );
}

/* ── which-Mac picker ──────────────────────────────────────────────────── */

function WhichMac({
  targets,
  selectedId,
  onSelect,
}: {
  targets: Target[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
          No Mac is connected right now. The run can&rsquo;t start until one is
          — open Cue on your Mac to pair it.
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    targets.find((t) => t.clientId === selectedId) ?? targets[0] ?? null;
  const machine = session?.machineName ?? selected?.machineName ?? null;

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

      <LiveRun live={liveQuery.data ?? null} assistantId={assistantId ?? ""} />

      <WhichMac
        targets={targets}
        selectedId={selected?.clientId ?? null}
        onSelect={setSelectedId}
      />
    </div>
  );
}

export function DesktopControlPage() {
  const isMobile = useIsMobile();
  if (isMobile) return <OrganizerRemotePage />;
  return <DesktopControlWeb />;
}
