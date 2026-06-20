/**
 * Activity — the "what is Cue doing for me right now" command center.
 *
 * Aggregates every kind of background work Cue runs into one governable
 * surface, each item carrying its trigger provenance (▸ what kicked it off) and
 * real steer controls. Every section binds to a real daemon endpoint via the
 * generated SDK; empty states are honest (most are empty on a fresh assistant);
 * no counts, items, or triggers are fabricated.
 *
 *   Needs you      → pendinginteractionsGet            (Approve/Decline)
 *   Running now     → workitemsGet(running) + subagents (Cancel/Output/Abort)
 *   Queued          → workitemsGet(pending)            (Run now/Cancel)
 *   Scheduled       → schedulesGet                     (Run/Pause/Cancel)
 *   Watching        → watchersListPost                 (Digest)
 *   Sequences       → sequencesListPost                (Pause/Resume) [hidden if none]
 *   Recently done   → workitemsGet(done) + heartbeatRunsGet  (read-only)
 *
 * The live summary line ("N running · M scheduled · K watching · P awaiting
 * you") reads the same react-query caches the sections use (deduped by query
 * key), so it stays honest and in sync.
 */

import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import {
  pendinginteractionsGetOptions,
  schedulesGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { watchersListPost } from "@/generated/daemon/sdk.gen";

import { NeedsYouSection } from "./sections/needs-you-section";
import { QueuedSection } from "./sections/queued-section";
import { RecentlyDoneSection } from "./sections/recently-done-section";
import { RunningSection } from "./sections/running-section";
import { ScheduledSection } from "./sections/scheduled-section";
import { SequencesSection } from "./sections/sequences-section";
import { WatchingSection } from "./sections/watching-section";
import { asRecord, C, mono, serif } from "./theme";

function useSummary(assistantId: string) {
  // Each of these shares its query key with the matching section, so React
  // Query dedupes the request — the summary reads live cache, never a 2nd call.
  const running = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "running" },
    }),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });
  const schedules = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const needsYou = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  const watchers = useQuery({
    queryKey: ["activity", "watchers", assistantId],
    queryFn: async () => {
      const res = await watchersListPost({
        path: { assistant_id: assistantId },
        body: {},
        throwOnError: true,
      });
      return res.data;
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const watcherCount = (() => {
    const data = watchers.data;
    if (Array.isArray(data)) return data.length;
    const rec = asRecord(data);
    if (!rec) return 0;
    if (Array.isArray(rec.watchers)) return rec.watchers.length;
    if (Array.isArray(rec.items)) return rec.items.length;
    if (Array.isArray(rec.data)) return rec.data.length;
    return Object.values(rec).filter((v) => asRecord(v) !== null).length;
  })();

  return {
    running: running.data?.items?.length ?? 0,
    scheduled: (schedules.data?.schedules ?? []).filter(
      (s) => s.status !== "cancelled",
    ).length,
    watching: watcherCount,
    needsYou: needsYou.data?.interactions?.length ?? 0,
    loading:
      running.isLoading ||
      schedules.isLoading ||
      needsYou.isLoading ||
      watchers.isLoading,
  };
}

export function ActivityPage() {
  const assistantId = useActiveAssistantId();
  const summary = useSummary(assistantId);

  const parts = [
    `${summary.running} running`,
    `${summary.scheduled} scheduled`,
    `${summary.watching} watching`,
    `${summary.needsYou} awaiting you`,
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", background: C.bg }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: 24 }}>
        {/* Editorial header */}
        <div
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.blueS,
            marginBottom: 8,
          }}
        >
          Activity
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 38,
            letterSpacing: "-0.5px",
            lineHeight: 1.08,
            color: C.ink,
          }}
        >
          What Cue’s working on.
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: C.t2,
            marginTop: 8,
            fontFamily: mono,
          }}
        >
          {summary.loading ? "Counting what’s in motion…" : parts.join("  ·  ")}
        </div>

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.line}`,
            borderLeft: `3px solid ${C.violet}`,
            borderRadius: "0 12px 12px 0",
            padding: "11px 14px",
            fontSize: 13,
            color: C.t2,
            margin: "16px 0 22px",
          }}
        >
          Every item here was triggered by something — a schedule, a watcher,
          your own ask, or Cue’s heartbeat. The ▸ chip tells you what, and the
          controls let you steer it.
        </div>

        <NeedsYouSection assistantId={assistantId} />
        <RunningSection assistantId={assistantId} />
        <QueuedSection assistantId={assistantId} />
        <ScheduledSection assistantId={assistantId} />
        <WatchingSection assistantId={assistantId} />
        <SequencesSection assistantId={assistantId} />
        <RecentlyDoneSection assistantId={assistantId} />
      </div>
    </div>
  );
}
