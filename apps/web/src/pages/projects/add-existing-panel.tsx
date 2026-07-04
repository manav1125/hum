/**
 * "Add existing" picker — file already-captured work items into a project in
 * one selection pass. Lists every open item that isn't already in this project
 * (unfiled ones and ones living in other projects), lets you multi-select, and
 * moves them with a full-record PATCH (the daemon's work-item PATCH replaces
 * fields it receives, so we resend the whole row with the new projectId).
 */

import { useMemo, useState } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

import { useAllWorkItems, usePatchWorkItem } from "./use-projects";

const OPEN_STATUSES = new Set([
  "queued",
  "pending",
  "running",
  "awaiting_review",
]);

type Row = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Rebuild the full PATCH body from a row, overriding projectId. */
function moveBody(row: Row, projectId: string) {
  let labels: string[] = [];
  const rawLabels = row.labels;
  if (typeof rawLabels === "string") {
    try {
      const parsed = JSON.parse(rawLabels) as unknown;
      if (Array.isArray(parsed))
        labels = parsed.filter((l): l is string => typeof l === "string");
    } catch {
      // ignore malformed labels
    }
  } else if (Array.isArray(rawLabels)) {
    labels = rawLabels.filter((l): l is string => typeof l === "string");
  }
  return {
    title: str(row.title) ?? "Untitled",
    notes: str(row.notes) ?? "",
    status: str(row.status) ?? "queued",
    priorityTier: num(row.priorityTier) ?? 2,
    sortIndex: num(row.sortIndex) ?? 0,
    projectId,
    dueAt: num(row.dueAt) ?? null,
    labels,
    assignee: str(row.assignee) ?? "cue",
    context: str(row.context) ?? null,
  };
}

export function AddExistingPanel({
  assistantId,
  projectId,
  onClose,
}: {
  assistantId: string;
  projectId: string;
  onClose: () => void;
}) {
  const { items, isLoading } = useAllWorkItems(assistantId);
  const patch = usePatchWorkItem(assistantId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo(
    () =>
      (items as Row[]).filter((r) => {
        const status = str(r.status) ?? "";
        return OPEN_STATUSES.has(status) && str(r.projectId) !== projectId;
      }),
    [items, projectId],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    const byId = new Map((items as Row[]).map((r) => [str(r.id) ?? "", r]));
    for (const id of selected) {
      const row = byId.get(id);
      if (!row) continue;
      try {
        await patch.mutateAsync({
          path: { assistant_id: assistantId, id },
          body: moveBody(row, projectId),
        });
      } catch {
        // keep going; a single failure shouldn't abandon the rest
      }
    }
    setBusy(false);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(15,20,30,0.42)",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "78vh",
          display: "flex",
          flexDirection: "column",
          background: C.bg,
          border: `1px solid ${C.line2}`,
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 20px 12px" }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: C.t3,
            }}
          >
            Add existing work
          </div>
          <div
            style={{
              fontFamily: serif,
              fontSize: 19,
              color: C.ink,
              marginTop: 3,
            }}
          >
            File items into this project
          </div>
          <div style={{ fontSize: 12.5, color: C.t2, marginTop: 4 }}>
            Cue reads the project brief + knowledge before working any item you
            move here.
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: "0 12px", flex: 1 }}>
          {isLoading ? (
            <div style={{ padding: 20, fontSize: 13, color: C.t2 }}>
              Loading your open work…
            </div>
          ) : candidates.length === 0 ? (
            <div
              style={{
                padding: "20px 8px",
                fontSize: 13,
                color: C.t3,
                lineHeight: 1.5,
              }}
            >
              No other open items to file — everything is either already here or
              already done.
            </div>
          ) : (
            candidates.map((r) => {
              const id = str(r.id) ?? "";
              const on = selected.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggle(id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 8px",
                    border: "none",
                    borderBottom: `1px solid ${C.line}`,
                    background: on
                      ? `color-mix(in srgb, ${C.blue} 8%, ${C.bg})`
                      : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 17,
                      height: 17,
                      borderRadius: 5,
                      flexShrink: 0,
                      border: `1.5px solid ${on ? C.blue : C.line2}`,
                      background: on ? C.blue : "transparent",
                      color: "#fff",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                    }}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 13.5,
                        color: C.ink,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {str(r.title) ?? "Untitled"}
                    </span>
                    <span
                      style={{ fontFamily: mono, fontSize: 10.5, color: C.t3 }}
                    >
                      {(str(r.status) ?? "").replace(/_/g, " ")}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            borderTop: `1px solid ${C.line2}`,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              fontFamily: mono,
              fontSize: 12,
              padding: "8px 12px",
              borderRadius: 9,
              border: "none",
              background: "transparent",
              color: C.t2,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={addSelected}
            disabled={selected.size === 0 || busy}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "9px 16px",
              borderRadius: 9,
              border: "none",
              cursor: selected.size === 0 || busy ? "default" : "pointer",
              background: C.ink,
              color: C.bg,
              opacity: selected.size === 0 || busy ? 0.45 : 1,
            }}
          >
            {busy
              ? "Adding…"
              : selected.size > 0
                ? `Add ${selected.size} to project`
                : "Select items"}
          </button>
        </div>
      </div>
    </div>
  );
}
