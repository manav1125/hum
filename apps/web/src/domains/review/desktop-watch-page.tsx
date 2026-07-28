/**
 * DesktopWatchPage — the desktop half of "watch it run".
 *
 * `/assistant/work/:workItemId/live` used to mount the phone's frame-17 page
 * on every device, so clicking "Watch it run" from a desktop chat dropped the
 * user into a full-bleed aurora phone surface. This is the desktop
 * counterpart, in the serif-HQ language: the run's step trail as a timeline,
 * with the run controls beside it.
 *
 * DATA — {@link useWorkItemStream}, the shared derivation both devices use
 * (`workitemsGet` for the item, `workitemsByIdEventsGet` for the trail). The
 * only mutation here is Stop → `workitemsByIdCancelPost`, the daemon's one run
 * control; it hard-cancels, so the button says Stop, not Pause.
 *
 * Honesty: done rows are events the daemon wrote, with its own narration where
 * a row carries any. The pulsing "now" row shows the runner's latest progress
 * note and appears only while the item is genuinely `running`; the dashed tail
 * is drawn from the item's real status and nothing else. "Take over" renders
 * only when a run conversation exists to take over in. Cue has no redirect
 * endpoint and does not persist per-step results, so there is no Redirect
 * control and the done rows don't expand.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { workitemsByIdCancelPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { C, mono, serif } from "@/lib/hq-theme";
import { clockTimeSeconds, elapsedLabel } from "@/mobile-v3/work-kit";
import { rateLimitRetry } from "@/utils/rate-limit-retry";
import { routes } from "@/utils/routes";

import { stepLabel, useWorkItemStream } from "./use-work-item-stream";

/** How often the elapsed label re-reads the clock while a run is in flight. */
const TICK_MS = 15_000;

const panel: CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 14,
  padding: 22,
};

const microLabel: CSSProperties = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: C.t3,
};

const quietBtn: CSSProperties = {
  background: C.sunken,
  color: C.t1,
  border: `1px solid ${C.line}`,
  borderRadius: 9,
  padding: "9px 16px",
  fontSize: 13,
  cursor: "pointer",
};

/** One row of the timeline: ✓ recorded · ◷ happening now · ◌ still to come. */
function StreamRow({
  variant,
  title,
  detail,
  meta,
  last,
}: {
  variant: "done" | "current" | "future";
  title: string;
  detail?: string | null;
  meta?: string | null;
  last: boolean;
}) {
  const dotColor =
    variant === "done" ? C.green : variant === "current" ? C.blue : C.t3;
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        opacity: variant === "future" ? 0.55 : 1,
      }}
    >
      <div
        style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
      >
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: variant === "current" ? "#fff" : dotColor,
            background:
              variant === "current"
                ? C.blue
                : variant === "done"
                  ? "color-mix(in srgb, var(--mv1-green) 18%, transparent)"
                  : "transparent",
            border: variant === "future" ? `1.5px dashed ${C.line2}` : "none",
          }}
        >
          {variant === "done" ? "✓" : variant === "current" ? "◷" : ""}
        </span>
        {!last ? (
          <span
            aria-hidden
            style={{
              width: 2,
              flex: 1,
              minHeight: 18,
              background:
                variant === "done"
                  ? "color-mix(in srgb, var(--mv1-green) 28%, transparent)"
                  : C.line,
            }}
          />
        ) : null}
      </div>
      <div style={{ paddingBottom: last ? 0 : 16, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: variant === "future" ? 400 : 600,
            color: variant === "current" ? C.blue : C.t1,
            lineHeight: 1.4,
            overflowWrap: "anywhere",
          }}
        >
          {title}
        </div>
        {detail ? (
          <div
            style={{
              fontSize: 13,
              color: C.t2,
              marginTop: 3,
              lineHeight: 1.5,
              overflowWrap: "anywhere",
            }}
          >
            {detail}
          </div>
        ) : null}
        {meta ? (
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              color: C.t3,
              marginTop: 4,
            }}
          >
            {meta}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface RowSpec {
  key: string;
  variant: "done" | "current" | "future";
  title: string;
  detail?: string | null;
  meta?: string | null;
}

export function DesktopWatchPage() {
  const assistantId = useActiveAssistantId();
  const { workItemId = "" } = useParams();
  const navigate = useNavigate();
  useActivitySync(assistantId, true);

  const [now, setNow] = useState(() => Date.now());
  const { item, isLoading, trail, running, runStart } = useWorkItemStream(
    assistantId,
    workItemId,
    now,
  );

  // The elapsed label must not go stale while the tab sits open on a live run.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const queryClient = useQueryClient();
  const stop = useMutation({
    ...workitemsByIdCancelPostMutation(),
    ...rateLimitRetry,
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  const rows: RowSpec[] = [
    ...trail.map(
      (e): RowSpec => ({
        key: e.id,
        variant: "done",
        title: stepLabel(e),
        detail: e.detail,
        meta: clockTimeSeconds(e.at),
      }),
    ),
    ...(running
      ? ([
          {
            key: "current",
            variant: "current",
            title: item?.lastProgressNote ?? "Cue is working on this…",
            meta: "now",
          },
          { key: "future", variant: "future", title: "Finish → your review" },
        ] satisfies RowSpec[])
      : item?.status === "awaiting_review"
        ? ([
            {
              key: "future",
              variant: "future",
              title: "Waiting on your review",
            },
          ] satisfies RowSpec[])
        : []),
  ];

  const statusLine = running
    ? `Running ${elapsedLabel(runStart, now)}`
    : item
      ? item.status.replaceAll("_", " ")
      : "";

  return (
    <div
      data-slot="desktop-watch"
      style={{
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: C.t1,
        maxWidth: 820,
        margin: "0 auto",
        padding: "24px 20px 60px",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      <div>
        <button
          type="button"
          onClick={() => navigate(routes.allWork)}
          style={{
            ...microLabel,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
        >
          ‹ All work
        </button>
        <div
          style={{
            fontFamily: serif,
            fontSize: 30,
            marginTop: 4,
            lineHeight: 1.15,
          }}
        >
          {item?.title ?? (isLoading ? "Loading…" : "Work item")}
        </div>
        {statusLine ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              fontSize: 13.5,
              color: running ? C.blue : C.t2,
            }}
          >
            {running ? (
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: C.blue,
                }}
              />
            ) : null}
            Cue · {statusLine}
          </div>
        ) : null}
      </div>

      <div style={panel}>
        <div style={microLabel}>Steps</div>
        {!item && !isLoading ? (
          <div style={{ fontSize: 13.5, color: C.t2, marginTop: 12 }}>
            This work item isn&rsquo;t here anymore — it may have been archived.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ fontSize: 13.5, color: C.t2, marginTop: 12 }}>
            {isLoading
              ? "Loading the run…"
              : "No steps recorded yet — nothing has come back describing what this run did."}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            {rows.map((r, i) => (
              <StreamRow
                key={r.key}
                variant={r.variant}
                title={r.title}
                detail={r.detail}
                meta={r.meta}
                last={i === rows.length - 1}
              />
            ))}
          </div>
        )}

        {item ? (
          <div
            style={{
              display: "flex",
              gap: 9,
              flexWrap: "wrap",
              marginTop: 20,
              paddingTop: 16,
              borderTop: `1px solid ${C.line}`,
            }}
          >
            {running ? (
              <button
                type="button"
                disabled={stop.isPending}
                onClick={() =>
                  stop.mutate({
                    path: { assistant_id: assistantId, id: workItemId },
                  })
                }
                style={{
                  background:
                    "color-mix(in srgb, var(--mv1-danger) 12%, transparent)",
                  color: C.danger,
                  border:
                    "1px solid color-mix(in srgb, var(--mv1-danger) 35%, transparent)",
                  borderRadius: 9,
                  padding: "9px 16px",
                  fontSize: 13,
                  cursor: "pointer",
                  opacity: stop.isPending ? 0.6 : 1,
                }}
              >
                {stop.isPending ? "Stopping…" : "■ Stop"}
              </button>
            ) : null}
            {item.lastRunConversationId ? (
              <button
                type="button"
                onClick={() =>
                  navigate(routes.conversation(item.lastRunConversationId!))
                }
                style={quietBtn}
              >
                Take over in the conversation
              </button>
            ) : null}
            {item.status === "awaiting_review" ? (
              <button
                type="button"
                onClick={() =>
                  navigate(
                    `${routes.reviewQueue}?item=${encodeURIComponent(item.id)}`,
                  )
                }
                style={{
                  background: C.blue,
                  color: "#fff",
                  border: "none",
                  borderRadius: 9,
                  padding: "9px 18px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Review →
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
