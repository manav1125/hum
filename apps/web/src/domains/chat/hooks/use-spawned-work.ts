/**
 * The work THIS conversation spawned.
 *
 * A commitment captured in a thread becomes a work item that runs in its own
 * background conversation. Without this query the thread has no idea, and the
 * user only finds the result by chance in HQ. The daemon records the link on
 * `work_items.origin_conversation_id` and exposes it as the
 * `originConversationId` filter on the work-items list.
 *
 * Nothing is fabricated: rows are narrowed defensively (the generated `items`
 * is `unknown[]`), and anything without a readable id + title is dropped rather
 * than rendered as a placeholder.
 */

import { useQuery } from "@tanstack/react-query";

import { workitemsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

/** One spawned work item, narrowed to what the strip actually renders. */
export interface SpawnedWorkItem {
  id: string;
  title: string;
  /** queued | running | awaiting_review | done | failed | cancelled */
  status: string;
  /** The conversation the RUN happened in — the "see the work" target. */
  lastRunConversationId: string | null;
  /** Live one-liner the runner stamps while running; null otherwise. */
  lastProgressNote: string | null;
  /**
   * The thing this item is filed under, when it is filed. This is the only
   * durable link the data model has today between a conversation and a thing —
   * `useConversationThing` reads it to title the thread's header.
   */
  projectId: string | null;
  createdAt: number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function narrow(raw: unknown): SpawnedWorkItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = str(rec.id);
  const title = str(rec.title);
  const status = str(rec.status);
  if (!id || !title || !status) return null;
  return {
    id,
    title,
    status,
    lastRunConversationId: str(rec.lastRunConversationId),
    lastProgressNote: str(rec.lastProgressNote),
    projectId: str(rec.projectId),
    createdAt: num(rec.createdAt),
  };
}

export interface SpawnedWorkResult {
  items: SpawnedWorkItem[];
  isLoading: boolean;
  /** True when the query failed — the strip stays hidden rather than lying. */
  isError: boolean;
}

/**
 * Fetch the work items this conversation spawned. Disabled (and empty) until
 * both ids are known, so the strip simply doesn't render on a fresh thread.
 *
 * Live updates come free from `useActivitySync`, which invalidates the
 * `workitemsGet` key on `work_item_status_changed` / `work_item_completed`.
 */
export function useSpawnedWork(
  assistantId: string | null | undefined,
  conversationId: string | null | undefined,
): SpawnedWorkResult {
  const enabled = Boolean(assistantId && conversationId);
  const query = useQuery({
    ...workitemsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { originConversationId: conversationId ?? "" },
    }),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const raw = (query.data as { items?: unknown[] } | undefined)?.items ?? [];
  const items = raw
    .map(narrow)
    .filter((i): i is SpawnedWorkItem => i !== null)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return {
    items: query.isError ? [] : items,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
  };
}
