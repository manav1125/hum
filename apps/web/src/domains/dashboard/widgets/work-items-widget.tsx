/**
 * Work-items widget — REAL endpoint (`workitemsGetOptions`), untyped payload.
 *
 * The generated GET response types `items` as `unknown[]`, so we narrow each
 * row defensively (mirroring use-memory-items-query's narrowing) into a small
 * `{ id, title, status }` view model and drop anything that doesn't carry at
 * least an id. Complete (`workitemsByIdCompletePost`) and Cancel
 * (`workitemsByIdCancelPost`) are offered only when a usable id is present; if
 * nothing renders safely we fall back to an honest count + "open in chat".
 */

import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  workitemsByIdCancelPostMutation,
  workitemsByIdCompletePostMutation,
  workitemsGetOptions,
  workitemsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { C, mono } from "../theme";
import { Dot, WidgetFrame } from "./widget-frame";

const MAX_ROWS = 5;

interface WorkItemView {
  id: string;
  title: string;
  status: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Defensively narrow one opaque payload row into the view model. */
function narrowWorkItem(raw: unknown): WorkItemView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = str(rec.id) ?? str(rec.workItemId) ?? str(rec.uuid);
  if (!id) return null;
  const title =
    str(rec.title) ?? str(rec.name) ?? str(rec.summary) ?? "Untitled work item";
  const status = str(rec.status) ?? "open";
  return { id, title, status };
}

function statusColor(status: string): string {
  if (status === "running") return C.blue;
  if (status === "failed") return C.danger;
  if (status === "awaiting_review") return C.amber;
  return C.t3;
}

export function WorkItemsWidget({ assistantId }: { assistantId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pendingKey = workitemsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { status: "pending" },
  });
  const runningKey = workitemsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { status: "running" },
  });

  const pendingQuery = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "pending" },
    }),
    staleTime: 30_000,
  });
  const runningQuery = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "running" },
    }),
    staleTime: 30_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: pendingKey });
    void queryClient.invalidateQueries({ queryKey: runningKey });
  };

  const complete = useMutation({
    ...workitemsByIdCompletePostMutation(),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    ...workitemsByIdCancelPostMutation(),
    onSuccess: invalidate,
  });

  const { items, rawCount } = useMemo(() => {
    const raw = [
      ...(runningQuery.data?.items ?? []),
      ...(pendingQuery.data?.items ?? []),
    ];
    const narrowed: WorkItemView[] = [];
    for (const row of raw) {
      const v = narrowWorkItem(row);
      if (v) narrowed.push(v);
    }
    return { items: narrowed.slice(0, MAX_ROWS), rawCount: raw.length };
  }, [pendingQuery.data?.items, runningQuery.data?.items]);

  const isLoading = pendingQuery.isLoading || runningQuery.isLoading;
  const isError = pendingQuery.isError || runningQuery.isError;
  const mutating = complete.isPending || cancel.isPending;

  // Honest fallback: the daemon returned rows but none narrowed to a safe
  // shape — show a count + an escape hatch rather than fabricating rows.
  const opaque = rawCount > 0 && items.length === 0;

  return (
    <WidgetFrame
      title="Work items"
      loading={isLoading}
      loadingLabel="Loading work items…"
      error={isError}
      empty={!isLoading && !isError && rawCount === 0}
      emptyLabel="No open work items — Cue runs background tasks here."
    >
      {opaque ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, color: C.t1 }}>
            {rawCount} open {rawCount === 1 ? "item" : "items"} running in the
            background.
          </div>
          <button
            type="button"
            onClick={() => navigate("/assistant")}
            style={secondary}
          >
            Open in chat
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 0",
                borderBottom: `1px solid ${C.line}`,
              }}
            >
              <Dot color={statusColor(item.status)} />
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
                  {item.title}
                </div>
                <div style={{ fontSize: 11, color: C.t3, fontFamily: mono }}>
                  {item.status}
                </div>
              </div>
              <button
                type="button"
                disabled={mutating}
                onClick={() =>
                  complete.mutate({
                    path: { assistant_id: assistantId, id: item.id },
                  })
                }
                style={secondary}
              >
                Complete
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() =>
                  cancel.mutate({
                    path: { assistant_id: assistantId, id: item.id },
                  })
                }
                style={ghost}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </WidgetFrame>
  );
}

const secondary = {
  fontSize: 12,
  fontWeight: 500,
  border: `1px solid ${C.line2}`,
  background: C.surface,
  color: C.t1,
  borderRadius: 8,
  padding: "4px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

const ghost = {
  fontSize: 12,
  fontWeight: 500,
  border: "1px solid transparent",
  background: "transparent",
  color: C.t2,
  borderRadius: 8,
  padding: "4px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;
