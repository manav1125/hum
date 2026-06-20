/**
 * Impact-stats widget — REAL data via `homeImpactGetOptions`.
 *
 * Renders Cue's measured impact: hours saved, task count, and a couple of
 * top categories. Real numbers only — straight from the daemon's impact
 * endpoint, no fabrication.
 */

import { useQuery } from "@tanstack/react-query";

import { homeImpactGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "../theme";
import { WidgetFrame } from "./widget-frame";

export function ImpactStatsWidget({ assistantId }: { assistantId: string }) {
  const query = useQuery({
    ...homeImpactGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 60_000,
  });

  const data = query.data;
  const topCategories = (data?.byCategory ?? [])
    .slice()
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 2);

  return (
    <WidgetFrame
      title="Impact"
      loading={query.isLoading}
      loadingLabel="Tallying your time back…"
      error={query.isError}
      empty={!query.isLoading && !query.isError && !data}
    >
      {data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 24 }}>
            <Stat value={String(data.hoursSaved)} label="hours saved" />
            <Stat value={String(data.taskCount)} label="tasks handled" />
          </div>
          {topCategories.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topCategories.map((cat) => (
                <div
                  key={cat.category}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12.5,
                    color: C.t2,
                  }}
                >
                  <span style={{ textTransform: "capitalize" }}>
                    {cat.category}
                  </span>
                  <span style={{ fontFamily: mono, color: C.t1 }}>
                    {cat.count} · {cat.hours}h
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: 11, color: C.t3 }}>
            Last {data.rangeDays} days
          </div>
        </div>
      ) : null}
    </WidgetFrame>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 34,
          fontWeight: 600,
          letterSpacing: "-1px",
          lineHeight: 1,
          color: C.ink,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: C.t2, marginTop: 4 }}>{label}</div>
    </div>
  );
}
