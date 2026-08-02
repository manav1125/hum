/**
 * HQ deck modules — the folded-in Home surfaces, per the locked
 * Cue-HQ-Build "deep pass" + §1 switch-over frames:
 *
 *  · NextMoveCard        — "◆ YOUR NEXT MOVE", the emphasized card atop
 *                          Needs-you, wired to the daemon next-move endpoint
 *                          (same hook the Command Center hero used).
 *  · useTodayStart       — local midnight, stamped once (no clock in render).
 *  · ReconnectBanner     — R5·A5 degraded line ("Reconnecting to Cue…
 *                          showing your last state") on SSE loss.
 *  · HqDeckSkeleton      — headers-first shimmer skeleton for the deck.
 *
 * Everything rides the theme-aware C.* tokens so light and dark both match
 * their design frames (the dark desktop frame in the doc omits the capture
 * bar — a known nit — so dark simply inherits the light structure).
 *
 * **What left, and why.** v7 §A retired "every module renders, always": the
 * watching line, the queued-and-scheduled block, the done-today chips, the
 * time-back chip and the came-in error strip were each a deck card wrapped
 * around a fact that fits in one Tier-3 sentence. They are lines in
 * `hq-tiers.tsx` now — the rhythms line, the pulse line, the in-motion line —
 * or, for the came-in failure, an `unavailable` lane state that says so in
 * words. Twenty-six cards of chrome around eleven items was the finding; this
 * is part of the subtraction.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { client } from "@/generated/daemon/client.gen";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";
import {
  buildActionBody,
  nextMoveQueryKey,
  useNextMove,
  type NextMove,
  type NextMoveAction,
} from "@/pages/command-center/use-next-move";
import { routes } from "@/utils/routes";

import { C, MicroLabel, Shimmer, mono } from "./hq-kit";

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
      const opts = {
        url: action.endpoint,
        throwOnError: true,
        ...(buildActionBody(action, move) ?? {}),
      } as const;
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
  // Gated on the conversation id, not on the action's presence: `dispatch`
  // can only navigate when there IS one, so offering the button without it
  // rendered a live control wired to nothing (a review item with no run
  // conversation did exactly that). Follow spawned-work-slot's rule — don't
  // offer an affordance for something that isn't there.
  const openThread = move.sourceConversationId
    ? (move.actions.find((a) => a.kind === "open_thread") ??
      ({ id: "open", label: "Open", kind: "open_thread" } as NextMoveAction))
    : null;

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
      {act.isError ? (
        // Previously there was no error branch at all, so a 400 from /v1/confirm
        // read as success: the button re-enabled, the card stayed, and the user
        // had no way to know their approval never landed.
        <div
          role="alert"
          style={{
            marginTop: 9,
            fontSize: 11.5,
            color: C.dangerText,
          }}
        >
          That didn’t go through. Try again, or open the thread to decide there.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today's boundary
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
