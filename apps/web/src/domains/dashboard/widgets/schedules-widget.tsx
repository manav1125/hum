/**
 * Schedules widget — REAL data via `schedulesGetOptions`.
 *
 * Lists saved schedules (name · cadence · next run) with a "Run now" per row
 * that fires `schedulesByIdRunPost`. On success the list is invalidated so the
 * row's next-run / status reflects the trigger.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  schedulesByIdRunPostMutation,
  schedulesGetOptions,
  schedulesGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "../theme";
import { WidgetFrame } from "./widget-frame";

const MAX_ROWS = 4;

function formatNextRun(epochSeconds: number): string {
  if (!epochSeconds || epochSeconds <= 0) return "—";
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SchedulesWidget({ assistantId }: { assistantId: string }) {
  const queryClient = useQueryClient();
  const queryKey = schedulesGetQueryKey({
    path: { assistant_id: assistantId },
  });

  const query = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const runNow = useMutation({
    ...schedulesByIdRunPostMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const schedules = (query.data?.schedules ?? []).slice(0, MAX_ROWS);

  return (
    <WidgetFrame
      title="Schedules"
      loading={query.isLoading}
      loadingLabel="Loading schedules…"
      error={query.isError}
      empty={
        !query.isLoading && !query.isError && schedules.length === 0
      }
      emptyLabel="No saved schedules — ask Cue to run something on a cadence."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {schedules.map((s) => {
          const pendingThis =
            runNow.isPending && runNow.variables?.path?.id === s.id;
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 0",
                borderBottom: `1px solid ${C.line}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: C.t1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.name}
                </div>
                <div style={{ fontSize: 11, color: C.t3 }}>
                  {s.cadenceDescription} · next{" "}
                  <span style={{ fontFamily: mono }}>
                    {formatNextRun(s.nextRunAt)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                disabled={runNow.isPending}
                onClick={() =>
                  runNow.mutate({
                    path: { assistant_id: assistantId, id: s.id },
                  })
                }
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  border: `1px solid ${C.line2}`,
                  background: C.surface,
                  color: C.t1,
                  borderRadius: 8,
                  padding: "4px 10px",
                  cursor: runNow.isPending ? "default" : "pointer",
                  opacity: runNow.isPending ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {pendingThis ? "Running…" : "Run now"}
              </button>
            </div>
          );
        })}
      </div>
    </WidgetFrame>
  );
}
