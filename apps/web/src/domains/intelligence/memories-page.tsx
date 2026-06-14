import { useMemo, useState } from "react";

import {
  ApertureAvatar,
  Card,
  Chip,
  MEMORY_TYPES,
  Typography,
  type MemoryType,
} from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

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

export function MemoriesPage() {
  const assistantId = useActiveAssistantId();
  const { data, isLoading, isError } = useMemoryItemsQuery(assistantId);

  const [filter, setFilter] = useState<KindFilter>("all");

  const items = useMemo<MemoryItem[]>(() => data?.items ?? [], [data?.items]);

  const filteredItems = useMemo(
    () =>
      filter === "all"
        ? items
        : items.filter((item) => item.kind === filter),
    [items, filter],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <header className="shrink-0">
        <Typography
          variant="title-small"
          className="text-[var(--content-default)]"
        >
          Memory
        </Typography>
        <Typography
          variant="body-medium-lighter"
          className="mt-1 text-[var(--content-tertiary)]"
        >
          What your assistant remembers, tagged by the kind of memory it is.
        </Typography>
      </header>

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
          All
        </Chip>
        {MEMORY_TYPES.map((kind) => (
          <Chip
            key={kind}
            size="sm"
            selected={filter === kind}
            onClick={() => setFilter(kind)}
          >
            {KIND_LABELS[kind]}
          </Chip>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState />
        ) : filteredItems.length === 0 ? (
          <EmptyState filtered={filter !== "all"} />
        ) : (
          <ul className="flex flex-col gap-2">
            {filteredItems.map((item) => (
              <li key={item.id}>
                <MemoryRow item={item} />
              </li>
            ))}
          </ul>
        )}
      </div>
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

function EmptyState({ filtered }: { filtered: boolean }) {
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
    </div>
  );
}
