/**
 * WatchLivePage — mobile v3 "Watch live" (spec frame 17): step into the weeds
 * of one running work item. Route: /assistant/work/:workItemId/live.
 *
 * Layout (spec-verbatim): ‹ back · title · "Cue · running Xm" · pulse badge
 * header, then the timestamped step stream (✓ done steps, the current step
 * pulsing, a dashed future step ending at "your review"), controls pinned in
 * thumb reach.
 *
 * DATA MAPPING — the same wiring the Activity/board surfaces consume:
 *   · `workitemsGet` (typed bucket) → the item (title/status/progress note)
 *   · `workitemsByIdEventsGet`      → the timestamped step stream
 *   · Stop      → `workitemsByIdCancelPost` (the daemon's only run control —
 *     it hard-cancels, so the button says Stop, not the frame's "Pause")
 *   · Take over → the run conversation (the existing step-in path)
 * CONTROLS OMITTED (no backend): "Redirect…" — no redirect endpoint exists;
 * step results are not persisted per-step, so the ✓ rows don't expand.
 */
import type React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  workitemsByIdCancelPostMutation,
  workitemsByIdEventsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { AuroraBackdrop, cardBody, mv3Mono } from "@/mobile-v3";
import {
  LivePulseBadge,
  clockTimeSeconds,
  elapsedLabel,
} from "@/mobile-v3/work-kit";
import { useHqWorkItems } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

/** Human line for a work-item trail event. */
function stepLabel(e: {
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
}): string {
  if (e.kind === "created") return "Captured the task";
  switch (e.toStatus) {
    case "queued":
    case "pending":
      return "Queued for a run";
    case "running":
      return "Started the run";
    case "awaiting_review":
      return "Finished — ready for your review";
    case "done":
      return "Approved";
    case "failed":
      return "Hit an error";
    case "cancelled":
      return "Stopped";
    default:
      return e.kind.replaceAll("_", " ");
  }
}


/**
 * Collapse consecutive trail events that render the same label — the daemon
 * writes both a `status_changed` and a `run_started` event on run start, so
 * without this the checklist shows "✓ Started the run" twice.
 */
function dedupeTrail<T extends { kind: string; fromStatus: string | null; toStatus: string | null }>(
  trail: T[],
  label: (e: T) => string,
): T[] {
  const out: T[] = [];
  for (const e of trail) {
    const prev = out[out.length - 1];
    if (prev && label(prev) === label(e)) continue;
    out.push(e);
  }
  return out;
}

/**
 * One timeline node: ✓ done · pulsing current · dashed future.
 *
 * `grow` lets a node absorb the stream's leftover height so a SHORT trail
 * still spans header→controls instead of stacking at the top over a dead
 * void (the node's rail line is `flex:1`, so the growth reads as a longer
 * connector, not as empty space). Nodes never shrink below their content —
 * `minHeight: 0` is deliberately NOT set — so a long trail simply scrolls.
 */
function StreamNode({
  variant,
  title,
  meta,
  last = false,
  grow = false,
  titleColor,
}: {
  variant: "done" | "current" | "future";
  title: string;
  meta?: string | null;
  last?: boolean;
  grow?: boolean;
  titleColor?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        flex: grow ? "1 1 auto" : "0 0 auto",
        ...(variant === "future" ? { opacity: 0.5 } : {}),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        {variant === "done" ? (
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--mv3-green) 20%, transparent)",
              color: "var(--mv3-green)",
              fontSize: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            ✓
          </span>
        ) : variant === "current" ? (
          <span
            aria-hidden
            style={{
              position: "relative",
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "var(--mv3-accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: -3,
                borderRadius: "50%",
                border: "1.5px solid rgba(61,110,232,.7)",
                animation: "mv3Ping 1.8s ease-out infinite",
              }}
            />
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#fff",
              }}
            />
          </span>
        ) : (
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: "1.5px dashed color-mix(in srgb, var(--mv3-text) 25%, transparent)",
              flexShrink: 0,
            }}
          />
        )}
        {!last ? (
          <span
            aria-hidden
            style={{
              width: 2,
              flex: 1,
              background:
                variant === "done"
                  ? "color-mix(in srgb, var(--mv3-green) 30%, transparent)"
                  : "var(--mv3-line)",
            }}
          />
        ) : null}
      </div>
      <div style={{ paddingBottom: last ? 0 : 18, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: variant === "future" ? 400 : 600,
            color: titleColor ?? "var(--mv3-text)",
            lineHeight: 1.35,
            // Progress notes carry raw URLs/tokens from the runner; without
            // this an unbroken string shoots past the right edge and the
            // page root's `overflow: clip` shears it mid-token.
            overflowWrap: "anywhere",
          }}
        >
          {title}
        </div>
        {meta ? (
          <div
            style={{
              fontFamily: mv3Mono,
              fontSize: 10,
              color: "var(--mv3-faint)",
              marginTop: 3,
              overflowWrap: "anywhere",
            }}
          >
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A control-bar button. `flex-basis: 140px` + `flex-wrap` on the row is what
 * keeps the bar honest at 390px: two buttons share the row, a third wraps to
 * its own full-width row rather than squeezing every label until it clips
 * ("Take ov"). `minWidth: 0` + the ellipsis span below are the last-resort
 * guard for a label that still can't fit (iOS text-size boosting, a longer
 * translation).
 */
const barBtn: React.CSSProperties = {
  flex: "1 1 140px",
  minWidth: 0,
  background: "var(--mv3-btn2-bg)",
  color: "var(--mv3-text)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 14,
  padding: "13px 10px",
  minHeight: 48,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};

/**
 * One rendered row of the stream. The trail's tail is a "current + future"
 * pair while running, a single violet future node while awaiting review, and
 * nothing once the item is terminal — flattening it lets the renderer mark
 * the true last node and pick which node absorbs the region's slack.
 */
interface StreamNodeSpec {
  key: string;
  variant: "done" | "current" | "future";
  title: string;
  meta?: string | null;
  titleColor?: string;
}

/** Label wrapper: never let a control's text spill out of its button. */
const barBtnLabel: React.CSSProperties = {
  display: "block",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function WatchLivePage() {
  const assistantId = useActiveAssistantId();
  const { workItemId = "" } = useParams();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);
  const [now] = useState(() => Date.now());

  // Typed bucket the HQ/board surfaces already consume; find our item in it.
  const all = useHqWorkItems(assistantId);
  const item = all.items.find((i) => i.id === workItemId) ?? null;
  const running = item?.status === "running";

  const eventsQuery = useQuery({
    ...workitemsByIdEventsGetOptions({
      path: { assistant_id: assistantId, id: workItemId },
    }),
    refetchInterval: running ? 5_000 : 30_000,
    staleTime: 3_000,
    enabled: Boolean(workItemId),
  });
  const trail = useMemo(
    () =>
      dedupeTrail(
        [...(eventsQuery.data?.events ?? [])].sort((a, b) => a.at - b.at),
        stepLabel,
      ),
    [eventsQuery.data?.events],
  );
  const runStart =
    [...trail].reverse().find((e) => e.toStatus === "running")?.at ??
    item?.lastActivityAt ??
    item?.updatedAt ??
    now;

  // The rendered timeline, flattened so the last node (and the node that
  // absorbs the leftover height) can be identified by index.
  const nodes: StreamNodeSpec[] = [
    ...trail.map(
      (e): StreamNodeSpec => ({
        key: e.id,
        variant: "done",
        title: stepLabel(e),
        meta: clockTimeSeconds(e.at),
      }),
    ),
    ...(running
      ? ([
          {
            key: "current",
            variant: "current",
            title: item?.lastProgressNote ?? "Cue is working on this…",
            titleColor: "var(--mv3-micro)",
            meta: "now",
          },
          {
            key: "future",
            variant: "future",
            title: "Finish → your review",
          },
        ] satisfies StreamNodeSpec[])
      : item?.status === "awaiting_review"
        ? ([
            {
              key: "future",
              variant: "future",
              title: "Waiting on your review",
              titleColor: "var(--mv3-violet)",
            },
          ] satisfies StreamNodeSpec[])
        : []),
  ];

  const queryClient = useQueryClient();
  const stop = useMutation({
    ...workitemsByIdCancelPostMutation(),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries();
    },
  });

  return (
    <div
      data-mv3
      data-slot="mv3-watch-live"
      style={{
        position: "relative",
        height: "100%",
        // `clip` (both axes — a lone overflow-x:clip computes back to hidden
        // next to overflow-y:hidden) forbids programmatic scrollLeft drift;
        // `hidden` still allowed focus/autoscroll to wedge the shell
        // sideways (P1 546px-orb fix). The aurora is paint-contained, so
        // engines without `clip` support degrade safely.
        overflow: "clip",
        display: "flex",
        flexDirection: "column",
        background: "var(--mv3-bg)",
        color: "var(--mv3-text)",
        fontFamily: "var(--mv3-font)",
      }}
    >
      {/* Frame 17's aurora sits mid-screen behind the stream. */}
      <AuroraBackdrop
        style={{
          background:
            "radial-gradient(46% 36% at 50% 30%, var(--mv3-aurora), transparent 68%)",
        }}
      />

      {/* Header: ‹ · title + agent line · pulse badge. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 20px 10px",
          flexShrink: 0,
          position: "relative",
          zIndex: 2,
        }}
      >
        <button
          type="button"
          className="cue-pressable"
          aria-label="Back"
          onClick={() => {
            haptic.light();
            navigate(-1);
          }}
          style={{
            fontSize: 16,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: "10px 6px",
            margin: "-10px 0",
            minHeight: 44,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          ‹
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item?.title ?? "…"}
          </div>
          <div style={{ fontSize: 11, color: "var(--mv3-micro)" }}>
            {running
              ? `Cue · running ${elapsedLabel(runStart, now)}`
              : item
                ? `Cue · ${item.status.replaceAll("_", " ")}`
                : ""}
          </div>
        </div>
        {running ? <LivePulseBadge size={22} /> : null}
      </div>

      {/* The step stream — owns the scroll region. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          padding: "8px 22px 12px",
          position: "relative",
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {!item && !all.isLoading ? (
          <div style={cardBody}>
            This work item isn&apos;t here anymore — it may have been archived.
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              // Fill the region so a 3-step trail stretches its connectors
              // down to the controls instead of leaving a dead void; a long
              // trail overflows this and the parent scrolls it.
              flex: 1,
              minHeight: 0,
            }}
          >
            {nodes.map((n, i) => (
              <StreamNode
                key={n.key}
                variant={n.variant}
                title={n.title}
                meta={n.meta}
                titleColor={n.titleColor}
                last={i === nodes.length - 1}
                // The node just above the tail absorbs the slack, so its rail
                // line runs down to the tail step ("Finish → your review")
                // instead of the region ending in a dead void. Steps
                // themselves keep their spec spacing.
                grow={i === Math.max(0, nodes.length - 2)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Controls — always in thumb reach. */}
      <div
        style={{
          flexShrink: 0,
          padding: "12px 18px 10px",
          position: "relative",
          zIndex: 5,
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
          {running ? (
            <button
              type="button"
              className="cue-pressable"
              disabled={stop.isPending}
              onClick={() => {
                haptic.medium();
                stop.mutate({
                  path: { assistant_id: assistantId, id: workItemId },
                });
              }}
              style={{ ...barBtn, opacity: stop.isPending ? 0.6 : 1 }}
            >
              <span style={barBtnLabel}>
                {stop.isPending ? "Stopping…" : "⏹ Stop"}
              </span>
            </button>
          ) : null}
          {item?.lastRunConversationId ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.medium();
                navigate(routes.conversation(item.lastRunConversationId!));
              }}
              style={barBtn}
            >
              <span style={barBtnLabel}>Take over</span>
            </button>
          ) : null}
          {item?.status === "awaiting_review" ? (
            <button
              type="button"
              className="cue-pressable"
              onClick={() => {
                haptic.medium();
                navigate(routes.reviewQueue);
              }}
              style={{
                ...barBtn,
                flex: "1.4 1 140px",
                background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
                color: "#fff",
                border: "none",
                boxShadow: "var(--mv3-primary-btn-shadow)",
              }}
            >
              <span style={barBtnLabel}>Review ›</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
