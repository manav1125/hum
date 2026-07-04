/**
 * Assistant-state widget — REAL data via `useHomeStateQuery`.
 *
 * Shows the relationship tier + progress bar plus a few facts Cue knows and
 * its currently-unlocked capabilities. All straight from `homeStateGet`.
 */

import { useHomeStateQuery } from "@/domains/home/hooks/use-home-state-query";

import { C, mono } from "../theme";
import { Dot, WidgetFrame } from "./widget-frame";

const TIER_LABEL: Record<number, string> = {
  1: "Getting acquainted",
  2: "Finding its feet",
  3: "Trusted hand",
  4: "Right hand",
};

export function AssistantStateWidget({ assistantId }: { assistantId: string }) {
  const query = useHomeStateQuery(assistantId);
  const data = query.data;

  const facts = (data?.facts ?? []).slice(0, 3);
  const unlocked = (data?.capabilities ?? [])
    .filter((c) => c.tier === "unlocked" || c.tier === "earned")
    .slice(0, 3);

  return (
    <WidgetFrame
      title="Assistant state"
      loading={query.isLoading}
      loadingLabel="Reading the relationship…"
      error={query.isError}
      empty={!query.isLoading && !query.isError && !data}
    >
      {data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>
                Tier {data.tier} · {TIER_LABEL[data.tier] ?? "—"}
              </span>
              <span style={{ fontFamily: mono, fontSize: 12, color: C.t2 }}>
                {data.progressPercent}%
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: C.sunken,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, data.progressPercent))}%`,
                  height: "100%",
                  background: C.blue,
                }}
              />
            </div>
          </div>

          {facts.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {facts.map((fact) => (
                <div
                  key={fact.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    fontSize: 12.5,
                    color: C.t2,
                  }}
                >
                  <span style={{ marginTop: 5 }}>
                    <Dot
                      color={fact.confidence === "strong" ? C.green : C.line2}
                    />
                  </span>
                  <span>{fact.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {unlocked.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {unlocked.map((cap) => (
                <span
                  key={cap.id}
                  style={{
                    fontSize: 11.5,
                    color: C.blueS,
                    background: C.blueW,
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  {cap.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </WidgetFrame>
  );
}
