/**
 * K4 · Search — what the endpoint actually returns, and what it does not.
 *
 * Design asked for three things: answer-first for questions, a typed list for
 * keywords, and "decision records as a first-class result — the thing that
 * makes this institutional memory rather than a file finder."
 *
 * I checked the endpoint before designing around it. `GET
 * /v1/assistants/{id}/search/global` returns exactly four arrays:
 * `conversations`, `memories`, `schedules`, `contacts`. There is no decision
 * record — not as a type, not as a memory `kind` (the eight kinds are
 * semantic / prospective / procedural / episodic / emotional / behavioral /
 * narrative / shared), not anywhere else in the daemon's surface. Files and
 * work items are not in the index either.
 *
 * So this module maps the four real categories into one typed list and
 * **leaves the decision row unfabricated**. `SearchResultKind` carries
 * `"decision"` so the row is ready the day the daemon indexes them, and the UI
 * says plainly that decisions are not searchable yet. Inventing a decision card
 * out of a semantic memory would make the demo match the frame and make the
 * product a liar — the exact thing "never a fake number" is about.
 *
 * The other correction is the error path. `domains/chat/api/global-search.ts`
 * returns EMPTY_RESULTS on failure, which turns a 500 into "nothing found".
 * A failed fetch is an error state, not an empty one, so this module returns a
 * discriminated result and lets the surface tell the truth.
 */
import { searchGlobalGet } from "@/generated/daemon/sdk.gen";

export type SearchResultKind =
  | "conversation"
  | "memory"
  | "schedule"
  | "contact"
  /** Reserved. Nothing produces this yet — see the module note. */
  | "decision";

export interface SearchResult {
  id: string;
  kind: SearchResultKind;
  title: string;
  /** Provenance — where it came from. Every result carries one. */
  meta: string;
  updatedAt: number | null;
}

export type SearchOutcome =
  | { status: "ok"; query: string; results: SearchResult[] }
  /** The fetch failed. NOT an empty result — the surface must say so. */
  | { status: "error"; query: string; message: string }
  /** No assistant resolved yet; searching is not possible, and that is not a
   *  failure to report as one. */
  | { status: "unavailable"; query: string; message: string };

/** The categories the daemon can actually search. */
export const SEARCHABLE_CATEGORIES = [
  "conversations",
  "memories",
  "schedules",
  "contacts",
] as const;

/**
 * Decision records are not in the index. Exported so the surface's honest line
 * and the test that pins it read the same constant.
 */
export const DECISIONS_NOT_INDEXED =
  "Decisions aren't searchable yet — I only index conversations, memories, schedules and people.";

/** A question wants an answer; a keyword wants a list. */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (q.endsWith("?")) return true;
  return /^(what|who|when|where|why|how|did|do|does|is|are|was|were|can|should|will)\b/.test(
    q,
  );
}

export async function searchFromPhone(
  assistantId: string | null,
  query: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<SearchOutcome> {
  const trimmed = query.trim();
  if (!assistantId) {
    return {
      status: "unavailable",
      query: trimmed,
      message: "I'm not connected to your Cue yet, so I can't search.",
    };
  }

  try {
    const { data, response } = await searchGlobalGet({
      path: { assistant_id: assistantId },
      query: {
        q: trimmed,
        limit: options?.limit ?? 20,
        categories: SEARCHABLE_CATEGORIES.join(","),
      },
      throwOnError: false,
      signal: options?.signal,
    });

    // A superseded debounce is not a failure and must not paint one. Checked
    // on the SIGNAL rather than on the error's shape: the generated client
    // swallows the abort into its `{ error }` channel, so `instanceof
    // DOMException` alone would let a cancelled keystroke render as an outage.
    if (aborted(options?.signal)) {
      return { status: "ok", query: trimmed, results: [] };
    }

    if (!response?.ok || !data) {
      return {
        status: "error",
        query: trimmed,
        message: `I couldn't reach my search index${response?.status ? ` (${response.status})` : ""}. Nothing was searched.`,
      };
    }

    return { status: "ok", query: trimmed, results: flatten(data.results) };
  } catch (err) {
    if (aborted(options?.signal) || isAbortError(err)) {
      return { status: "ok", query: trimmed, results: [] };
    }
    return {
      status: "error",
      query: trimmed,
      message: "I couldn't reach my search index. Nothing was searched.",
    };
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

type RawResults = Awaited<
  ReturnType<typeof searchGlobalGet>
>["data"] extends { results: infer R } | undefined
  ? R
  : never;

function flatten(results: RawResults): SearchResult[] {
  const out: SearchResult[] = [];

  for (const c of results.conversations ?? []) {
    out.push({
      id: `conversation:${c.id}`,
      kind: "conversation",
      title: c.title?.trim() || firstWords(c.excerpt) || "Untitled conversation",
      meta: `Conversation · ${c.matchCount} ${c.matchCount === 1 ? "match" : "matches"}`,
      updatedAt: c.updatedAt,
    });
  }
  for (const m of results.memories ?? []) {
    out.push({
      id: `memory:${m.id}`,
      kind: "memory",
      title: firstWords(m.text) || "Memory",
      meta: m.subject ? `Memory · ${m.kind} · ${m.subject}` : `Memory · ${m.kind}`,
      updatedAt: m.updatedAt,
    });
  }
  for (const s of results.schedules ?? []) {
    out.push({
      id: `schedule:${s.id}`,
      kind: "schedule",
      title: s.name || firstWords(s.message) || "Schedule",
      meta: s.enabled ? "Schedule · on" : "Schedule · paused",
      updatedAt: s.nextRunAt,
    });
  }
  for (const p of results.contacts ?? []) {
    out.push({
      id: `contact:${p.id}`,
      kind: "contact",
      title: p.displayName,
      meta: p.notes ? `Person · ${firstWords(p.notes)}` : "Person",
      updatedAt: p.lastInteraction,
    });
  }

  return out;
}

function firstWords(text: string | null | undefined, max = 68): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
