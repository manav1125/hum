import { useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import {
  ApertureAvatar,
  Button,
  Card,
  Chip,
  MEMORY_TYPES,
  Typography,
  type MemoryType,
} from "@vellumai/design-library";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { memoryitemsByIdDelete } from "@/generated/daemon/sdk.gen";
import { memoryitemsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

import { useMemoryItemsQuery } from "./memories/hooks/use-memory-items-query";
import { MemoryRow } from "./memories/memory-row";
import type { MemoryItem } from "./memories/types";

type KindFilter = "all" | MemoryType;

const KIND_LABELS: Record<MemoryType, string> = {
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
  prospective: "Prospective",
  emotional: "Emotional",
  behavioral: "Behavioral",
  narrative: "Narrative",
  shared: "Shared",
};

/**
 * The Memory surface. Lists the assistant's real memories (via
 * `memoryitemsGet`), filterable by kind and searchable by text.
 *
 * Interactive: every row is forgettable — a trash affordance opens a
 * confirmation, then deletes the memory (`memoryitemsByIdDelete`) and
 * invalidates the list so it refetches. The empty state drives the user back
 * into conversation, since memories form from chatting with the assistant.
 *
 * Routed under `<ActiveAssistantGate>`, so `useActiveAssistantId()` is safe.
 */
export function MemoriesPage() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useMemoryItemsQuery(assistantId);

  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  // The memory pending confirmation in the "Forget" dialog, if any.
  const [pendingForget, setPendingForget] = useState<MemoryItem | null>(null);

  const forgetMutation = useMutation({
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
      if (assistantId) {
        await queryClient.invalidateQueries({
          queryKey: memoryitemsGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      }
    },
  });

  const items = useMemo<MemoryItem[]>(() => data?.items ?? [], [data?.items]);

  // Per-type counts + average confidence, computed from the real items — the
  // design's header stats and per-chip counts (surfaces/Memory.dc.html).
  const countByKind = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) m[it.kind] = (m[it.kind] ?? 0) + 1;
    return m;
  }, [items]);
  const avgConfidence = useMemo(() => {
    const confs = items
      .map((i) => i.confidence)
      .filter((c): c is number => typeof c === "number");
    if (confs.length === 0) return null;
    return Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100;
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (q && !`${item.statement} ${item.subject}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [items, filter, query]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <header className="shrink-0">
        <Typography
          variant="title-small"
          className="text-[var(--content-default)]"
        >
          {items.length > 0
            ? `Cue remembers ${items.length.toLocaleString()} things about how you work.`
            : "Memory"}
        </Typography>
        <Typography
          variant="body-medium-lighter"
          className="mt-1 text-[var(--content-tertiary)]"
        >
          Across 8 memory types · every one traceable to its source · you can
          edit or forget anything.
          {avgConfidence !== null && (
            <span className="ml-2 font-[var(--font-mono)] text-[var(--content-tertiary)]">
              {avgConfidence.toFixed(2)} avg conf
            </span>
          )}
        </Typography>
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${items.length || ""} memories…`.replace("  ", " ")}
        className="shrink-0 rounded-lg border border-[var(--border-base)] bg-[var(--surface-sunken)] px-3 py-2 text-sm text-[var(--content-default)] outline-none placeholder:text-[var(--content-tertiary)] focus:border-[var(--accent-cue)]"
      />

      <div
        className="flex shrink-0 flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter memories by kind"
      >
        <Chip
          size="sm"
          selected={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All · {items.length}
        </Chip>
        {MEMORY_TYPES.map((kind) => (
          <Chip
            key={kind}
            size="sm"
            selected={filter === kind}
            onClick={() => setFilter(kind)}
          >
            {KIND_LABELS[kind]}
            {countByKind[kind] ? ` ${countByKind[kind]}` : ""}
          </Chip>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            filtered={filter !== "all"}
            onStartConversation={() => void navigate("/assistant/")}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {filteredItems.map((item) => (
              <li key={item.id}>
                <MemoryRow
                  item={item}
                  onForget={setPendingForget}
                  isForgetting={
                    forgetMutation.isPending &&
                    forgetMutation.variables?.id === item.id
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingForget !== null}
        title="Forget this memory?"
        message={
          pendingForget
            ? `Cue will permanently forget “${pendingForget.statement}”. This can’t be undone.`
            : ""
        }
        confirmLabel={forgetMutation.isPending ? "Forgetting…" : "Forget"}
        cancelLabel="Keep"
        destructive
        isPending={forgetMutation.isPending}
        onConfirm={() => {
          if (pendingForget) forgetMutation.mutate(pendingForget);
        }}
        onCancel={() => {
          if (!forgetMutation.isPending) setPendingForget(null);
        }}
      />
    </div>
  );
}

function LoadingState() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="h-[76px] animate-pulse rounded-lg"
          style={{ backgroundColor: "var(--surface-lift)" }}
        />
      ))}
    </ul>
  );
}

function ErrorState() {
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-12 text-center">
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          Couldn&rsquo;t load memories
        </h3>
        <p
          className="mt-1 max-w-sm text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          Something went wrong fetching memories. Try refreshing the page.
        </p>
      </Card.Body>
    </Card.Root>
  );
}

function EmptyState({
  filtered,
  onStartConversation,
}: {
  filtered: boolean;
  onStartConversation: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ApertureAvatar state="idle" size={56} className="mb-4" />
      <h3
        className="text-title-small"
        style={{ color: "var(--content-default)" }}
      >
        {filtered ? "No memories of this kind" : "No memories yet"}
      </h3>
      <p
        className="mt-1 max-w-sm text-body-medium-lighter"
        style={{ color: "var(--content-tertiary)" }}
      >
        {filtered
          ? "Try a different kind, or clear the filter to see everything."
          : "As you chat, your assistant will start remembering what matters — it'll show up here."}
      </p>
      {!filtered ? (
        <Button className="mt-5" onClick={onStartConversation}>
          Start a conversation
        </Button>
      ) : null}
    </div>
  );
}
