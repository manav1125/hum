/**
 * Morning Brief data hook — `GET /v1/assistants/{assistant_id}/brief/morning`.
 *
 * The daemon route exists (assistant/src/runtime/routes/morning-brief-routes.ts)
 * but is not yet in the generated SDK, so — exactly like
 * `pages/command-center/use-next-move.ts` does — this hook names the wire
 * contract by hand and calls the route through the already-configured, authed
 * daemon `client`. When codegen lands the types can be swapped with no
 * call-site churn.
 */
import { useQuery } from "@tanstack/react-query";

import { client } from "@/generated/daemon/client.gen";

/* ------------------------------------------------------------------------- */
/* Wire contract (kept in lockstep with morning-brief-routes.ts)             */
/* ------------------------------------------------------------------------- */

export type OvernightState = "review" | "done";

/** Counts from the latest inbox-management run (kind "inbox_cleanup" rows). */
export interface InboxCleanupCounts {
  archived: number;
  drafted: number;
  keptImportant: number;
}

export interface OvernightItem {
  id: string;
  title: string;
  project?: string;
  agent?: string;
  state: OvernightState;
  kind: string;
  /** Present only on kind "inbox_cleanup" rows. */
  counts?: InboxCleanupCounts;
  completedAt: string;
}

export interface BriefAskAction {
  id: string;
  label: string;
  kind: "approve" | "decline" | "open_thread";
  endpoint: string;
  method: string;
}

export interface BriefAsk {
  id: string;
  kind: "approval" | "review";
  title: string;
  project?: string;
  agent?: string;
  actions: BriefAskAction[];
  conversationId?: string;
}

export interface DayEntry {
  time?: string;
  title: string;
  kind: "event" | "work_item";
}

export interface MorningBrief {
  generatedAt: string;
  since: string;
  overnight: OvernightItem[];
  ask: BriefAsk | null;
  day: DayEntry[];
  calendarAvailable: boolean;
}

/* ------------------------------------------------------------------------- */
/* Defensive narrowing — the daemon owns the shape; never trust it blindly.  */
/* ------------------------------------------------------------------------- */

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function normalizeCounts(raw: unknown): InboxCleanupCounts | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const { archived, drafted, keptImportant } = o;
  if (
    typeof archived !== "number" ||
    typeof drafted !== "number" ||
    typeof keptImportant !== "number"
  )
    return undefined;
  return { archived, drafted, keptImportant };
}

function normalizeOvernight(raw: unknown): OvernightItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): OvernightItem[] => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const id = str(o.id);
    const title = str(o.title);
    const state = o.state === "review" || o.state === "done" ? o.state : null;
    if (!id || !title || !state) return [];
    return [
      {
        id,
        title,
        state,
        project: str(o.project),
        agent: str(o.agent),
        kind: str(o.kind) ?? "work_item",
        counts: normalizeCounts(o.counts),
        completedAt: str(o.completedAt) ?? "",
      },
    ];
  });
}

function normalizeAsk(raw: unknown): BriefAsk | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const title = str(o.title);
  if (!id || !title) return null;
  const actions = Array.isArray(o.actions)
    ? o.actions.flatMap((a): BriefAskAction[] => {
        if (!a || typeof a !== "object") return [];
        const act = a as Record<string, unknown>;
        const actionId = str(act.id);
        const label = str(act.label);
        const kind = act.kind;
        if (
          !actionId ||
          !label ||
          (kind !== "approve" && kind !== "decline" && kind !== "open_thread")
        )
          return [];
        return [
          {
            id: actionId,
            label,
            kind,
            endpoint: str(act.endpoint) ?? "",
            method: str(act.method) ?? "POST",
          },
        ];
      })
    : [];
  return {
    id,
    title,
    kind: o.kind === "approval" ? "approval" : "review",
    project: str(o.project),
    agent: str(o.agent),
    actions,
    conversationId: str(o.conversationId),
  };
}

function normalizeDay(raw: unknown): DayEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): DayEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const title = str(o.title);
    if (!title) return [];
    return [
      {
        title,
        time: str(o.time),
        kind: o.kind === "event" ? "event" : "work_item",
      },
    ];
  });
}

export function normalizeMorningBrief(raw: unknown): MorningBrief | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    generatedAt: str(o.generatedAt) ?? new Date().toISOString(),
    since: str(o.since) ?? "",
    overnight: normalizeOvernight(o.overnight),
    ask: normalizeAsk(o.ask),
    day: normalizeDay(o.day),
    calendarAvailable: o.calendarAvailable === true,
  };
}

export function morningBriefQueryKey(
  assistantId: string,
): readonly unknown[] {
  return ["mv3", "morning-brief", assistantId];
}

/** Fetch the three-beat brief. `brief` stays null while loading / on failure. */
export function useMorningBrief(assistantId: string | null): {
  brief: MorningBrief | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: morningBriefQueryKey(assistantId ?? ""),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, response } = await client.get<
        Record<string, unknown>,
        unknown
      >({
        url: "/v1/assistants/{assistant_id}/brief/morning",
        path: { assistant_id: assistantId ?? "" },
        throwOnError: false,
      });
      if (!response?.ok) throw new Error(`brief/morning ${response?.status}`);
      return normalizeMorningBrief(data);
    },
  });
  return {
    brief: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
