/**
 * Scheduled — recurring + one-shot schedules (`schedulesGet`, fully typed).
 *
 * Renders name + cadenceDescription, nextRunAt (relative), and lastStatus.
 * Steer: Run now (`schedulesByIdRunPost`), Pause/Resume
 * (`schedulesByIdTogglePost` with `{ enabled }`), Cancel
 * (`schedulesByIdCancelPost`). Provenance is honestly "recurring" for cron/rrule
 * schedules and "one-shot" when `isOneShot` — both read straight off the
 * typed payload.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";

import {
  schedulesByIdCancelPostMutation,
  schedulesByIdRunPostMutation,
  schedulesByIdTogglePostMutation,
  schedulesGetOptions,
  schedulesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton, type PillTone } from "../activity-row";
import { C, relativeTime } from "../theme";

function lastStatusTone(status: string | null): PillTone {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "danger";
  if (s.includes("success") || s.includes("ok") || s.includes("done")) return "green";
  return "neutral";
}

export function ScheduledSection({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    // SSE (`useActivitySync`) drives freshness; poll is a 60s safety-net.
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  const key = schedulesGetQueryKey({ path: { assistant_id: assistantId } });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: key });

  const run = useMutation({ ...schedulesByIdRunPostMutation(), onSuccess: invalidate });
  const toggle = useMutation({ ...schedulesByIdTogglePostMutation(), onSuccess: invalidate });
  const cancel = useMutation({ ...schedulesByIdCancelPostMutation(), onSuccess: invalidate });
  const mutating = run.isPending || toggle.isPending || cancel.isPending;

  // Hide cancelled/fired one-shots that have nothing left to do — keep the
  // surface to the live schedule slate.
  const schedules = (query.data?.schedules ?? []).filter(
    (s) => s.status !== "cancelled",
  );
  const empty = !query.isLoading && !query.isError && schedules.length === 0;

  return (
    <ActivitySection
      icon={CalendarClock}
      title="Scheduled"
      accent={C.violet}
      count={schedules.length}
      loading={query.isLoading}
      loadingLabel="Loading schedules…"
      error={query.isError}
      empty={empty}
      emptyLabel="No scheduled work yet — ask Cue to do something on a cadence."
    >
      {schedules.map((s, i) => {
        const next = relativeTime(s.nextRunAt);
        const meta = [
          next ? `next ${next}` : null,
          s.lastStatus ? `last ${s.lastStatus}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <ActivityRow
            key={s.id}
            dotColor={s.enabled ? C.violet : C.t3}
            title={s.name || s.cadenceDescription || "Schedule"}
            subtitle={s.cadenceDescription || s.description || s.message}
            provenance={s.isOneShot ? "one-shot" : "recurring"}
            meta={meta || null}
            statusLabel={s.enabled ? "active" : "paused"}
            statusTone={
              s.enabled ? lastStatusTone(s.lastStatus) : "neutral"
            }
            last={i === schedules.length - 1}
            actions={
              <>
                <RowButton
                  label="Run now"
                  variant="primary"
                  disabled={mutating}
                  onClick={() =>
                    run.mutate({
                      path: { assistant_id: assistantId, id: s.id },
                    })
                  }
                />
                <RowButton
                  label={s.enabled ? "Pause" : "Resume"}
                  disabled={mutating}
                  onClick={() =>
                    toggle.mutate({
                      path: { assistant_id: assistantId, id: s.id },
                      body: { enabled: !s.enabled },
                    })
                  }
                />
                <RowButton
                  label="Cancel"
                  variant="danger"
                  disabled={mutating}
                  onClick={() =>
                    cancel.mutate({
                      path: { assistant_id: assistantId, id: s.id },
                    })
                  }
                />
              </>
            }
          />
        );
      })}
    </ActivitySection>
  );
}
