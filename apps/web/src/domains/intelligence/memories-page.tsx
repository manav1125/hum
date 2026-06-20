import { useEffect, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";
import { MEMORY_TYPES, type MemoryType } from "@vellumai/design-library";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  memoryitemsByIdDelete,
  memoryitemsByIdPatch,
} from "@/generated/daemon/sdk.gen";
import { memoryitemsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { formatFriendlyDate } from "@/utils/format-date";

import { useMemoryItemsQuery } from "./memories/hooks/use-memory-items-query";
import { MemoryRow, kindColors, kindLabel } from "./memories/memory-row";
import { sourceTypeLabel, type MemoryItem } from "./memories/types";

const MONO = "'DM Mono', monospace";
const SERIF = "'Instrument Serif', serif";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type KindFilter = "all" | MemoryType;

/**
 * The Memory surface — a faithful translation of surfaces/Memory.dc.html
 * (center column + right provenance rail) onto real data.
 *
 * Real memories load via `useMemoryItemsQuery` (`MemoryItem[]` + derived
 * `kindCounts`). Every design element maps to a real field:
 * - header headline / stats: `items.length`, firstSeenAt within 7 days, mean
 *   `confidence`;
 * - type chips: `kindCounts` per memory type, filtering the real list;
 * - cards: `kind`, `confidence`, `statement`, `reinforcementCount`,
 *   `sourceType` — selecting one drives the provenance rail;
 * - rail: the selected memory's confidence bar + reinforcement + sources
 *   (sourceType, scopeLabel, first/last seen).
 *
 * Actions are real: Forget → confirm → `memoryitemsByIdDelete` → refetch;
 * Edit → inline statement editor → `memoryitemsByIdPatch` → refetch. The four
 * states (Ready / Loading / Empty / Error) mirror the mock's switcher.
 *
 * Routed under `<ActiveAssistantGate>`, so `useActiveAssistantId()` is safe.
 */
export function MemoriesPage() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } =
    useMemoryItemsQuery(assistantId);

  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [confidentOnly, setConfidentOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingForget, setPendingForget] = useState<MemoryItem | null>(null);

  const items = useMemo<MemoryItem[]>(() => data?.items ?? [], [data?.items]);
  const total = items.length;
  const kindCounts = useMemo(
    () => data?.kindCounts ?? {},
    [data?.kindCounts],
  );

  // Header stats — derived from the real items (mock: "+24 this week" / "0.81
  // avg conf").
  const addedThisWeek = useMemo(() => {
    const cutoff = Date.now() - WEEK_MS;
    return items.filter(
      (i) => Number.isFinite(i.firstSeenAt) && i.firstSeenAt >= cutoff,
    ).length;
  }, [items]);
  const avgConfidence = useMemo(() => {
    const confs = items
      .map((i) => i.confidence)
      .filter((c): c is number => typeof c === "number");
    if (confs.length === 0) return null;
    return confs.reduce((a, b) => a + b, 0) / confs.length;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (q && !`${item.statement} ${item.subject}`.toLowerCase().includes(q))
        return false;
      if (
        confidentOnly &&
        !(typeof item.confidence === "number" && item.confidence >= 0.6)
      )
        return false;
      return true;
    });
  }, [items, filter, query, confidentOnly]);

  // Default the rail to the first visible memory; reselect when the current
  // selection scrolls out of the filtered set.
  const selected = useMemo(
    () =>
      filteredItems.find((i) => i.id === selectedId) ?? filteredItems[0] ?? null,
    [filteredItems, selectedId],
  );
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const deleteMutation = useMutation({
    mutationFn: async (item: MemoryItem) => {
      if (!assistantId) throw new Error("No active assistant");
      const { error } = await memoryitemsByIdDelete({
        path: { assistant_id: assistantId, id: item.id },
        throwOnError: false,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setPendingForget(null);
      await invalidate();
    },
  });

  const editMutation = useMutation({
    mutationFn: async (vars: { id: string; statement: string }) => {
      if (!assistantId) throw new Error("No active assistant");
      const { error } = await memoryitemsByIdPatch({
        path: { assistant_id: assistantId, id: vars.id },
        body: { statement: vars.statement },
        throwOnError: false,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setEditingId(null);
      await invalidate();
    },
  });

  async function invalidate() {
    if (!assistantId) return;
    await queryClient.invalidateQueries({
      queryKey: memoryitemsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
  }

  function startEdit(item: MemoryItem) {
    setSelectedId(item.id);
    setEditingId(item.id);
    setDraft(item.statement);
  }
  function saveEdit() {
    if (editingId && draft.trim().length > 0) {
      editMutation.mutate({ id: editingId, statement: draft.trim() });
    }
  }
  function clearFilters() {
    setFilter("all");
    setQuery("");
    setConfidentOnly(false);
  }

  const showEmpty = !isLoading && !isError && filteredItems.length === 0;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 280px",
        minHeight: 0,
        flex: 1,
        height: "100%",
        background: "#FFFFFF",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: "#1A2230",
        lineHeight: 1.5,
      }}
    >
      {/* ── CENTER COLUMN ─────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "22px 24px 18px",
            borderBottom: "1px solid #E5E9F0",
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <ApertureAvatar
            state="listening"
            size={42}
            style={{ flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: SERIF,
                fontSize: 24,
                letterSpacing: "-.2px",
                lineHeight: 1.2,
              }}
            >
              Cue remembers{" "}
              <span style={{ fontStyle: "italic", color: "#2B53C4" }}>
                {total.toLocaleString()} things
              </span>{" "}
              about how you work.
            </div>
            <div style={{ fontSize: 12.5, color: "#5A6672", marginTop: 3 }}>
              Across 8 memory types · every one traceable to its source · you
              can edit or forget anything.
            </div>
          </div>
          <div style={{ display: "flex", gap: 18, paddingLeft: 6 }}>
            <div style={{ textAlign: "right" }}>
              <div
                style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.4px" }}
              >
                +{addedThisWeek}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: "#8D99A5" }}>
                this week
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.4px" }}
              >
                {avgConfidence !== null ? avgConfidence.toFixed(2) : "—"}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: "#8D99A5" }}>
                avg conf
              </div>
            </div>
          </div>
        </div>

        {/* Search row */}
        <div
          style={{
            padding: "18px 24px 8px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              flex: 1,
              border: "1px solid #D7DDE7",
              borderRadius: 10,
              padding: "8px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>
              🔍
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${total.toLocaleString()} memories…`}
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 13,
                color: "#1A2230",
                fontFamily: "'DM Sans', system-ui, sans-serif",
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => setConfidentOnly((v) => !v)}
            aria-pressed={confidentOnly}
            title={
              confidentOnly
                ? "Showing only memories with confidence ≥ 0.6 — click to show all"
                : "Filter to memories with confidence ≥ 0.6"
            }
            style={{
              fontSize: 12,
              background: confidentOnly ? "#1A2230" : "#EEF1F6",
              color: confidentOnly ? "#fff" : "#5A6672",
              border: "none",
              borderRadius: 8,
              padding: "7px 12px",
              fontFamily: MONO,
              cursor: "pointer",
            }}
          >
            confidence ≥ 0.6
          </button>
          <button
            type="button"
            onClick={() => void navigate("/assistant/")}
            style={{
              fontSize: 12.5,
              background: "#1A2230",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              cursor: "pointer",
            }}
          >
            ✦ Teach Cue something
          </button>
        </div>

        {/* Type filter chips */}
        <div
          style={{
            padding: "6px 24px 14px",
            display: "flex",
            gap: 7,
            flexWrap: "wrap",
          }}
          role="group"
          aria-label="Filter memories by type"
        >
          <button
            type="button"
            onClick={() => setFilter("all")}
            style={{
              fontSize: 12,
              background: filter === "all" ? "#1A2230" : "#FFFFFF",
              color: filter === "all" ? "#fff" : "#1A2230",
              border: filter === "all" ? "none" : "1px solid #E5E9F0",
              borderRadius: 8,
              padding: "6px 11px",
              cursor: "pointer",
            }}
          >
            All · {total.toLocaleString()}
          </button>
          {MEMORY_TYPES.map((kind) => {
            const c = kindColors(kind);
            const active = filter === kind;
            const count = kindCounts[kind] ?? 0;
            return (
              <button
                key={kind}
                type="button"
                onClick={() => setFilter(active ? "all" : kind)}
                style={{
                  fontSize: 12,
                  background: active ? c.wash : "#FFFFFF",
                  color: active ? c.text : "#1A2230",
                  border: `1px solid ${active ? c.dot : "#E5E9F0"}`,
                  borderRadius: 8,
                  padding: "6px 11px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 3,
                    background: c.dot,
                  }}
                />
                {kindLabel(kind)} {count}
              </button>
            );
          })}
        </div>

        {/* Body — Ready / Loading / Empty / Error */}
        <div style={{ padding: "4px 24px 22px", flex: 1, overflowY: "auto" }}>
          {isLoading ? (
            <LoadingState />
          ) : isError ? (
            <ErrorState onRetry={() => void refetch()} />
          ) : showEmpty ? (
            <EmptyState onClearFilters={clearFilters} />
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              {filteredItems.map((item) => (
                <MemoryRow
                  key={item.id}
                  item={item}
                  selected={selected?.id === item.id}
                  onSelect={(i) => {
                    setSelectedId(i.id);
                    if (editingId && editingId !== i.id) setEditingId(null);
                  }}
                  onEdit={startEdit}
                  onForget={setPendingForget}
                  editing={editingId === item.id}
                  draft={draft}
                  onDraftChange={setDraft}
                  onSaveEdit={saveEdit}
                  onCancelEdit={() => setEditingId(null)}
                  isSaving={
                    editMutation.isPending &&
                    editMutation.variables?.id === item.id
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── PROVENANCE RAIL ───────────────────────────────────────── */}
      <ProvenanceRail
        memory={isError ? null : selected}
        onEdit={startEdit}
        onForget={setPendingForget}
      />

      <ConfirmDialog
        open={pendingForget !== null}
        title="Forget this memory?"
        message={
          pendingForget
            ? `Cue will permanently forget “${pendingForget.statement}”. This can’t be undone.`
            : ""
        }
        confirmLabel={deleteMutation.isPending ? "Forgetting…" : "Forget"}
        cancelLabel="Keep"
        destructive
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (pendingForget) deleteMutation.mutate(pendingForget);
        }}
        onCancel={() => {
          if (!deleteMutation.isPending) setPendingForget(null);
        }}
      />
    </div>
  );
}

/* ── Provenance rail ─────────────────────────────────────────────── */

function ProvenanceRail({
  memory,
  onEdit,
  onForget,
}: {
  memory: MemoryItem | null;
  onEdit: (item: MemoryItem) => void;
  onForget: (item: MemoryItem) => void;
}) {
  return (
    <aside
      style={{
        background: "#F4F6F9",
        borderLeft: "1px solid #E5E9F0",
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minHeight: 0,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: MONO,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "#8D99A5",
        }}
      >
        Selected · provenance
      </div>

      {memory ? (
        <RailContent memory={memory} onEdit={onEdit} onForget={onForget} />
      ) : (
        <div
          style={{
            background: "#FFFFFF",
            border: "1px solid #E5E9F0",
            borderRadius: 13,
            padding: "20px 15px",
            fontSize: 12.5,
            color: "#8D99A5",
            textAlign: "center",
          }}
        >
          Select a memory to see its sources.
        </div>
      )}
    </aside>
  );
}

function RailContent({
  memory,
  onEdit,
  onForget,
}: {
  memory: MemoryItem;
  onEdit: (item: MemoryItem) => void;
  onForget: (item: MemoryItem) => void;
}) {
  const c = kindColors(memory.kind);
  const confPct =
    typeof memory.confidence === "number"
      ? Math.round(memory.confidence * 100)
      : 0;
  const confText =
    typeof memory.confidence === "number"
      ? memory.confidence.toFixed(2)
      : "—";
  const reinforcement = memory.reinforcementCount ?? 0;
  const source = sourceTypeLabel(memory.sourceType);
  const firstSeen = Number.isFinite(memory.firstSeenAt)
    ? formatFriendlyDate(new Date(memory.firstSeenAt))
    : null;
  const lastSeen = Number.isFinite(memory.lastSeenAt)
    ? formatFriendlyDate(new Date(memory.lastSeenAt))
    : null;

  return (
    <>
      {/* Selected memory card */}
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #E5E9F0",
          borderRadius: 13,
          padding: "14px 15px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span
            style={{ width: 9, height: 9, borderRadius: 3, background: c.dot }}
          />
          <span style={{ fontFamily: MONO, fontSize: 10, color: c.text }}>
            {kindLabel(memory.kind).toUpperCase()}
          </span>
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>
          {memory.statement}
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            fontFamily: MONO,
            color: "#8D99A5",
          }}
        >
          Confidence
        </div>
        <div
          style={{
            height: 7,
            borderRadius: 4,
            background: "#EEF1F6",
            marginTop: 5,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${confPct}%`,
              height: "100%",
              background: "#3D6EE8",
              borderRadius: 4,
            }}
          />
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO,
            color: "#5A6672",
            marginTop: 4,
          }}
        >
          {confText} · reinforced {reinforcement}×
        </div>
      </div>

      {/* Sources card */}
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #E5E9F0",
          borderRadius: 13,
          padding: "14px 15px",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO,
            color: "#8D99A5",
            marginBottom: 8,
          }}
        >
          SOURCES
        </div>
        <div style={{ fontSize: 12.5, color: "#5A6672", lineHeight: 1.7 }}>
          {source ? <div>· {source}</div> : null}
          {memory.scopeLabel ? <div>· {memory.scopeLabel}</div> : null}
          {firstSeen ? <div>· first seen {firstSeen}</div> : null}
          {lastSeen ? <div>· last seen {lastSeen}</div> : null}
          {reinforcement > 0 ? (
            <div>· reinforced {reinforcement}×</div>
          ) : null}
          {!source &&
          !memory.scopeLabel &&
          !firstSeen &&
          !lastSeen &&
          reinforcement === 0 ? (
            <div>No source signals recorded.</div>
          ) : null}
        </div>
      </div>

      {/* Rail actions */}
      <div style={{ marginTop: "auto", display: "flex", gap: 7 }}>
        <button
          type="button"
          onClick={() => onEdit(memory)}
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: 12.5,
            border: "1px solid #D7DDE7",
            background: "#fff",
            color: "#1A2230",
            borderRadius: 8,
            padding: 8,
            cursor: "pointer",
          }}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => onForget(memory)}
          style={{
            flex: 1,
            textAlign: "center",
            fontSize: 12.5,
            background: "#FCEBEB",
            color: "#DA491A",
            border: "1px solid #F0B9AC",
            borderRadius: 8,
            padding: 8,
            cursor: "pointer",
          }}
        >
          Forget
        </button>
      </div>
    </>
  );
}

/* ── States ──────────────────────────────────────────────────────── */

function LoadingState() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
      aria-hidden
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 78,
            borderRadius: 13,
            background:
              "linear-gradient(90deg,#EEF1F6 0%,#E2E7EF 50%,#EEF1F6 100%)",
            backgroundSize: "340px 100%",
            animation: "cueShimmer 1.3s linear infinite",
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 15,
        padding: "60px 20px",
        minHeight: 360,
      }}
    >
      <ApertureAvatar state="idle" size={60} />
      <div style={{ fontSize: 17, fontWeight: 500 }}>
        No memories match this filter
      </div>
      <p style={{ fontSize: 13.5, color: "#5A6672", maxWidth: 360 }}>
        Cue forms memories as you work — from chats, email, meetings, and the
        things you tell it to remember.
      </p>
      <button
        type="button"
        onClick={onClearFilters}
        style={{
          fontSize: 12.5,
          background: "#3D6EE8",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "8px 14px",
          cursor: "pointer",
        }}
      >
        Clear filters
      </button>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        background: "#FCEBEB",
        border: "1px solid #F0B9AC",
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#DA491A",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        !
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "#8A2E12" }}>
          Couldn&rsquo;t load your memories
        </div>
        <div style={{ fontSize: 12.5, color: "#A8492B", marginTop: 2 }}>
          The memory store didn&rsquo;t respond. Cue is running on cached recall
          only — retry to load them again.
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          fontSize: 12,
          background: "#DA491A",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "6px 12px",
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}
