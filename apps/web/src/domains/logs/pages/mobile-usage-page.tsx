/**
 * Mv3UsagePage — the phone-native Usage & spend screen (round-4 frame 61):
 * segmented period pills, LLM CALLS / SPEND stat tiles + a full-width TOKENS
 * tile with the in/out split, the full-bleed per-day spend chart (peak
 * highlighted + narrated caption), and tinted per-actor spend bars.
 *
 * DATA (all real, same endpoints as the desktop Usage tab):
 *  · tiles  — usage/totals (eventCount / totalEstimatedCostUsd / token split)
 *  · chart  — usage/daily buckets (hourly for Today, daily otherwise), tz'd
 *  · bars   — usage/breakdown?groupBy=agent (real roster-agent attribution,
 *             stamped by the daemon at usage-record time; unattributed house
 *             work reads as "Cue"). Old daemons without the dimension 400 —
 *             the section falls back to groupBy=actor with its original
 *             BY ACTOR title + footnote.
 *
 * The frame's chart bug (percentage-height bars inside auto-height flex
 * columns rendered 0-tall) is built CORRECTLY here: the bar rail has a fixed
 * height, columns are `height:100%; justify-content:flex-end`, and bar
 * heights come from `buildSpendBars` (% of peak with a 6% floor for nonzero
 * buckets; a TRUE-$0 bucket renders a 2px mono hairline tick, never the
 * floor — round-4.1).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { formatCost } from "@/domains/logs/format";
import {
  fetchUsageBreakdown,
  fetchUsageDaily,
  fetchUsageTotals,
} from "@/domains/logs/usage-api";
import {
  buildSpendBars,
  buildSpendGroupRows,
  formatTokensCompact,
  isGroupByUnsupported,
  spendCaption,
  type SpendBar,
} from "@/domains/logs/usage-mobile-format";
import {
  resolveRangeWindow,
  resolveUsageGranularity,
} from "@/domains/logs/usage-tab-state";
import type { UsageTimeRange } from "@/domains/logs/usage-types";
import { GlassCard } from "@/mobile-v3/glass-card";
import { microLabel, rise } from "@/mobile-v3/mv3-kit";
import { YouScreen } from "@/mobile-v3/you/you-kit";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

const PERIODS: { value: UsageTimeRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

/** Actor bar tints, cycled (frame 61's teal/violet/blue trio first). */
const ACTOR_TINTS = ["#4FC7C7", "#7F77DD", "#3D6EE8", "#E0A64B", "#6FD69A"];

export function Mv3UsagePage() {
  const assistantId = useActiveAssistantId();
  const timezone = useEffectiveTimezone();
  const [range, setRange] = useState<UsageTimeRange>("7d");
  // A user-tapped chart bar; null = narrate the peak.
  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);

  const window_ = useMemo(
    () => resolveRangeWindow(range, timezone),
    [range, timezone],
  );
  const granularity = resolveUsageGranularity(range);

  const totalsQuery = useQuery({
    queryKey: ["usage-totals", assistantId, window_.from, window_.to, null],
    queryFn: () =>
      fetchUsageTotals(assistantId, { from: window_.from, to: window_.to }),
  });

  const dailyQuery = useQuery({
    queryKey: [
      "usage-daily",
      assistantId,
      window_.from,
      window_.to,
      granularity,
      timezone,
      null,
    ],
    queryFn: () =>
      fetchUsageDaily(assistantId, {
        from: window_.from,
        to: window_.to,
        granularity,
        tz: timezone,
      }),
  });

  const agentQuery = useQuery({
    queryKey: [
      "usage-breakdown",
      assistantId,
      window_.from,
      window_.to,
      "agent",
      null,
    ],
    queryFn: () =>
      fetchUsageBreakdown(assistantId, {
        from: window_.from,
        to: window_.to,
        groupBy: "agent",
      }),
    // An old daemon rejects the dimension outright — retrying won't help.
    retry: (failureCount, error) =>
      !isGroupByUnsupported(error) && failureCount < 2,
  });
  // Old-daemon fallback: only fires when groupBy=agent came back 400.
  const agentUnsupported =
    agentQuery.isError && isGroupByUnsupported(agentQuery.error);
  const actorQuery = useQuery({
    queryKey: [
      "usage-breakdown",
      assistantId,
      window_.from,
      window_.to,
      "actor",
      null,
    ],
    queryFn: () =>
      fetchUsageBreakdown(assistantId, {
        from: window_.from,
        to: window_.to,
        groupBy: "actor",
      }),
    enabled: agentUnsupported,
  });
  const groupMode = agentUnsupported ? ("actor" as const) : ("agent" as const);
  const groupQuery = agentUnsupported ? actorQuery : agentQuery;

  const totals = totalsQuery.data;
  const bars = useMemo(
    () => buildSpendBars(dailyQuery.data?.buckets ?? [], granularity),
    [dailyQuery.data, granularity],
  );
  const narrated =
    (selectedBarId ? bars.find((b) => b.bucketId === selectedBarId) : null) ??
    bars.find((b) => b.isPeak) ??
    null;

  const actors = useMemo(
    () =>
      buildSpendGroupRows(groupQuery.data?.breakdown ?? [], groupMode).map(
        (row, i) => ({ ...row, tint: ACTOR_TINTS[i % ACTOR_TINTS.length] }),
      ),
    [groupQuery.data, groupMode],
  );

  const anyError =
    totalsQuery.isError && dailyQuery.isError && groupQuery.isError;

  const pickRange = (next: UsageTimeRange) => {
    if (next === range) return;
    haptic.light();
    setRange(next);
    setSelectedBarId(null);
  };

  return (
    <YouScreen
      tint="blue"
      testId="mv3-usage"
      back={routes.channels}
      backLabel="You"
      title="Usage & spend"
    >
      {/* Segmented period pills (frame 61 grammar — full-width track). */}
      <div
        role="radiogroup"
        aria-label="Usage period"
        style={{
          display: "flex",
          gap: 4,
          background: "var(--mv3-track)",
          borderRadius: 12,
          padding: 4,
          ...rise(0.08),
        }}
      >
        {PERIODS.map(({ value, label }) => {
          const active = value === range;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pickRange(value)}
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 12.5,
                fontWeight: active ? 600 : 400,
                fontFamily: "inherit",
                color: active ? "#fff" : "var(--mv3-muted)",
                background: active
                  ? "linear-gradient(160deg, #4E7CEC, #3560CC)"
                  : "transparent",
                border: "none",
                borderRadius: 9,
                padding: "9px 0",
                minHeight: 36,
                cursor: "pointer",
                boxShadow: active
                  ? "0 8px 18px -8px rgba(61,110,232,.6)"
                  : "none",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {anyError ? (
        <GlassCard padding="15px 16px" style={rise(0.14)}>
          <div style={{ fontSize: 13, color: "var(--mv3-muted)" }}>
            Couldn't load usage.
          </div>
          <button
            type="button"
            onClick={() => {
              void totalsQuery.refetch();
              void dailyQuery.refetch();
              void groupQuery.refetch();
            }}
            style={{
              marginTop: 8,
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--mv3-accent)",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Retry
          </button>
        </GlassCard>
      ) : (
        <>
          {/* Stat tiles: 2-col + full-width TOKENS w/ in/out split. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 9,
              ...rise(0.14),
            }}
          >
            {/* "RUNS" in the mock — the usage store counts LLM calls, so the
                tile says what the number actually is. */}
            <StatTile
              label="LLM calls"
              value={totals ? String(totals.eventCount) : "—"}
            />
            <StatTile
              label="Spend"
              value={totals ? formatCost(totals.totalEstimatedCostUsd) : "—"}
            />
            <div style={{ gridColumn: "1 / -1" }}>
              <GlassCard padding="13px 15px" radius={18}>
                <div style={{ ...microLabel, color: "var(--mv3-muted)" }}>
                  Tokens
                </div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    marginTop: 5,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {totals
                    ? formatTokensCompact(
                        totals.totalInputTokens + totals.totalOutputTokens,
                      )
                    : "—"}{" "}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 400,
                      color: "var(--mv3-muted)",
                    }}
                  >
                    {totals
                      ? `· in ${formatTokensCompact(totals.totalInputTokens)} / out ${formatTokensCompact(totals.totalOutputTokens)}`
                      : ""}
                  </span>
                </div>
              </GlassCard>
            </div>
          </div>

          {/* Full-bleed per-day spend chart. */}
          <div
            style={{
              margin: "2px -16px 0",
              padding: "14px 16px 10px",
              background:
                "color-mix(in srgb, var(--mv3-glass) 60%, transparent)",
              borderTop: "1px solid var(--mv3-line)",
              borderBottom: "1px solid var(--mv3-line)",
              ...rise(0.22),
            }}
          >
            <div
              style={{
                ...microLabel,
                color: "var(--mv3-muted)",
                marginBottom: 10,
              }}
            >
              {granularity === "hourly" ? "Spend per hour" : "Spend per day"}
            </div>
            {bars.length === 0 ? (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--mv3-faint)",
                  padding: "22px 0",
                  textAlign: "center",
                }}
              >
                {dailyQuery.isLoading
                  ? "Loading…"
                  : "No usage in this period"}
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "stretch",
                    gap: bars.length > 12 ? 2 : 6,
                    // Fixed rail height — the columns fill it and bars grow
                    // up from the baseline (the mock's bug, fixed).
                    height: 104,
                  }}
                >
                  {bars.map((bar) => (
                    <SpendBarColumn
                      key={bar.bucketId}
                      bar={bar}
                      dense={bars.length > 12}
                      selected={
                        selectedBarId
                          ? selectedBarId === bar.bucketId
                          : bar.isPeak
                      }
                      onPress={() => {
                        haptic.light();
                        setSelectedBarId(
                          selectedBarId === bar.bucketId
                            ? null
                            : bar.bucketId,
                        );
                      }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-faint)",
                    marginTop: 7,
                  }}
                >
                  {narrated
                    ? `${spendCaption(narrated, granularity)}${
                        selectedBarId
                          ? ""
                          : ` · tap a bar for that ${granularity === "hourly" ? "hour" : "day"}`
                      }`
                    : "No spend recorded in this period"}
                </div>
              </>
            )}
          </div>

          {/* Per-agent tinted spend bars (BY ACTOR on pre-308 daemons). */}
          <div style={rise(0.3)}>
            <div
              style={{
                ...microLabel,
                color: "var(--mv3-faint)",
                padding: "6px 4px 8px",
              }}
            >
              {groupMode === "agent" ? "By agent" : "By actor"}
            </div>
            {actors.length === 0 ? (
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--mv3-faint)",
                  padding: "2px 4px",
                }}
              >
                {groupQuery.isLoading
                  ? "Loading…"
                  : "No attributed spend in this period"}
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 7 }}
              >
                {actors.map((actor) => (
                  <div
                    key={actor.key}
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 6,
                        background: actor.tint,
                        color: "rgba(8,12,20,.85)",
                        fontSize: 9.5,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {actor.label.charAt(0)}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        width: 92,
                        flexShrink: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {actor.label}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        height: 7,
                        borderRadius: 99,
                        background:
                          "color-mix(in srgb, var(--mv3-text) 7%, transparent)",
                        overflow: "hidden",
                      }}
                    >
                      <span
                        style={{
                          display: "block",
                          height: "100%",
                          width: `${actor.widthPct}%`,
                          background: actor.tint,
                          borderRadius: 99,
                        }}
                      />
                    </span>
                    <span
                      style={{
                        fontSize: 11.5,
                        color: "var(--mv3-muted)",
                        fontVariantNumeric: "tabular-nums",
                        flexShrink: 0,
                      }}
                    >
                      {formatCost(actor.costUsd)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {actors.length > 0 && groupMode === "actor" ? (
              // Only on old daemons that predate per-agent attribution.
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-faint)",
                  marginTop: 9,
                  padding: "0 4px",
                  lineHeight: 1.5,
                }}
              >
                Actors are Cue's internal subsystems — per-agent spend
                attribution isn't recorded yet.
              </div>
            ) : null}
          </div>
        </>
      )}
    </YouScreen>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <GlassCard padding="13px 15px" radius={18}>
      <div style={{ ...microLabel, color: "var(--mv3-muted)" }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          marginTop: 5,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </GlassCard>
  );
}

/**
 * One chart column. THE frame-61 fix: the column is a full-height flex
 * column with `justify-content: flex-end`, so the %-height bar inside it
 * resolves against a real height and grows up from the baseline.
 */
function SpendBarColumn({
  bar,
  dense,
  selected,
  onPress,
}: {
  bar: SpendBar;
  dense: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`${bar.label}: ${formatCost(bar.costUsd)}, ${bar.eventCount} calls`}
      aria-pressed={selected}
      style={{
        flex: 1,
        minWidth: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 5,
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <span
        aria-hidden
        style={
          bar.zeroTick
            ? {
                // Round-4.1 frame 61: a TRUE-$0 bucket is a 2px mono
                // hairline tick, never the 6% floor — zero must not look
                // like spend.
                width: "100%",
                height: 2,
                background:
                  "color-mix(in srgb, var(--mv3-faint) 35%, transparent)",
                borderRadius: 2,
                outline: selected
                  ? "1.5px solid var(--mv3-accent)"
                  : "none",
                outlineOffset: 1,
              }
            : {
                width: "100%",
                height: `${bar.heightPct}%`,
                minHeight: 3,
                background: bar.isPeak
                  ? "linear-gradient(#7FA3F2, #3D6EE8)"
                  : "color-mix(in srgb, var(--mv3-accent) 40%, transparent)",
                borderRadius: "5px 5px 2px 2px",
                boxShadow: bar.isPeak
                  ? "0 0 14px rgba(61,110,232,.4)"
                  : "none",
                outline:
                  selected && !bar.isPeak
                    ? "1.5px solid var(--mv3-accent)"
                    : "none",
                outlineOffset: 1,
              }
        }
      />
      <span
        style={{
          fontSize: dense ? 8 : 9,
          color: bar.isPeak ? "var(--mv3-text)" : "var(--mv3-faint)",
          fontWeight: bar.isPeak ? 600 : 400,
          height: 12,
          lineHeight: "12px",
          whiteSpace: "nowrap",
        }}
      >
        {bar.showLabel ? bar.label : ""}
      </span>
    </button>
  );
}
