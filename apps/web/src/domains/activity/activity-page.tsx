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
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

import {
  pendinginteractionsGetOptions,
  schedulesGetOptions,
  usageTotalsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { LiveDot } from "@/components/live-dot";
import { watchersListPost } from "@/generated/daemon/sdk.gen";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { getBudgetConfig } from "@/lib/budget-api";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";

import { NeedsYouSection } from "./sections/needs-you-section";
import { QueuedSection } from "./sections/queued-section";
import { RecentlyDoneSection } from "./sections/recently-done-section";
import { RunningSection } from "./sections/running-section";
import { ScheduledSection } from "./sections/scheduled-section";
import { SequencesSection } from "./sections/sequences-section";
import { WatchingSection } from "./sections/watching-section";
import { asRecord, C, mono, serif } from "./theme";

// SSE (`useActivitySync`) now drives freshness across the command center, so
// every poll here is demoted to a 60s safety-net — it only catches events the
// stream dropped, not the steady state.
const SAFETY_NET_MS = 60_000;

function useSummary(assistantId: string) {
  // Each of these shares its query key with the matching section, so React
  // Query dedupes the request — the summary reads live cache, never a 2nd call.
  const running = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "running" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  const schedules = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 20_000,
  });
  const needsYou = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
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
    refetchInterval: SAFETY_NET_MS,
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

/** Current calendar-month window [start, now] in epoch ms. */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  // `to` must be stable across renders or the query key churns and refetches in
  // a loop (exhausting the rate limit). See usageRangeNow().
  return { from: start.getTime(), to: usageRangeNow() };
}

function useSpendMeter(assistantId: string) {
  const month = monthWindow();
  const usage = useQuery({
    ...usageTotalsGetOptions({
      path: { assistant_id: assistantId },
      query: { from: month.from, to: month.to },
    }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  // The gateway budget route only exists after a redeploy; a failed fetch just
  // means "no cap to show" — the spend figure is independent of it.
  const config = useQuery({
    queryKey: ["budget", "config", assistantId],
    queryFn: () => getBudgetConfig(assistantId),
    staleTime: 60_000,
    retry: false,
  });

  return {
    monthUsd: usage.data?.totalEstimatedCostUsd ?? 0,
    cap: config.data?.monthlyCapUsd ?? null,
    alertPct: config.data?.alertThresholdPct ?? 80,
    loading: usage.isLoading,
  };
}

function SpendMeter({ assistantId }: { assistantId: string }) {
  const { monthUsd, cap, alertPct, loading } = useSpendMeter(assistantId);

  const usd = (v: number) => `$${v.toFixed(2)}`;
  const ratio = cap != null && cap > 0 ? monthUsd / cap : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const over = ratio >= 1;
  const warn = ratio >= alertPct / 100;
  const barColor = over ? C.danger : warn ? C.amber : C.blue;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginTop: 14,
        fontFamily: mono,
        fontSize: 12.5,
        color: C.t2,
        flexWrap: "wrap",
      }}
    >
      <span style={{ whiteSpace: "nowrap" }}>
        {loading ? (
          "Adding up this month…"
        ) : (
          <>
            This month: <span style={{ color: C.ink }}>{usd(monthUsd)}</span>
            {cap != null && <span style={{ color: C.t3 }}> / {usd(cap)} cap</span>}
          </>
        )}
      </span>
      {cap != null && (
        <span
          style={{
            position: "relative",
            flex: "0 1 160px",
            height: 4,
            borderRadius: 999,
            background: C.sunken,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              position: "absolute",
              inset: 0,
              width: `${pct}%`,
              borderRadius: 999,
              background: barColor,
              transition: "width 200ms",
            }}
          />
        </span>
      )}
      <Link
        to={routes.settings.budget}
        style={{
          marginLeft: "auto",
          color: C.blueS,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Budget →
      </Link>
    </div>
  );
}

export function ActivityPage() {
  const assistantId = useActiveAssistantId();
  // Real-time: invalidate this page's caches off the SSE stream so rows update
  // the instant the daemon broadcasts, not on the 60s safety-net poll.
  useActivitySync(assistantId, true);
  const summary = useSummary(assistantId);

  // Deep-link from Home's "Run it" toast: `?focus=<workItemId>` highlights the
  // matching Running/Queued row. The param is transient — after the row applies
  // the highlight we clear it (one-shot) so refreshes don't re-pin a stale run.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  useEffect(() => {
    if (!focusId) return;
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
    // We intentionally clear once on mount/focus change; the captured focusId is
    // still threaded into the sections for this render so the highlight applies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const parts = [
    `${summary.running} running`,
    `${summary.scheduled} scheduled`,
    `${summary.watching} watching`,
    `${summary.needsYou} awaiting you`,
  ];

  return (
    <div
      data-slot="activity-page"
      style={{ height: "100%", overflowY: "auto", background: C.bg }}
    >
      {/* At mobile width the 38px editorial hero and the generous 24px gutter
          overflow the ~390px viewport — tighten both below 640px. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width:640px){[data-slot="activity-page"] [data-slot="activity-inner"]{padding:18px 16px !important;}[data-slot="activity-page"] [data-slot="activity-hero"]{font-size:28px !important;}}`,
        }}
      />
      <div
        data-slot="activity-inner"
        style={{ maxWidth: 880, margin: "0 auto", padding: 24 }}
      >
        {/* Editorial header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 11.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: C.blueS,
            }}
          >
            Activity
          </div>
          <LiveDot />
        </div>
        <div
          data-slot="activity-hero"
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

        <SpendMeter assistantId={assistantId} />

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
        <RunningSection assistantId={assistantId} focusId={focusId} />
        <QueuedSection assistantId={assistantId} focusId={focusId} />
        <ScheduledSection assistantId={assistantId} />
        <WatchingSection assistantId={assistantId} />
        <SequencesSection assistantId={assistantId} />
        <RecentlyDoneSection assistantId={assistantId} />
      </div>
    </div>
  );
}
