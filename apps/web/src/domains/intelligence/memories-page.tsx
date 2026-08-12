import { useCallback, useEffect, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { ApertureAvatar } from "@vellumai/design-library/components/aperture-avatar";
import {
  MEMORY_TYPES,
  SegmentControl,
  type MemoryType,
  type SegmentControlItem,
} from "@vellumai/design-library";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useIsMobile, useMobileLayout } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { usePendingDeepLinkStore } from "@/stores/pending-deep-link-store";
import {
  memoryitemsByIdDelete,
  memoryitemsByIdPatch,
} from "@/generated/daemon/sdk.gen";
import { memoryitemsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { formatFriendlyDate } from "@/utils/format-date";

import { Mv3MemoryV24Page } from "@/mobile-v3/memory/mv3-memory-page-v24";

import { MemoryImportCard } from "@/components/memory-import/memory-import-card";

import { ConceptGraphView } from "./components/concept-graph/concept-graph-view";
import { useMemoryItemsQuery } from "./memories/hooks/use-memory-items-query";
import {
  MEMORY_KIND_SCOPE,
  MemoryKindStyles,
  MemoryRow,
  kindColors,
  kindLabel,
} from "./memories/memory-row";
import { sourceTypeLabel, type MemoryItem } from "./memories/types";

const MONO = "'DM Mono', monospace";
const SERIF = "'Instrument Serif', serif";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Generates a fresh draft conversation id. Mirrors
 * `domains/chat/utils/conversation-selection.createDraftConversationId`
 * (a plain UUID) — inlined here so the Intelligence domain stays free of a
 * cross-domain import into chat (see CONVENTIONS.md).
 */
function newDraftConversationId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type KindFilter = "all" | MemoryType;

/**
 * The two Memory views: the classic provenance list (memory ITEMS from the
 * graph DB) and the concept Map (the memory-v2 concept-page graph served by
 * `GET /memory-graph`). They read DIFFERENT data models, so the map is a
 * sibling view beside the list — never a replacement for it.
 */
type MemoriesView = "list" | "map";

const VIEW_ITEMS: SegmentControlItem<MemoriesView>[] = [
  { value: "list", label: "List" },
  { value: "map", label: "Map" },
];

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
  // MOBILE — the mobile-v3 Memory screen. Now design's v24 **F6** (your rules
  // first, quoted, then what Cue inferred this week with evidence), which
  // supersedes the earlier frame-10 screen at `mobile-v3/you/memory-page`.
  //
  // It is swapped HERE rather than added at a second URL: Memory already had
  // one route, and this codebase has twice had to clean up two pages with the
  // same name at two URLs (see `routes.memoryPeople`).
  //
  // Branch in a thin wrapper so the desktop body's hooks never change count
  // across a breakpoint flip. Desktop keeps the center-column +
  // provenance-rail layout untouched.
  const isMobile = useMobileLayout();
  if (isMobile) {
    return <Mv3MemoryV24Page />;
  }
  return <MemoriesPageDesktop />;
}

function MemoriesPageDesktop() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [confidentOnly, setConfidentOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingForget, setPendingForget] = useState<MemoryItem | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [view, setView] = useState<MemoriesView>("list");

  // Filter server-side: a kind chip must see ALL memories of that kind, not
  // just whichever landed on the first page (154 procedural skill-notices
  // otherwise crowd out every other kind).
  const { data, isLoading, isError, refetch } = useMemoryItemsQuery(
    assistantId,
    filter === "all" ? null : filter,
  );

  const items = useMemo<MemoryItem[]>(() => data?.items ?? [], [data?.items]);
  const kindCounts = useMemo(() => data?.kindCounts ?? {}, [data?.kindCounts]);
  // Headline + "All" chip + placeholder = the GLOBAL total, stable across kind
  // filters. `kindCounts` is computed server-side over all rows (never narrowed
  // by the active kind), so its sum stays 428 when a chip is selected; it does
  // narrow under search, which is the correct behaviour there. Falls back to
  // the response total / loaded page only for older daemons without kindCounts.
  const total = useMemo(() => {
    const sum = Object.values(kindCounts).reduce((a, b) => a + b, 0);
    return sum > 0 ? sum : (data?.total ?? items.length);
  }, [kindCounts, data?.total, items.length]);

  // Header stats — derived from the real items (mock: "+24 this week" / "0.81
  // avg conf").
  // Capture "now" once at mount so the render stays pure (Date.now() is impure).
  const [weekCutoff] = useState(() => Date.now() - WEEK_MS);
  const addedThisWeek = useMemo(() => {
    return items.filter(
      (i) => Number.isFinite(i.firstSeenAt) && i.firstSeenAt >= weekCutoff,
    ).length;
  }, [items, weekCutoff]);
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
      filteredItems.find((i) => i.id === selectedId) ??
      filteredItems[0] ??
      null,
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

  // "Teach Cue something" — open a FRESH conversation focused on teaching a
  // memory, never resuming the user's last (possibly stale) thread. We mint a
  // brand-new draft conversation (mirroring the Create surface's thread-seeding
  // path — a plain UUID, inlined so this domain stays free of a cross-domain
  // import into chat; see CONVENTIONS.md) and park a gentle teaching prompt in
  // the shared pending-deep-link store. `useDeepLinkConsumer` applies that
  // prompt to the empty composer on mount — a prefill, NOT an auto-send, so the
  // user completes the sentence ("Remember that …").
  const onTeachCue = useCallback(() => {
    usePendingDeepLinkStore
      .getState()
      .setPendingComposerMessage("Remember that ");
    useViewerStore.getState().setMainView("chat");
    const draftId = newDraftConversationId();
    useConversationStore.getState().setActiveConversationId(draftId);
    void navigate(routes.conversation(draftId));
  }, [navigate]);

  // Chat-from-node on the concept map: same fresh-draft seeding path as
  // "Teach Cue", but prefilled with the node's message (e.g. "Tell me what
  // you know about X"). A prefill, NOT an auto-send.
  const onOpenThreadFromNode = useCallback(
    (message: string) => {
      usePendingDeepLinkStore.getState().setPendingComposerMessage(message);
      useViewerStore.getState().setMainView("chat");
      const draftId = newDraftConversationId();
      useConversationStore.getState().setActiveConversationId(draftId);
      void navigate(routes.conversation(draftId));
    },
    [navigate],
  );

  const showEmpty = !isLoading && !isError && filteredItems.length === 0;

  return (
    // Desktop: center column + fixed 280px provenance rail. Mobile: a single
    // stacked column — the list first, the provenance detail as a full-width
    // section pinned beneath it (never overlapping absolute columns).
    <div
      className={MEMORY_KIND_SCOPE}
      style={{
        display: "grid",
        gridTemplateColumns:
          isMobile || view === "map"
            ? "minmax(0, 1fr)"
            : "minmax(0, 1fr) 280px",
        gridTemplateRows: isMobile ? "minmax(0, 1fr) auto" : undefined,
        minHeight: 0,
        flex: 1,
        height: "100%",
        background: "var(--surface-overlay)",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: "var(--content-default)",
        lineHeight: 1.5,
      }}
    >
      <MemoryKindStyles />
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
            borderBottom: "1px solid var(--border-base)",
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
              <span
                style={{
                  fontStyle: "italic",
                  color: "var(--accent-cue-strong)",
                }}
              >
                {total.toLocaleString()} things
              </span>{" "}
              about how you work.
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--content-secondary)",
                marginTop: 3,
              }}
            >
              Across 8 memory types · every one traceable to its source · you
              can edit or forget anything.
            </div>
          </div>
          {/* List ⇄ Map view toggle. Two different data models behind one
              surface: the list reads memory items, the map reads the concept
              graph — so this switches views, it never filters one of them. */}
          <SegmentControl<MemoriesView>
            ariaLabel="Memory view"
            items={VIEW_ITEMS}
            value={view}
            onChange={setView}
            className="!w-auto [&>*]:!flex-none"
          />
          <div style={{ display: "flex", gap: 18, paddingLeft: 6 }}>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontSize: 19,
                  fontWeight: 600,
                  letterSpacing: "-.4px",
                }}
              >
                +{addedThisWeek}
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: "var(--content-tertiary)",
                }}
              >
                this week
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontSize: 19,
                  fontWeight: 600,
                  letterSpacing: "-.4px",
                }}
              >
                {avgConfidence !== null ? avgConfidence.toFixed(2) : "—"}
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: "var(--content-tertiary)",
                }}
              >
                avg conf
              </div>
            </div>
          </div>
        </div>

        {view === "map" ? (
          // ── MAP VIEW ── the 3D concept graph ("neurons · synapses ·
          // lobes"), filling the center column below the shared header.
          <div style={{ flex: 1, minHeight: 0, padding: "12px 24px 22px" }}>
            <ConceptGraphView
              assistantId={assistantId}
              className="h-full"
              onOpenThread={onOpenThreadFromNode}
            />
          </div>
        ) : (
          <>
        {/* Search row */}
        <div
          style={{
            padding: "18px 24px 8px",
            display: "flex",
            alignItems: "center",
            // Wrap on narrow viewports so the chip + "Teach Cue" pill drop to
            // the next line instead of clipping off the 390px edge.
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div
            style={{
              flex: "1 1 180px",
              minWidth: 0,
              border: "1px solid var(--border-base)",
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
                color: "var(--content-default)",
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
              background: confidentOnly
                ? "var(--primary-base)"
                : "var(--surface-base)",
              color: confidentOnly
                ? "var(--content-inset)"
                : "var(--content-secondary)",
              border: "none",
              borderRadius: 8,
              padding: "7px 12px",
              fontFamily: MONO,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            confidence ≥ 0.6
          </button>
          <button
            type="button"
            data-coach="memory-teach"
            onClick={onTeachCue}
            style={{
              fontSize: 12.5,
              background: "var(--primary-base)",
              color: "var(--content-inset)",
              border: "none",
              borderRadius: 8,
              padding: "8px 14px",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            ✦ Teach Cue something
          </button>
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
            aria-expanded={showImport}
            title="Bring memories over from ChatGPT or another assistant"
            style={{
              fontSize: 12,
              background: "var(--surface-base)",
              color: "var(--content-secondary)",
              border: "1px solid var(--border-base)",
              borderRadius: 8,
              padding: "7px 12px",
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            ⤓ Import
          </button>
        </div>

        {/* The memory-import flow (v37 §2). This header is where imports
            live post-onboarding; the onboarding connect step carries the
            same card. "See what Cue learned" here just closes the panel and
            refreshes — the user is already standing on the surface. */}
        {showImport ? (
          <div style={{ padding: "8px 24px 4px", maxWidth: 620 }}>
            <MemoryImportCard
              assistantId={assistantId}
              onDone={() => {
                setShowImport(false);
                void invalidate();
              }}
            />
          </div>
        ) : null}

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
              background:
                filter === "all"
                  ? "var(--primary-base)"
                  : "var(--surface-lift)",
              color:
                filter === "all"
                  ? "var(--content-inset)"
                  : "var(--content-default)",
              border:
                filter === "all" ? "none" : "1px solid var(--border-base)",
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
                  background: active ? c.wash : "var(--surface-lift)",
                  color: active ? c.text : "var(--content-default)",
                  border: `1px solid ${active ? c.dot : "var(--border-base)"}`,
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
            <EmptyState
              firstRun={total === 0}
              onClearFilters={clearFilters}
              onTeach={onTeachCue}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
          </>
        )}
      </div>

      {/* ── PROVENANCE RAIL ───────────────────────────────────────── */}
      {/* Desktop: always-visible right rail. Mobile: a full-width detail
          section stacked beneath the list, shown only once a memory is
          selected (there's no room for a persistent empty rail). The map view
          carries its own detail drawer, so the rail is list-only. */}
      {view === "map" || (isMobile && (isError || !selected)) ? null : (
        <ProvenanceRail
          memory={isError ? null : selected}
          onEdit={startEdit}
          onForget={setPendingForget}
          stacked={isMobile}
        />
      )}

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
  stacked = false,
}: {
  memory: MemoryItem | null;
  onEdit: (item: MemoryItem) => void;
  onForget: (item: MemoryItem) => void;
  /** Mobile: render as a full-width section under the list (border on top,
   *  capped height) instead of the desktop right-hand rail. */
  stacked?: boolean;
}) {
  return (
    <aside
      style={{
        background: "var(--surface-base)",
        borderLeft: stacked ? "none" : "1px solid var(--border-base)",
        borderTop: stacked ? "1px solid var(--border-base)" : "none",
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minHeight: 0,
        maxHeight: stacked ? "45dvh" : undefined,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: MONO,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "var(--content-tertiary)",
        }}
      >
        Selected · provenance
      </div>

      {memory ? (
        <RailContent memory={memory} onEdit={onEdit} onForget={onForget} />
      ) : (
        <div
          style={{
            background: "var(--surface-lift)",
            border: "1px solid var(--border-base)",
            borderRadius: 13,
            padding: "20px 15px",
            fontSize: 12.5,
            color: "var(--content-tertiary)",
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
    typeof memory.confidence === "number" ? memory.confidence.toFixed(2) : "—";
  const reinforcement = memory.reinforcementCount ?? 0;
  const source = sourceTypeLabel(memory.sourceType);
  const recalled = memory.accessCount ?? 0;
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
          background: "var(--surface-lift)",
          border: "1px solid var(--border-base)",
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
            color: "var(--content-tertiary)",
          }}
        >
          Confidence
        </div>
        <div
          style={{
            height: 7,
            borderRadius: 4,
            background: "var(--surface-base)",
            marginTop: 5,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${confPct}%`,
              height: "100%",
              background: "var(--accent-cue)",
              borderRadius: 4,
            }}
          />
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO,
            color: "var(--content-secondary)",
            marginTop: 4,
          }}
        >
          {confText} · reinforced {reinforcement}×
        </div>
      </div>

      {/* Sources card */}
      <div
        style={{
          background: "var(--surface-lift)",
          border: "1px solid var(--border-base)",
          borderRadius: 13,
          padding: "14px 15px",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: MONO,
            color: "var(--content-tertiary)",
            marginBottom: 8,
          }}
        >
          SOURCES
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--content-secondary)",
            lineHeight: 1.7,
          }}
        >
          {source ? <div>· {source}</div> : null}
          {memory.scopeLabel ? <div>· {memory.scopeLabel}</div> : null}
          {firstSeen ? <div>· first seen {firstSeen}</div> : null}
          {lastSeen ? <div>· last seen {lastSeen}</div> : null}
          {reinforcement > 0 ? <div>· reinforced {reinforcement}×</div> : null}
          {recalled > 0 ? <div>· recalled {recalled}×</div> : null}
          {!source &&
          !memory.scopeLabel &&
          !firstSeen &&
          !lastSeen &&
          reinforcement === 0 &&
          recalled === 0 ? (
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
            border: "1px solid var(--border-base)",
            background: "var(--surface-lift)",
            color: "var(--content-default)",
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
            background:
              "color-mix(in srgb, var(--mv1-danger) 14%, transparent)",
            color: "var(--mv1-danger)",
            border:
              "1px solid color-mix(in srgb, var(--mv1-danger) 40%, transparent)",
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
              "linear-gradient(90deg,var(--surface-base) 0%,var(--border-base) 50%,var(--surface-base) 100%)",
            backgroundSize: "340px 100%",
            animation: "cueShimmer 1.3s linear infinite",
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({
  firstRun,
  onClearFilters,
  onTeach,
}: {
  firstRun: boolean;
  onClearFilters: () => void;
  onTeach: () => void;
}) {
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
        {firstRun ? "Cue learns as you go" : "No memories match this filter"}
      </div>
      <p
        style={{
          fontSize: 13.5,
          color: "var(--content-secondary)",
          maxWidth: 360,
        }}
      >
        Cue forms memories as you work — from chats, email, meetings, and the
        things you tell it to remember.
      </p>
      <button
        type="button"
        onClick={firstRun ? onTeach : onClearFilters}
        style={{
          fontSize: 12.5,
          background: "var(--accent-cue)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "8px 14px",
          cursor: "pointer",
        }}
      >
        {firstRun ? "Teach Cue something" : "Clear filters"}
      </button>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        background: "color-mix(in srgb, var(--mv1-danger) 12%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--mv1-danger) 35%, transparent)",
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
          background: "var(--mv1-danger)",
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
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            color: "var(--mv1-danger)",
          }}
        >
          Couldn&rsquo;t load your memories
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--content-secondary)",
            marginTop: 2,
          }}
        >
          The memory store didn&rsquo;t respond. Cue is running on cached recall
          only — retry to load them again.
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          fontSize: 12,
          background: "var(--mv1-danger)",
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
