/**
 * HQ deck modules — the folded-in Home surfaces, per the locked
 * Cue-HQ-Build "deep pass" + §1 switch-over frames:
 *
 *  · NextMoveCard        — "◆ YOUR NEXT MOVE", the emphasized card atop
 *                          Needs-you, wired to the daemon next-move endpoint
 *                          (same hook the Command Center hero used).
 *  · WatchingLine        — "Watching for you · Gmail · Slack · +2 ›" derived
 *                          from the live channel-readiness snapshots; links
 *                          to Connections.
 *  · QueuedScheduledList — queued (pending) work items as UP-NEXT rows plus
 *                          standing schedules with their next-fire times.
 *  · DoneTodayChips      — today's done work items as compact chips with an
 *                          OPEN affordance into the run conversation.
 *  · TimeBackChip        — the honest spend-rail companion. Pre-ledger it
 *                          shows "measuring…" (dashed border, NO number —
 *                          R5·A3 option b); the numeric state exists behind
 *                          the ledger flag only.
 *  · ReconnectBanner     — R5·A5 degraded line ("Reconnecting to Cue…
 *                          showing your last state") on SSE loss.
 *  · CameInErrorStrip    — the inline came-in refresh failure with Retry.
 *  · HqDeckSkeleton      — headers-first shimmer skeleton for the deck.
 *
 * Everything rides the theme-aware C.* tokens so light and dark both match
 * their design frames (the dark desktop frame in the doc omits the capture
 * bar — a known nit — so dark simply inherits the light structure).
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";

import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { client } from "@/generated/daemon/client.gen";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";
import { relativeTime } from "@/domains/activity/theme";
import {
  nextMoveQueryKey,
  useNextMove,
  type NextMove,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";
import { routes } from "@/utils/routes";

import { C, MicroLabel, Shimmer, mono, sourceBadge } from "./hq-kit";
import type { HqSchedule, HqWorkItem, Mission } from "./use-missions";

// ---------------------------------------------------------------------------
// ◆ YOUR NEXT MOVE
// ---------------------------------------------------------------------------

export { useNextMove };
export type { NextMove };

/**
 * The emphasized focus card that sits atop Needs-you. Blue 1.5px border +
 * soft blue-washed gradient (light: #F5F8FF→#fff; dark: the same recipe via
 * color-mix on the theme tokens). Actions come from the daemon move itself.
 */
export function NextMoveCard({
  assistantId,
  move,
}: {
  assistantId: string;
  move: NextMove;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const act = useMutation({
    mutationFn: async (action: NextMoveAction) => {
      if (action.kind === "open_thread" || !action.endpoint) return;
      const method = action.method ?? "POST";
      const opts = { url: action.endpoint, throwOnError: true } as const;
      if (method === "GET") await client.get(opts);
      else if (method === "PATCH") await client.patch(opts);
      else if (method === "DELETE") await client.delete(opts);
      else await client.post(opts);
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: nextMoveQueryKey(assistantId),
      }),
  });

  if (!move.hasMove) return null;

  const primary = move.actions.find(
    (a) => a.kind === "approve" || a.kind === "run",
  );
  const openThread =
    move.actions.find((a) => a.kind === "open_thread") ??
    (move.sourceConversationId
      ? ({ id: "open", label: "Open", kind: "open_thread" } as NextMoveAction)
      : null);

  const dispatch = (action: NextMoveAction) => {
    if (action.kind === "open_thread") {
      if (move.sourceConversationId)
        navigate(routes.conversation(move.sourceConversationId));
      return;
    }
    act.mutate(action);
  };

  return (
    <div
      data-slot="hq-next-move"
      style={{
        border: `1.5px solid ${C.blue}`,
        borderRadius: 13,
        padding: "13px 15px",
        background: `linear-gradient(180deg, color-mix(in srgb, ${C.blue} 6%, ${C.surface}), ${C.surface})`,
        boxShadow: `0 14px 34px -20px color-mix(in srgb, ${C.blue} 50%, transparent)`,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.13em",
          color: C.blueS,
          marginBottom: 8,
        }}
      >
        ◆ YOUR NEXT MOVE
      </div>
      <div
        data-slot="hq-next-move-row"
        style={{ display: "flex", gap: 12, alignItems: "center" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
            {move.headline}
          </div>
          {move.reasoning ? (
            <div
              style={{
                fontSize: 12,
                color: C.t2,
                marginTop: 2,
                overflow: "hidden",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
              }}
            >
              {move.reasoning}
            </div>
          ) : null}
        </div>
        {primary ? (
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => dispatch(primary)}
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              background: C.blue,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "8px 15px",
              cursor: act.isPending ? "default" : "pointer",
              opacity: act.isPending ? 0.6 : 1,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {primary.label}
          </button>
        ) : null}
        {openThread ? (
          <button
            type="button"
            onClick={() => dispatch(openThread)}
            style={{
              fontSize: 11.5,
              background: C.surface,
              border: `1px solid ${C.line2}`,
              color: C.t2,
              borderRadius: 8,
              padding: "8px 13px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Open ›
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watching for you · <sources>
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  gmail: "Gmail",
  slack: "Slack",
  telegram: "Telegram",
  twilio: "Phone",
  phone: "Phone",
  voice: "Voice",
  a2a: "Agents",
  sms: "SMS",
  calendar: "Calendar",
  whatsapp: "WhatsApp",
  // "vellum" is the internal channel id for the Cue app itself.
  vellum: "Cue",
};

function channelLabel(channel: string): string {
  return (
    CHANNEL_LABELS[channel.toLowerCase()] ??
    channel.charAt(0).toUpperCase() + channel.slice(1)
  );
}

/**
 * The header line above the came-in strip: which connected sources Cue is
 * watching right now, from the live readiness snapshot. Only configured
 * channels count; the line always links to Connections.
 */
export function WatchingLine({ assistantId }: { assistantId: string }) {
  const query = useQuery({
    ...channelsReadinessGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const configured = (query.data?.snapshots ?? []).filter(
    (s) =>
      s.ready || (s.setupStatus != null && s.setupStatus !== "not_configured"),
  );
  const shown = configured.slice(0, 3).map((s) => channelLabel(s.channel));
  const extra = configured.length - shown.length;
  const anyReady = configured.some((s) => s.ready);

  return (
    <div
      data-slot="hq-watching"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "16px 2px 6px",
      }}
    >
      <MicroLabel>Watching for you</MicroLabel>
      <Link
        to={routes.channels}
        title="Cue watches these connected sources and auto-files anything that matters"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: configured.length > 0 ? C.t3 : C.blueS,
          textDecoration: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: anyReady ? C.green : C.t3,
            boxShadow: anyReady
              ? `0 0 0 3px color-mix(in srgb, ${C.green} 15%, transparent)`
              : "none",
          }}
        />
        {configured.length > 0
          ? `${shown.join(" · ")}${extra > 0 ? ` · +${extra}` : ""} ›`
          : "Connect a source ›"}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queued & scheduled
// ---------------------------------------------------------------------------

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
};

const rowLabelStyle: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 9,
  width: 64,
  flexShrink: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** Compact "⟳ MON 8:00"-style label from a schedule's cadence description. */
function cadenceChip(s: HqSchedule): string {
  const desc = (s.cadenceDescription || "").trim();
  if (desc.length > 0 && desc.length <= 10) return `⟳ ${desc.toUpperCase()}`;
  return "⟳ SCHEDULED";
}

/**
 * "Queued & scheduled" — what's waiting to run and what fires on its own:
 * pending work items (UP NEXT) and standing schedules with next-fire times.
 */
export function QueuedScheduledSection({
  queued,
  schedules,
  missionsByProjectId,
}: {
  queued: HqWorkItem[];
  schedules: HqSchedule[];
  missionsByProjectId: Map<string, Mission>;
}) {
  const navigate = useNavigate();
  const total = queued.length + schedules.length;
  if (total === 0) return null;

  const queuedShown = [...queued]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, 3);
  const schedulesShown = schedules.slice(
    0,
    Math.max(1, 4 - queuedShown.length),
  );
  const rows = queuedShown.length + schedulesShown.length;

  return (
    <div data-slot="hq-queued">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          margin: "18px 0 4px",
        }}
      >
        <MicroLabel>Queued &amp; scheduled</MicroLabel>
        {total > rows ? (
          <Link
            to={routes.allWork}
            style={{ fontSize: 11.5, color: C.t2, textDecoration: "none" }}
          >
            Show all {total} ›
          </Link>
        ) : null}
      </div>
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          overflow: "hidden",
          background: C.surface,
          marginTop: 4,
        }}
      >
        {queuedShown.map((item, i) => {
          const mission = item.projectId
            ? (missionsByProjectId.get(item.projectId) ?? null)
            : null;
          const last = i === rows - 1;
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() =>
                item.lastRunConversationId
                  ? navigate(routes.conversation(item.lastRunConversationId))
                  : navigate(routes.allWork)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate(routes.allWork);
              }}
              style={{
                ...rowStyle,
                borderBottom: last ? "none" : `1px solid ${C.line}`,
                cursor: "pointer",
              }}
            >
              <span style={{ ...rowLabelStyle, color: C.t3 }}>UP NEXT</span>
              <span
                style={{
                  fontSize: 12.5,
                  flex: 1,
                  minWidth: 0,
                  color: C.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.title}
                {mission ? (
                  <span style={{ color: C.t3 }}> · {mission.title}</span>
                ) : null}
              </span>
              <span style={{ fontSize: 11, color: C.t3, whiteSpace: "nowrap" }}>
                {relativeTime(item.createdAt) ?? ""}
              </span>
            </div>
          );
        })}
        {schedulesShown.map((s, i) => {
          const last = queuedShown.length + i === rows - 1;
          const fire = relativeTime(s.nextRunAt);
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(routes.settings.schedule(s.id))}
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate(routes.settings.schedule(s.id));
              }}
              style={{
                ...rowStyle,
                borderBottom: last ? "none" : `1px solid ${C.line}`,
                cursor: "pointer",
              }}
            >
              <span style={{ ...rowLabelStyle, color: C.blueS }}>
                {cadenceChip(s)}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  flex: 1,
                  minWidth: 0,
                  color: C.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.name}
                {s.cadenceDescription && s.cadenceDescription.length > 10 ? (
                  <span style={{ color: C.t3 }}> · {s.cadenceDescription}</span>
                ) : null}
              </span>
              <span style={{ fontSize: 11, color: C.t3, whiteSpace: "nowrap" }}>
                {fire ? `fires ${fire}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Done today
// ---------------------------------------------------------------------------

/** Epoch-ms of local midnight, stamped once per mount (no clock in render). */
export function useTodayStart(): number {
  const [start] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  });
  return start;
}

/**
 * "Done today · N" — compact chips for work items finished since midnight,
 * with OPEN into the run conversation where one exists.
 */
export function DoneTodayChips({
  items,
  todayStart,
}: {
  items: HqWorkItem[];
  todayStart: number;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const doneToday = items
    .filter((item) => (item.updatedAt ?? item.createdAt) >= todayStart)
    .sort(
      (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
    );
  if (doneToday.length === 0) return null;

  const shown = doneToday.slice(0, 5);
  const extra = doneToday.length - shown.length;

  return (
    <div data-slot="hq-done-today">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "18px 0 8px",
        }}
      >
        <MicroLabel color={C.green}>Done today · {doneToday.length}</MicroLabel>
        <div aria-hidden style={{ height: 1, flex: 1, background: C.line }} />
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          style={{
            fontSize: 11.5,
            color: C.t2,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          {collapsed ? "Expand ▸" : "Collapse ▾"}
        </button>
      </div>
      {!collapsed ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {shown.map((item) => {
            const badge = sourceBadge(item.sourceType);
            const openable = Boolean(item.lastRunConversationId);
            return (
              <button
                key={item.id}
                type="button"
                disabled={!openable}
                onClick={() =>
                  item.lastRunConversationId
                    ? navigate(routes.conversation(item.lastRunConversationId))
                    : undefined
                }
                title={item.title}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: C.sunken,
                  border: `1px solid ${C.line}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 11.5,
                  color: C.ink,
                  cursor: openable ? "pointer" : "default",
                  maxWidth: 260,
                }}
              >
                <span aria-hidden style={{ fontSize: 11 }}>
                  {badge.glyph}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.title}
                </span>
                {openable ? (
                  <span style={{ color: C.t3, fontFamily: mono, fontSize: 9 }}>
                    OPEN
                  </span>
                ) : null}
              </button>
            );
          })}
          {extra > 0 ? (
            <Link
              to={routes.allWork}
              style={{
                display: "inline-flex",
                alignItems: "center",
                background: C.sunken,
                border: `1px solid ${C.line}`,
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 11.5,
                color: C.t2,
                textDecoration: "none",
              }}
            >
              +{extra} more
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TIME BACK chip (R5·A3 — no number until it's true)
// ---------------------------------------------------------------------------

export interface TimeBackLedger {
  hours: number;
  acts: number;
}

/**
 * The rail chip next to Spend. Pre-ledger (the DEFAULT — the act ledger
 * doesn't exist yet) it shows "measuring…" behind a dashed border and NO
 * number. The numeric state renders only when a real ledger is passed.
 */
export function TimeBackChip({ ledger }: { ledger: TimeBackLedger | null }) {
  if (ledger != null) {
    return (
      <div
        style={{
          flex: 1,
          minWidth: 110,
          background: `color-mix(in srgb, ${C.green} 10%, ${C.surface})`,
          border: `1px solid color-mix(in srgb, ${C.green} 30%, transparent)`,
          borderRadius: 10,
          padding: 11,
        }}
        title={`Estimated from ${ledger.acts} acts Cue handled this month × your logged time-per-task`}
      >
        <div style={{ fontFamily: mono, fontSize: 9.5, color: C.green }}>
          TIME BACK
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: C.green,
            marginTop: 2,
            borderBottom: `1px dotted color-mix(in srgb, ${C.green} 50%, transparent)`,
            display: "inline-block",
          }}
        >
          ~{ledger.hours} hrs
        </div>
        <div style={{ fontSize: 9, color: C.t3, marginTop: 2 }}>
          from {ledger.acts} acts · this mo.
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        flex: 1,
        minWidth: 110,
        background: C.surface,
        border: `1px dashed color-mix(in srgb, ${C.green} 40%, transparent)`,
        borderRadius: 10,
        padding: 11,
      }}
      title="Cue starts measuring time back as it completes acts — this fills in over your first week"
    >
      <div style={{ fontFamily: mono, fontSize: 9.5, color: C.green }}>
        TIME BACK
      </div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          color: C.t3,
          marginTop: 4,
          borderBottom: `1px dotted ${C.t3}`,
          display: "inline-block",
        }}
      >
        measuring…
      </div>
      <div style={{ fontSize: 9, color: C.t3, marginTop: 3 }}>
        fills in over your first week
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Degraded banner (R5·A5 — a line, not a wall)
// ---------------------------------------------------------------------------

/**
 * Tracks SSE connectivity and returns the degraded state: shown only after
 * the stream has been up at least once this session (so a cold boot doesn't
 * flash the banner), with the last-synced HH:MM stamped on the transition.
 */
export function useDegradedState(): {
  degraded: boolean;
  syncedLabel: string | null;
} {
  const isConnected = useSSEConnectedStore.use.isConnected();
  const [syncedLabel, setSyncedLabel] = useState<string | null>(null);
  useEffect(() => {
    if (isConnected) {
      setSyncedLabel(
        new Date().toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }
  }, [isConnected]);
  return { degraded: !isConnected && syncedLabel != null, syncedLabel };
}

/** "Reconnecting to Cue… showing your last state" — the quiet degraded line. */
export function ReconnectBanner({
  syncedLabel,
}: {
  syncedLabel: string | null;
}) {
  return (
    <div
      role="status"
      data-slot="hq-reconnect-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        background: `color-mix(in srgb, ${C.amber} 10%, ${C.surface})`,
        borderBottom: `1px solid color-mix(in srgb, ${C.amber} 35%, transparent)`,
        padding: "9px 20px",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: C.amber,
          animation: "hqBlink 1.4s ease infinite",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 12,
          color: `color-mix(in srgb, ${C.amber} 75%, ${C.ink})`,
        }}
      >
        Reconnecting to Cue… showing your last state
      </span>
      {syncedLabel ? (
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            color: C.t3,
            marginLeft: "auto",
            whiteSpace: "nowrap",
          }}
        >
          SYNCED {syncedLabel}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Came-in inline error (R5·A5 — error stays inside its strip)
// ---------------------------------------------------------------------------

/** The came-in strip's refresh failure. Nothing else on the deck changes. */
export function CameInErrorStrip({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      data-slot="hq-camein-error"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: `color-mix(in srgb, ${C.danger} 8%, ${C.surface})`,
        border: `1px solid color-mix(in srgb, ${C.danger} 28%, transparent)`,
        borderRadius: 12,
        padding: "11px 15px",
      }}
    >
      <MicroLabel color={C.danger} style={{ whiteSpace: "nowrap" }}>
        Came in
      </MicroLabel>
      <span style={{ fontSize: 12, color: C.t2, flex: 1 }}>
        Couldn&rsquo;t refresh what came in — your missions are unaffected.
      </span>
      <button
        type="button"
        onClick={onRetry}
        style={{
          fontSize: 12,
          color: C.danger,
          fontWeight: 600,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Retry ↻
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HQ deck skeleton (R5·A5 — module headers land first)
// ---------------------------------------------------------------------------

/**
 * Headers-first loading skeleton: the room's shape is instant (real section
 * headers), only the data slots shimmer. Matches frame 1 of R5·A5.
 */
export function HqDeckSkeleton() {
  return (
    <div data-slot="hq-skeleton" style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 18,
          alignItems: "center",
          background: C.sunken,
          borderRadius: 14,
          padding: "18px 20px",
        }}
      >
        <Shimmer height={120} width={120} circle />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          <Shimmer height={11} width="40%" radius={5} />
          <Shimmer height={16} width="78%" radius={5} />
          <Shimmer height={11} width="62%" radius={5} />
        </div>
      </div>
      <MicroLabel style={{ margin: "16px 0 8px", fontSize: 9.5 }}>
        Watching for you
      </MicroLabel>
      <Shimmer height={36} radius={10} />
      <MicroLabel style={{ margin: "16px 0 8px", fontSize: 9.5 }}>
        Needs you
      </MicroLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Shimmer height={52} radius={11} />
        <Shimmer height={52} radius={11} opacity={0.7} />
      </div>
      <MicroLabel style={{ margin: "16px 0 8px", fontSize: 9.5 }}>
        Queued &amp; scheduled
      </MicroLabel>
      <Shimmer height={40} radius={11} opacity={0.5} />
    </div>
  );
}

/** Mission detail skeleton — frame 3 of R5·A5. */
export function MissionDetailSkeleton() {
  return (
    <div data-slot="hq-mission-skeleton" style={{ maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Shimmer height={44} width={44} circle />
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          <Shimmer height={14} width="64%" radius={5} />
          <Shimmer height={10} width="40%" radius={5} />
        </div>
      </div>
      <MicroLabel style={{ margin: "16px 0 8px", fontSize: 9.5 }}>
        The plan
      </MicroLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <Shimmer height={38} radius={10} />
        <Shimmer height={38} radius={10} opacity={0.75} />
        <Shimmer height={38} radius={10} opacity={0.5} />
      </div>
      <MicroLabel style={{ margin: "16px 0 8px", fontSize: 9.5 }}>
        Outputs
      </MicroLabel>
      <div style={{ display: "flex", gap: 7 }}>
        <Shimmer height={64} radius={10} style={{ flex: 1 }} width="auto" />
        <Shimmer
          height={64}
          radius={10}
          opacity={0.6}
          style={{ flex: 1 }}
          width="auto"
        />
      </div>
    </div>
  );
}
