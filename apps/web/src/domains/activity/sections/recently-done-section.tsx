/**
 * Recently done — completed work-items + recent autonomous heartbeat runs.
 *
 * Work-items: `workitemsGet?status=done` (opaque, narrowed in use-work-items).
 * Heartbeat runs: `heartbeatRunsGet` (fully typed) — Cue's proactive check-ins,
 * with outcome (status / skipReason) + when (finishedAt). Read-only: this
 * section reports outcomes, it doesn't steer. Provenance is "background work"
 * for done items (or the item's own derived trigger) and "Cue’s heartbeat" for
 * heartbeat runs.
 */

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";

import { heartbeatRunsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import {
  useWorkItemResultsStore,
  type WorkItemResult,
} from "@/stores/work-item-results-store";

import { ActivitySection } from "../activity-section";
import { ActivityRow, RowButton, type PillTone } from "../activity-row";
import { C, relativeTime } from "../theme";
import { useWorkItems } from "../use-work-items";

const MAX_ROWS = 8;

interface DoneRow {
  key: string;
  title: string;
  subtitle: string | null;
  provenance: string;
  meta: string | null;
  statusLabel: string;
  statusTone: PillTone;
  at: number;
  /** Inline P2 result (summary + highlights + thread), when the work-item
   *  emitted a `work_item_completed` event this session. */
  result?: WorkItemResult;
}

function runTone(status: string, skipped: boolean): PillTone {
  if (skipped) return "neutral";
  const s = status.toLowerCase();
  if (s.includes("fail") || s.includes("error")) return "danger";
  if (s.includes("ok") || s.includes("success") || s.includes("done") || s.includes("complete"))
    return "green";
  return "neutral";
}

export function RecentlyDoneSection({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const done = useWorkItems(assistantId, "done");
  // P2: inline results stashed by `use-activity-sync` off `work_item_completed`.
  const resultsById = useWorkItemResultsStore((s) => s.byId);

  const heartbeat = useQuery({
    // SSE (`useActivitySync`) drives freshness; poll is a 60s safety-net.
    ...heartbeatRunsGetOptions({
      path: { assistant_id: assistantId },
      query: { limit: 12 },
    }),
    refetchInterval: 60_000,
    staleTime: 20_000,
  });

  const rows = useMemo<DoneRow[]>(() => {
    const out: DoneRow[] = [];

    for (const item of done.items) {
      const result = resultsById[item.id];
      out.push({
        key: `wi-${item.id}`,
        title: item.title,
        // Prefer the inline result summary when we have it (zero extra fetch).
        subtitle: result?.summary ?? null,
        provenance: item.provenance ?? "background work",
        meta: item.at != null ? relativeTime(item.at) : null,
        statusLabel: result?.status === "failed" ? "failed" : "done",
        statusTone: result?.status === "failed" ? "danger" : "green",
        at: item.at ?? 0,
        result,
      });
    }

    for (const run of heartbeat.data?.runs ?? []) {
      const skipped = Boolean(run.skipReason);
      const when = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
      const outcome = skipped
        ? `skipped — ${run.skipReason}`
        : run.error
          ? `failed — ${run.error}`
          : run.status;
      out.push({
        key: `hb-${run.id}`,
        title: "Heartbeat check-in",
        subtitle: outcome,
        provenance: "Cue’s heartbeat",
        meta: when != null ? relativeTime(when) : null,
        statusLabel: skipped ? "skipped" : run.status,
        statusTone: runTone(run.status, skipped),
        at: when ?? 0,
      });
    }

    return out.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
  }, [done.items, heartbeat.data?.runs, resultsById]);

  const isLoading = done.isLoading || heartbeat.isLoading;
  const isError = done.isError || heartbeat.isError;
  const empty = !isLoading && !isError && rows.length === 0;

  return (
    <ActivitySection
      icon={CheckCircle2}
      title="Recently done"
      accent={C.green}
      loading={isLoading}
      loadingLabel="Loading recent activity…"
      error={isError}
      empty={empty}
      emptyLabel="Nothing finished recently — completed background work and Cue’s check-ins show up here."
    >
      {rows.map((r, i) => {
        const highlights = r.result?.highlights ?? [];
        const threadId = r.result?.conversationId;
        return (
          <ActivityRow
            key={r.key}
            dotColor={r.statusTone === "danger" ? C.danger : C.green}
            title={r.title}
            subtitle={r.subtitle}
            provenance={r.provenance}
            meta={r.meta}
            statusLabel={r.statusLabel}
            statusTone={r.statusTone}
            last={i === rows.length - 1}
            actions={
              threadId ? (
                <RowButton
                  label="Open thread"
                  variant="ghost"
                  onClick={() =>
                    navigate(`/assistant/conversations/${threadId}`)
                  }
                />
              ) : undefined
            }
          >
            {highlights.length > 0 ? (
              <ul
                style={{
                  margin: "6px 0 0",
                  padding: "0 0 0 16px",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: C.t2,
                }}
              >
                {highlights.slice(0, 4).map((h, hi) => (
                  <li key={hi}>{h}</li>
                ))}
              </ul>
            ) : null}
          </ActivityRow>
        );
      })}
    </ActivitySection>
  );
}
