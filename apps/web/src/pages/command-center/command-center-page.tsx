/**
 * Command Center — the one home.
 *
 * The single, premium, real-time operating-system landing that consolidates the
 * four redundant surfaces (Home · Mission Control · Activity · Agents-at-work)
 * into ONE calm, prioritized vertical stream. It answers, top-to-bottom:
 *
 *   Needs you   → what wants a human decision right now (PINNED when non-empty)
 *   In motion   → what Cue is doing this second (running work + live subagents)
 *   Up next     → what's queued: inbound triage + schedules + watchers + sequences
 *   Done today  → what just finished, with the result inline
 *
 * This is a COMPOSITION, not a rewrite. Every group reuses the existing, fully
 * wired Activity section components (which already bind the real daemon
 * endpoints + steer controls) and Home's feed (`InboundLane` → `useHomeFeedQuery`
 * + `HomeFeedList`) for triage. The page mounts `useActivitySync` so every group
 * updates the instant the daemon broadcasts — the header carries a real ● live
 * indicator, the hours-saved / spend strip is honest usage data, and nothing on
 * this surface is fabricated.
 *
 * It is the default landing (Home). The legacy routes (`/mission-control`,
 * `/activity`, `/agents`, `/next-moves`) redirect here.
 *
 * Layout: a single editorial column (max 880px), naturally mobile-friendly —
 * the same stream reflows to one column on the ~390px viewport the macOS app +
 * mobile both render.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ReactNode } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { LiveDot } from "@/components/live-dot";
import { useActivitySync } from "@/hooks/use-activity-sync";
import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";
import {
  homeImpactGetOptions,
  pendinginteractionsGetOptions,
  schedulesGetOptions,
  usageTotalsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { getBudgetConfig } from "@/lib/budget-api";
import { routes } from "@/utils/routes";
import { usageRangeNow } from "@/utils/usage-window";

import { C, mono, serif } from "@/domains/activity/theme";
import { NeedsYouSection } from "@/domains/activity/sections/needs-you-section";
import { RecentlyDoneSection } from "@/domains/activity/sections/recently-done-section";
import { RunningSection } from "@/domains/activity/sections/running-section";
import { ScheduledSection } from "@/domains/activity/sections/scheduled-section";
import { SequencesSection } from "@/domains/activity/sections/sequences-section";
import { WatchingSection } from "@/domains/activity/sections/watching-section";
import { InboundLane } from "@/pages/mission-control/inbound-lane";

// SSE (`useActivitySync`) drives freshness across the whole stream, so every
// poll below is demoted to a 60s safety-net — it only catches events the stream
// dropped, never the steady state.
const SAFETY_NET_MS = 60_000;

/**
 * The one honest status line. Each query shares its key with the matching group
 * section, so React Query dedupes the request — the tally reads live cache,
 * never a second call. We deliberately do NOT use the parked `activity_list`
 * read model, so a single endpoint hiccup can never zero the header.
 */
function useTally(assistantId: string) {
  const running = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "running" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 15_000,
  });
  const done = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "done" },
    }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 20_000,
  });
  const schedules = useQuery({
    ...schedulesGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 20_000,
  });
  const awaiting = useQuery({
    ...pendinginteractionsGetOptions({ path: { assistant_id: assistantId } }),
    refetchInterval: SAFETY_NET_MS,
    staleTime: 10_000,
  });

  const standing = (schedules.data?.schedules ?? []).filter(
    (s) => s.status !== "cancelled",
  ).length;

  return {
    awaiting: awaiting.data?.interactions?.length ?? 0,
    running: running.data?.items?.length ?? 0,
    standing,
    done: done.data?.items?.length ?? 0,
    loading:
      running.isLoading ||
      done.isLoading ||
      schedules.isLoading ||
      awaiting.isLoading,
  };
}

/** Current calendar-month window [start, now] in epoch ms (stable `to`). */
function monthWindow(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { from: start.getTime(), to: usageRangeNow() };
}

function useImpactStrip(assistantId: string) {
  const month = monthWindow();
  const impact = useQuery({
    ...homeImpactGetOptions({
      path: { assistant_id: assistantId },
      query: { rangeDays: 7 },
    }),
    staleTime: 60_000,
  });
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
    hoursSaved: impact.data?.hoursSaved ?? 0,
    handled: impact.data?.taskCount ?? 0,
    monthUsd: usage.data?.totalEstimatedCostUsd ?? 0,
    cap: config.data?.monthlyCapUsd ?? null,
    alertPct: config.data?.alertThresholdPct ?? 80,
  };
}

function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Right-aligned impact + spend rail in the header. */
function ImpactRail({ assistantId }: { assistantId: string }) {
  const { hoursSaved, monthUsd, cap, alertPct } = useImpactStrip(assistantId);
  const usd = (v: number) => `$${v.toFixed(2)}`;
  const ratio = cap != null && cap > 0 ? monthUsd / cap : 0;
  const over = ratio >= 1;
  const warn = ratio >= alertPct / 100;
  const spendColor = over ? C.danger : warn ? C.amber : C.t2;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 4,
        flexShrink: 0,
        textAlign: "right",
      }}
    >
      {hoursSaved > 0 ? (
        <Link
          to={routes.impact}
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 5,
            textDecoration: "none",
            color: C.ink,
          }}
        >
          <span
            style={{
              fontFamily: serif,
              fontSize: 22,
              lineHeight: 1,
              letterSpacing: "-0.3px",
            }}
          >
            ≈{hoursSaved}
          </span>
          <span style={{ fontFamily: mono, fontSize: 11, color: C.t2 }}>
            hrs saved
          </span>
        </Link>
      ) : null}
      <Link
        to={routes.settings.budget}
        style={{
          fontFamily: mono,
          fontSize: 11.5,
          color: spendColor,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        {usd(monthUsd)}
        {cap != null ? (
          <span style={{ color: C.t3 }}> / {usd(cap)} cap</span>
        ) : null}
        <span style={{ color: C.t3 }}> · budget →</span>
      </Link>
    </div>
  );
}

/**
 * An editorial group divider — serif headline + mono kicker. Used to break the
 * stream into its four prioritized acts without the 5-column kanban the founder
 * is rejecting. `pinned` adds a subtle accent rail for the highest-value
 * "Needs you" act.
 */
function GroupHeader({
  kicker,
  title,
  hint,
  accent = C.t2,
  pinned = false,
}: {
  kicker: string;
  title: string;
  hint?: string;
  accent?: string;
  pinned?: boolean;
}) {
  return (
    <div
      style={{
        marginBottom: 14,
        paddingLeft: pinned ? 12 : 0,
        borderLeft: pinned ? `3px solid ${accent}` : undefined,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: accent,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontFamily: serif,
          fontSize: 26,
          letterSpacing: "-0.4px",
          lineHeight: 1.1,
          color: C.ink,
          marginTop: 2,
        }}
      >
        {title}
      </div>
      {hint ? (
        <div style={{ fontSize: 12.5, color: C.t3, marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
}

/** A titled card wrapping the inbound triage feed (matches section chrome). */
function InboundCard({
  assistantId,
  validConversationIds,
}: {
  assistantId: string;
  validConversationIds?: Set<string>;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        background: C.surface,
        padding: "14px 16px",
        marginBottom: 22,
      }}
    >
      <InboundLane
        assistantId={assistantId}
        validConversationIds={validConversationIds}
      />
    </div>
  );
}

function GroupBlock({ children }: { children: ReactNode }) {
  return <div style={{ marginBottom: 30 }}>{children}</div>;
}

export function CommandCenterPage({
  validConversationIds,
}: {
  validConversationIds?: Set<string>;
} = {}) {
  const assistantId = useActiveAssistantId();
  // Real-time: drive every group off the SSE stream so rows update the instant
  // the daemon broadcasts, not on the 60s safety-net poll.
  useActivitySync(assistantId, true);
  const tally = useTally(assistantId);
  const stateQuery = useHomeStateQuery(assistantId);

  const userName = stateQuery.data?.userName?.trim();
  const hour = new Date().getHours();
  const greetingWord = greetingFor(hour);
  const greeting = userName ? `${greetingWord}, ${userName}.` : `${greetingWord}.`;

  const statusBits = [
    tally.awaiting > 0 ? `${tally.awaiting} need you` : null,
    `${tally.running} running`,
    `${tally.standing} standing`,
    `${tally.done} done today`,
  ].filter(Boolean) as string[];

  return (
    <div
      data-slot="command-center-page"
      style={{ height: "100%", overflowY: "auto", background: C.bg }}
    >
      {/* Tighten the editorial hero + gutter below the mobile breakpoint so the
          serif greeting and 24px gutter don't overflow the ~390px viewport. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `@media (max-width:640px){[data-slot="command-center-page"] [data-slot="command-center-inner"]{padding:18px 16px !important;}[data-slot="command-center-page"] [data-slot="command-center-greeting"]{font-size:30px !important;}}`,
        }}
      />
      <div
        data-slot="command-center-inner"
        style={{ maxWidth: 880, margin: "0 auto", padding: 24 }}
      >
        {/* HEADER — editorial greeting + one live status line + impact rail. */}
        <header style={{ marginBottom: 28 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginBottom: 6,
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
              Command
            </div>
            <LiveDot />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                data-slot="command-center-greeting"
                style={{
                  fontFamily: serif,
                  fontSize: 40,
                  letterSpacing: "-0.6px",
                  lineHeight: 1.05,
                  color: C.ink,
                }}
              >
                {greeting}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 8,
                  fontFamily: mono,
                  fontSize: 13,
                  color: C.t2,
                  flexWrap: "wrap",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: tally.awaiting > 0 ? C.danger : C.green,
                    flexShrink: 0,
                  }}
                />
                {tally.loading ? (
                  "Taking stock…"
                ) : (
                  <span>{statusBits.join("  ·  ")}</span>
                )}
              </div>
            </div>
            <ImpactRail assistantId={assistantId} />
          </div>
        </header>

        {/* 1 · NEEDS YOU — pinned at top; the highest-value human-in-the-loop
            moment. Empty state is calm + honest (handled by the section). */}
        <GroupBlock>
          <GroupHeader
            kicker="Needs you"
            title={
              tally.awaiting > 0
                ? "A decision is waiting."
                : "Nothing's waiting on you."
            }
            accent={C.danger}
            pinned={tally.awaiting > 0}
          />
          <NeedsYouSection assistantId={assistantId} />
        </GroupBlock>

        {/* 2 · IN MOTION — running work + live subagents, unified. */}
        <GroupBlock>
          <GroupHeader
            kicker="In motion"
            title={tally.running > 0 ? "Cue is on it." : "Cue is standing by."}
            accent={C.blue}
            hint={
              tally.running > 0
                ? "Open a row for the live output, or cancel it."
                : undefined
            }
          />
          <RunningSection assistantId={assistantId} />
        </GroupBlock>

        {/* 3 · UP NEXT — inbound triage + scheduled + watchers + sequences. */}
        <GroupBlock>
          <GroupHeader
            kicker="Up next"
            title="Queued and watching."
            accent={C.violet}
            hint="What came in, what's scheduled, and what Cue is keeping an eye on."
          />
          <InboundCard
            assistantId={assistantId}
            validConversationIds={validConversationIds}
          />
          <ScheduledSection assistantId={assistantId} />
          <WatchingSection assistantId={assistantId} />
          <SequencesSection assistantId={assistantId} />
        </GroupBlock>

        {/* 4 · DONE TODAY — recently completed, with the result inline. */}
        <GroupBlock>
          <GroupHeader
            kicker="Done today"
            title={tally.done > 0 ? "Already handled." : "The day's still young."}
            accent={C.green}
          />
          <RecentlyDoneSection assistantId={assistantId} />
        </GroupBlock>
      </div>
    </div>
  );
}
