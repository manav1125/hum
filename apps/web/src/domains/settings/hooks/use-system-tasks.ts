import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchConsolidationConfig,
  fetchHeartbeatConfig,
  fetchRetrospectiveConfig,
  runConsolidationNow,
  runHeartbeatNow,
  updateHeartbeatConfig,
} from "@/domains/settings/api/schedules";
import {
  heartbeatConfigGetQueryKey,
  heartbeatConfigGetSetQueryData,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { HeartbeatConfigGetData } from "@/generated/daemon/types.gen";
import {
  type ScheduleRowUsage,
  systemTaskUsageQueryOptions,
  ZERO_ROW_USAGE_SUMMARY,
} from "@/domains/settings/utils/schedule-formatters";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library/components/toast";

import type { SystemTaskKind } from "@/domains/settings/types/schedules";

/**
 * Encapsulates all TanStack Query composition + mutation logic for
 * system tasks (heartbeat, consolidation, memory retrospective). Exposes
 * a unified interface that the page orchestrator consumes without managing
 * the queries and callbacks itself. Retrospectives are event-driven, so
 * they have no run-now mutation or toggle.
 */
export function useSystemTasks(assistantId: string | undefined, tz: string) {
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // Config queries
  // -------------------------------------------------------------------------

  const heartbeatConfigOpts = {
    path: { assistant_id: assistantId ?? "" },
  } as Options<HeartbeatConfigGetData>;

  const {
    data: heartbeatConfig,
    isLoading: isHeartbeatLoading,
    isError: isHeartbeatError,
    refetch: refetchHeartbeat,
  } = useQuery({
    queryKey: heartbeatConfigGetQueryKey(heartbeatConfigOpts),
    queryFn: () => fetchHeartbeatConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: consolidationConfig,
    isLoading: isConsolidationLoading,
    isError: isConsolidationError,
    refetch: refetchConsolidation,
  } = useQuery({
    queryKey: ["consolidation-config", assistantId],
    queryFn: () => fetchConsolidationConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  const {
    data: retrospectiveConfig,
    isLoading: isRetrospectiveLoading,
    isError: isRetrospectiveError,
    refetch: refetchRetrospective,
  } = useQuery({
    queryKey: ["retrospective-config", assistantId],
    queryFn: () => fetchRetrospectiveConfig(assistantId!),
    enabled: !!assistantId,
    staleTime: 10_000,
  });

  // -------------------------------------------------------------------------
  // Usage stats (server-side aggregate)
  // -------------------------------------------------------------------------

  // One server aggregate for all three jobs rather than a client-side sum over
  // fetched runs. Heartbeat records several hundred runs a week, so summing a
  // page of them produced a figure covering under two days while the caption
  // read "(7d)" — and consolidation runs on ephemeral conversations that are
  // deleted once the run settles, so its cost was missing from the page
  // entirely. Both are fixed by asking the server for the window's total.
  const {
    data: systemTaskUsage,
    isLoading: isSystemUsageLoading,
    isError: isSystemUsageError,
    refetch: refetchSystemUsage,
  } = useQuery(systemTaskUsageQueryOptions(assistantId, tz, !!assistantId));

  const usageForKind = useCallback(
    (kind: SystemTaskKind): ScheduleRowUsage => {
      if (isSystemUsageLoading) return { status: "loading" };
      if (isSystemUsageError) return { status: "error" };
      return {
        status: "ready",
        summary:
          systemTaskUsage?.find((s) => s.kind === kind) ??
          ZERO_ROW_USAGE_SUMMARY,
      };
    },
    [isSystemUsageError, isSystemUsageLoading, systemTaskUsage],
  );

  const heartbeatUsage = useMemo(
    () => usageForKind("heartbeat"),
    [usageForKind],
  );
  const consolidationUsage = useMemo(
    () => usageForKind("consolidation"),
    [usageForKind],
  );
  const retrospectiveUsage = useMemo(
    () => usageForKind("retrospective"),
    [usageForKind],
  );

  // -------------------------------------------------------------------------
  // Running state + timeout cleanup
  // -------------------------------------------------------------------------

  const [isHeartbeatRunning, setIsHeartbeatRunning] = useState(false);
  const [isConsolidationRunning, setIsConsolidationRunning] = useState(false);
  const timeoutIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const scheduleDelayedInvalidation = useCallback(
    (kind: SystemTaskKind) => {
      if (!assistantId) return;
      const invalidate = () => {
        void queryClient.invalidateQueries({
          queryKey: ["system-task-runs", assistantId, kind],
        });
      };
      invalidate();
      const t1 = setTimeout(invalidate, 1_000);
      const t2 = setTimeout(invalidate, 5_000);
      timeoutIdsRef.current.push(t1, t2);
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleRunNow = useCallback(
    async (kind: SystemTaskKind) => {
      if (!assistantId) return;
      // Retrospectives are event-driven per conversation — there is nothing
      // global to trigger, so no run-now exists for that kind.
      if (kind === "retrospective") return;
      const setRunning =
        kind === "heartbeat"
          ? setIsHeartbeatRunning
          : setIsConsolidationRunning;
      const runFn =
        kind === "heartbeat" ? runHeartbeatNow : runConsolidationNow;
      const refetchConfig =
        kind === "heartbeat" ? refetchHeartbeat : refetchConsolidation;
      const successMsg =
        kind === "heartbeat" ? "Heartbeat started." : "Consolidation queued.";
      const skipMsg =
        kind === "heartbeat"
          ? "Heartbeat skipped."
          : "Consolidation already queued or running.";

      setRunning(true);
      try {
        const result = await runFn(assistantId);
        void refetchConfig();
        scheduleDelayedInvalidation(kind);
        void refetchSystemUsage();
        if (result.ran) {
          toast.success(successMsg);
        } else {
          toast.info(skipMsg);
        }
      } catch (error) {
        captureError(error, { context: `${kind}_run_now` });
        toast.error(`Failed to run ${kind}.`);
      } finally {
        setRunning(false);
      }
    },
    [
      assistantId,
      refetchConsolidation,
      refetchHeartbeat,
      refetchSystemUsage,
      scheduleDelayedInvalidation,
    ],
  );

  const handleToggle = useCallback(
    async (kind: SystemTaskKind, enabled: boolean) => {
      if (!assistantId) return;
      if (kind !== "heartbeat") return;
      const label = "Heartbeat";

      try {
        const updated = await updateHeartbeatConfig(assistantId, { enabled });
        heartbeatConfigGetSetQueryData(
          queryClient,
          {
            path: { assistant_id: assistantId },
          } as Options<HeartbeatConfigGetData>,
          updated,
        );
        toast.success(enabled ? `${label} enabled.` : `${label} disabled.`);
      } catch (error) {
        captureError(error, { context: `${kind}_toggle` });
        toast.error(`Failed to toggle ${label.toLowerCase()}.`);
      }
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // Retry
  // -------------------------------------------------------------------------

  const refetchAll = useCallback(() => {
    void refetchHeartbeat();
    void refetchConsolidation();
    void refetchRetrospective();
    void refetchSystemUsage();
  }, [
    refetchConsolidation,
    refetchHeartbeat,
    refetchRetrospective,
    refetchSystemUsage,
  ]);

  // -------------------------------------------------------------------------
  // Cleanup pending timeouts on unmount
  // -------------------------------------------------------------------------

  useEffect(() => {
    const ref = timeoutIdsRef;
    return () => {
      for (const id of ref.current) clearTimeout(id);
      ref.current = [];
    };
  }, []);

  return {
    heartbeatConfig,
    consolidationConfig,
    retrospectiveConfig,
    heartbeatUsage,
    consolidationUsage,
    retrospectiveUsage,
    isLoading:
      isHeartbeatLoading || isConsolidationLoading || isRetrospectiveLoading,
    hasError: isHeartbeatError || isConsolidationError || isRetrospectiveError,
    isHeartbeatRunning,
    isConsolidationRunning,
    isHeartbeatLoading,
    isHeartbeatError,
    isConsolidationLoading,
    isConsolidationError,
    isRetrospectiveLoading,
    isRetrospectiveError,
    refetchHeartbeat,
    refetchConsolidation,
    refetchRetrospective,
    handleRunNow,
    handleToggle,
    refetchAll,
  };
}
