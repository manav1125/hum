/**
 * The bar that says Cue is watching your screen.
 *
 * Screen observation is the highest-trust thing Cue does, so the rule this
 * component exists to enforce is simple: **while a capture session is armed,
 * the person being watched can see it and can stop it, from wherever they
 * are.** It mounts in the root layout rather than a settings page for exactly
 * that reason — a switch buried in settings is a control, not an indicator.
 *
 * Three deliberate refusals:
 *
 * - **It cannot be dismissed.** Every other banner in the app can be waved
 *   away, because every other banner reports a condition rather than an
 *   ongoing act. A dismissible watching indicator is a watching indicator that
 *   is off exactly when it matters.
 * - **It shows only real numbers.** The countdown, the items filed and the
 *   remaining budget all come from the session view. Nothing here is
 *   estimated, and when a number is absent it is not drawn.
 * - **Stopping is one tap and takes effect on the daemon**, not just in this
 *   tab. The session is server-side state; the driver re-reads it every tick.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import {
  cueliveObservationSessionGetOptions,
  cueliveObservationSessionGetQueryKey,
  cueliveObservationSessionStopPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

/**
 * How often the banner re-reads the session while it is up.
 *
 * The session can end without this tab doing anything — it expires on its own
 * clock, and it can be stopped from another surface — so the indicator must
 * not be able to outlive the watching it reports. Five seconds is well inside
 * the shortest capture interval.
 */
const POLL_MS = 5_000;

/** `142` → `2:22`. Seconds are the unit the owner cares about near the end. */
function countdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ObservationWatchBanner() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...cueliveObservationSessionGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: Boolean(assistantId),
    // Polled rather than pushed: a missed event would leave the bar up after
    // watching stopped, or — far worse — down while it continued.
    refetchInterval: POLL_MS,
    staleTime: 0,
  });

  const stop = useMutation({
    ...cueliveObservationSessionStopPostMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: cueliveObservationSessionGetQueryKey({
          path: { assistant_id: assistantId ?? "" },
        }),
      });
    },
  });

  // `armed` is the daemon's own word for "a session is live right now" — the
  // same value the capture gate reads. Rendering off anything else would let
  // the indicator and the behaviour disagree.
  if (!data?.armed) return null;

  const filed = data.itemsFiled;
  const remaining = data.secondsRemaining;

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="observation-watch-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        background: "var(--mv1-amber-wash, var(--surface-raised))",
        borderBottom: "1px solid var(--border-base)",
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      <Eye
        size={15}
        aria-hidden
        style={{ color: "var(--mv1-amber)", flexShrink: 0 }}
      />
      <span style={{ fontWeight: 600, color: "var(--content-primary)" }}>
        Cue is watching your screen
      </span>
      <span
        style={{
          color: "var(--content-secondary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {countdown(remaining)} left
        {/* Only stated once something has been taken. "0 filed" reads as a
            reassurance, and this bar is not here to reassure. */}
        {filed > 0
          ? ` · ${filed} ${filed === 1 ? "item" : "items"} filed`
          : null}
      </span>
      <button
        type="button"
        onClick={() => {
          if (!assistantId) return;
          stop.mutate({ path: { assistant_id: assistantId } });
        }}
        disabled={stop.isPending}
        style={{
          marginLeft: "auto",
          padding: "4px 12px",
          borderRadius: 6,
          border: "1px solid var(--border-strong)",
          background: "var(--surface-base)",
          color: "var(--content-primary)",
          fontSize: 12.5,
          fontWeight: 600,
          cursor: stop.isPending ? "default" : "pointer",
        }}
      >
        {stop.isPending ? "Stopping…" : "Stop watching"}
      </button>
    </div>
  );
}
