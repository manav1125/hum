/**
 * Recent-memory widget — REAL data via `useMemoryItemsQuery`.
 *
 * Shows the ~5 most recently seen memory items (statement + a type dot). The
 * query hook already narrows the daemon's `unknown[]` payload to `MemoryItem`;
 * here we just sort by `lastSeenAt` and slice.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";

import { useMemoryItemsQuery } from "@/domains/intelligence/memories/hooks/use-memory-items-query";

import { C } from "../theme";
import { Dot, WidgetFrame } from "./widget-frame";

const MAX_ROWS = 5;

/** Memory kind → dot color (stable, calm hues). */
function kindColor(kind: string): string {
  switch (kind) {
    case "semantic":
      return C.blue;
    case "episodic":
      return C.violet;
    case "emotional":
      return C.danger;
    case "procedural":
      return C.green;
    case "prospective":
      return C.amber;
    default:
      return C.t3;
  }
}

export function RecentMemoryWidget({ assistantId }: { assistantId: string }) {
  const query = useMemoryItemsQuery(assistantId);
  const navigate = useNavigate();

  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    return [...all]
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
      .slice(0, MAX_ROWS);
  }, [query.data?.items]);

  return (
    <WidgetFrame
      title="Recent memory"
      action={
        <button
          type="button"
          onClick={() => navigate("/assistant/intelligence")}
          style={{
            fontSize: 12,
            fontWeight: 500,
            border: "1px solid transparent",
            background: "transparent",
            color: C.t2,
            borderRadius: 8,
            padding: "4px 8px",
            cursor: "pointer",
          }}
        >
          See all
        </button>
      }
      loading={query.isLoading}
      loadingLabel="Loading memory…"
      error={query.isError}
      empty={!query.isLoading && !query.isError && items.length === 0}
      emptyLabel="Cue hasn’t formed memories yet — they appear as you talk."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((item) => (
          <div
            key={item.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "9px 0",
              borderBottom: `1px solid ${C.line}`,
            }}
          >
            <span style={{ marginTop: 5 }}>
              <Dot color={kindColor(item.kind)} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.35 }}>
                {item.statement}
              </div>
              <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>
                {item.kind}
              </div>
            </div>
          </div>
        ))}
      </div>
    </WidgetFrame>
  );
}
