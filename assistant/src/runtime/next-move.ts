/**
 * "Chief of staff" next-move intelligence.
 *
 * Picks the SINGLE most important thing the user should do right now and
 * explains why, LLM-reasoned. Candidates are gathered from three stores
 * (pending interactions/approvals, queued/awaiting-review work-items, and the
 * top home-feed action items), ranked DETERMINISTICALLY, and the winner is
 * narrated by the flash LLM (the same path conversation titles use).
 *
 * Serving model — stale-while-revalidate, mirroring `home-content-refresh.ts`
 * (the `GET /v1/home/feed` precedent in `runtime/AGENTS.md`):
 *
 *   - `getNextMove()` is a synchronous, side-effect-free read: it returns the
 *     cached move when fresh, otherwise a DETERMINISTIC fallback (templated
 *     headline + the item's notes as reasoning) so the endpoint is NEVER empty
 *     or broken. It never blocks on the LLM.
 *   - `revalidateNextMoveInBackground()` is the fire-and-forget refresh the GET
 *     handler kicks: single-flight, TTL-gated, regenerates the LLM narration
 *     when the top item changes or the TTL elapses, and caches the result.
 *
 * The cache is keyed on the top candidate's id: when the highest-ranked item
 * changes, the cached narration is stale regardless of age and is regenerated.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { FeedItem } from "../home/feed-types.js";
import { readHomeFeed } from "../home/feed-writer.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import { truncate } from "../util/truncate.js";
import { listWorkItems, type WorkItem } from "../work-items/work-item-store.js";
import { runBtwSidechain } from "./btw-sidechain.js";
import { getByKind } from "./pending-interactions.js";

const log = getLogger("next-move");

// ---------------------------------------------------------------------------
// Wire contract (consumed by the frontend — keep in lockstep)
// ---------------------------------------------------------------------------

export type NextMoveKind = "approval" | "work_item" | "feed";

export interface NextMoveAction {
  id: string;
  label: string;
  kind: "approve" | "decline" | "run" | "open_thread" | "snooze";
  endpoint?: string;
  method?: string;
}

export interface NextMove {
  hasMove: boolean;
  itemId: string | null;
  kind: NextMoveKind | null;
  headline: string;
  reasoning: string;
  actions: NextMoveAction[];
  sourceConversationId?: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Candidate model — the normalized shape ranking + narration operate on
// ---------------------------------------------------------------------------

interface NextMoveCandidate {
  /** Stable id used as the cache key and returned as `itemId`. */
  id: string;
  kind: NextMoveKind;
  title: string;
  /** Grounding context for the LLM prompt + deterministic reasoning fallback. */
  notes: string;
  source: string;
  /** Epoch ms the underlying item was created — older = more urgent within a tier. */
  createdAtMs: number;
  /** Lower = ranked first. */
  rankTier: number;
  conversationId?: string;
  actions: NextMoveAction[];
}

// Rank tiers — smaller wins. A pending approval that blocks someone outranks
// any queued work; an awaiting-review item outranks a freshly-queued one; feed
// action items are the lowest-priority candidates.
const TIER_APPROVAL = 0;
const TIER_AWAITING_REVIEW = 1;
const TIER_QUEUED = 2;
const TIER_FEED = 3;

const URGENCY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// Candidate gathering (read-only)
// ---------------------------------------------------------------------------

interface PendingInteractionRow {
  requestId: string;
  conversationId: string;
  kind: string;
  confirmationDetails?: { toolName?: string; riskLevel?: string };
}

function gatherApprovalCandidates(): NextMoveCandidate[] {
  const candidates: NextMoveCandidate[] = [];
  for (const kind of ["confirmation", "acp_confirmation"] as const) {
    let rows: PendingInteractionRow[] = [];
    try {
      rows = getByKind(kind) as unknown as PendingInteractionRow[];
    } catch (err) {
      log.warn(
        { err: String(err), kind },
        "next-move: failed to read pending interactions",
      );
      continue;
    }
    for (const row of rows) {
      const tool = row.confirmationDetails?.toolName;
      const title = tool ? `Approve: ${tool}` : "Approval requested";
      candidates.push({
        id: `int:${row.requestId}`,
        kind: "approval",
        title,
        notes: tool
          ? `A tool call (${tool}) is paused waiting for your approval${
              row.confirmationDetails?.riskLevel
                ? ` (risk: ${row.confirmationDetails.riskLevel})`
                : ""
            }. Work is blocked until you decide.`
          : "An action is paused waiting for your approval. Work is blocked until you decide.",
        source: "approval",
        // Interactions are in-memory and don't carry a creation timestamp;
        // treat them as "now" — the tier already floats them to the top, so
        // intra-tier age ordering is not load-bearing here.
        createdAtMs: Date.now(),
        rankTier: TIER_APPROVAL,
        conversationId: row.conversationId,
        actions: [
          {
            id: "approve",
            label: "Approve",
            kind: "approve",
            endpoint: "/v1/confirm",
            method: "POST",
          },
          {
            id: "decline",
            label: "Decline",
            kind: "decline",
            endpoint: "/v1/confirm",
            method: "POST",
          },
        ],
      });
    }
  }
  return candidates;
}

function gatherWorkItemCandidates(): NextMoveCandidate[] {
  let items: WorkItem[] = [];
  try {
    items = listWorkItems();
  } catch (err) {
    log.warn({ err: String(err) }, "next-move: failed to read work-items");
    return [];
  }

  const candidates: NextMoveCandidate[] = [];
  for (const item of items) {
    let rankTier: number;
    let actions: NextMoveAction[];
    if (item.status === "awaiting_review") {
      rankTier = TIER_AWAITING_REVIEW;
      actions = [
        {
          id: "open_thread",
          label: "Review",
          kind: "open_thread",
          endpoint: `/v1/work-items/${item.id}/output`,
          method: "GET",
        },
      ];
    } else if (item.status === "queued") {
      rankTier = TIER_QUEUED;
      actions = [
        {
          id: "run",
          label: "Run it",
          kind: "run",
          endpoint: `/v1/work-items/${item.id}/run`,
          method: "POST",
        },
      ];
    } else {
      // running / terminal items are not actionable "next moves".
      continue;
    }

    candidates.push({
      id: `wi:${item.id}`,
      kind: "work_item",
      title: item.title,
      notes: item.notes?.trim() || item.title,
      source: item.sourceType ?? "task queue",
      createdAtMs: item.createdAt,
      rankTier,
      conversationId: item.lastRunConversationId ?? undefined,
      actions,
    });
  }
  return candidates;
}

const ACTIONABLE_FEED_STATUSES = new Set(["new", "seen"]);

function gatherFeedCandidates(): NextMoveCandidate[] {
  let feedItems: FeedItem[] = [];
  try {
    feedItems = readHomeFeed().items;
  } catch (err) {
    log.warn({ err: String(err) }, "next-move: failed to read home feed");
    return [];
  }

  const candidates: NextMoveCandidate[] = [];
  for (const item of feedItems) {
    // Only items that still need attention and carry at least one action.
    if (!ACTIONABLE_FEED_STATUSES.has(item.status)) continue;
    if (!item.actions || item.actions.length === 0) continue;

    const createdMs = Date.parse(item.createdAt);
    candidates.push({
      id: `feed:${item.id}`,
      kind: "feed",
      title: item.title ?? item.summary,
      notes: item.summary || item.title || "",
      source: item.category ?? "home feed",
      createdAtMs: Number.isNaN(createdMs) ? Date.now() : createdMs,
      // Feed items rank within their tier by urgency, then age.
      rankTier:
        TIER_FEED + (URGENCY_RANK[item.urgency ?? "medium"] ?? 2) * 0.01,
      conversationId: item.conversationId,
      actions: [
        {
          id: "open_thread",
          label: "Open",
          kind: "open_thread",
          endpoint: `/v1/home/feed/${item.id}/actions/${item.actions[0].id}`,
          method: "POST",
        },
      ],
    });
  }
  return candidates;
}

/**
 * Gather all candidates and pick the single highest-ranked one
 * DETERMINISTICALLY. Ordering, smallest-first:
 *   1. rankTier (approval < awaiting_review < queued < feed)
 *   2. within a tier, OLDEST first (smallest createdAtMs) — the longest-waiting
 *      / highest-urgency item wins.
 *   3. id, as a final stable tie-break.
 */
export function pickTopCandidate(): NextMoveCandidate | null {
  const all = [
    ...gatherApprovalCandidates(),
    ...gatherWorkItemCandidates(),
    ...gatherFeedCandidates(),
  ];
  if (all.length === 0) return null;

  all.sort(
    (a, b) =>
      a.rankTier - b.rankTier ||
      a.createdAtMs - b.createdAtMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return all[0];
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no cache yet / LLM unavailable or failed)
// ---------------------------------------------------------------------------

const EMPTY_MOVE: NextMove = {
  hasMove: false,
  itemId: null,
  kind: null,
  headline: "You're all caught up.",
  reasoning: "",
  actions: [],
  generatedAt: new Date(0).toISOString(),
};

function deterministicHeadline(c: NextMoveCandidate): string {
  const verb =
    c.kind === "approval" ? "Approve" : c.kind === "work_item" ? "Run" : "Open";
  // The approval candidate title already reads "Approve: <tool>" — don't
  // double-prefix it. Other kinds get the templated "<verb>: <title>".
  const headline = c.title.toLowerCase().startsWith(`${verb.toLowerCase()}:`)
    ? c.title
    : `${verb}: ${c.title}`;
  return truncate(headline, 90, "…");
}

function buildDeterministicMove(c: NextMoveCandidate): NextMove {
  return {
    hasMove: true,
    itemId: c.id,
    kind: c.kind,
    headline: deterministicHeadline(c),
    reasoning: c.notes,
    actions: c.actions,
    ...(c.conversationId ? { sourceConversationId: c.conversationId } : {}),
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// In-memory cache + single-flight TTL-gated revalidation
// ---------------------------------------------------------------------------

/** TTL for LLM-narrated moves: regenerate at most this often per top item. */
const NEXT_MOVE_TTL_MS = 4 * 60_000; // 4 minutes
const GENERATION_TIMEOUT_MS = 6_000;

interface CacheEntry {
  /** The top candidate id this narration was generated for. */
  topItemId: string;
  move: NextMove;
  generatedAtMs: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Synchronous, side-effect-free read of the current next-move. Safe for GET
 * handlers. Returns, in order of preference:
 *   - the cached LLM-narrated move, when it's still fresh AND matches the
 *     current top candidate;
 *   - a deterministic fallback move for the current top candidate;
 *   - the "all caught up" empty move when nothing is pending.
 *
 * Never calls the LLM. Pair with {@link revalidateNextMoveInBackground} to
 * refresh the narration off the GET path.
 */
export function getNextMove(): NextMove {
  const top = pickTopCandidate();
  if (!top) return EMPTY_MOVE;

  if (
    cache &&
    cache.topItemId === top.id &&
    Date.now() - cache.generatedAtMs <= NEXT_MOVE_TTL_MS
  ) {
    return cache.move;
  }

  // No fresh narration for this item — serve the deterministic move now; the
  // GET handler's revalidate call will fill the cache for next time.
  return buildDeterministicMove(top);
}

function isCacheFresh(topId: string): boolean {
  return (
    cache != null &&
    cache.topItemId === topId &&
    Date.now() - cache.generatedAtMs <= NEXT_MOVE_TTL_MS
  );
}

async function generateNarration(c: NextMoveCandidate): Promise<void> {
  // Re-check freshness right before the (potentially expensive) LLM call — a
  // concurrent caller may have already generated for this exact item.
  if (isCacheFresh(c.id)) return;

  let move: NextMove;
  try {
    const provider = await getConfiguredProvider("conversationTitle");
    if (!provider) {
      move = buildDeterministicMove(c);
    } else {
      const config = getConfig();
      const resolved = resolveCallSiteConfig("conversationTitle", config.llm);
      const result = await runBtwSidechain({
        content: buildNarrationPrompt(c),
        provider,
        systemPrompt: buildNarrationSystemPrompt(),
        messages: [],
        tools: [],
        callSite: "conversationTitle",
        maxTokens: resolved.maxTokens,
        timeoutMs: GENERATION_TIMEOUT_MS,
      });
      const parsed = parseNarration(result.text);
      move = parsed
        ? {
            hasMove: true,
            itemId: c.id,
            kind: c.kind,
            headline: truncate(parsed.headline, 90, "…"),
            reasoning: parsed.reasoning,
            actions: c.actions,
            ...(c.conversationId
              ? { sourceConversationId: c.conversationId }
              : {}),
            generatedAt: new Date().toISOString(),
          }
        : buildDeterministicMove(c);
    }
  } catch (err) {
    log.warn({ err: String(err) }, "next-move: narration generation failed");
    move = buildDeterministicMove(c);
  }

  cache = { topItemId: c.id, move, generatedAtMs: Date.now() };
}

/**
 * Fire-and-forget refresh of the LLM narration for the current top candidate.
 * Returns immediately; callers (the GET handler) must not await it. Single-
 * flight (concurrent calls share one generation) and TTL-gated (no-op when the
 * cache is already fresh for the current top item). No-op when nothing is
 * pending.
 */
export function revalidateNextMoveInBackground(): void {
  if (inFlight) return;

  const top = pickTopCandidate();
  if (!top) return;
  if (isCacheFresh(top.id)) return;

  inFlight = generateNarration(top)
    .catch((err) => {
      log.warn({ err: String(err) }, "next-move: revalidation failed");
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Reset module state. Test-only. */
export function __resetNextMoveCacheForTest(): void {
  cache = null;
  inFlight = null;
}

// ---------------------------------------------------------------------------
// LLM prompt + parsing
// ---------------------------------------------------------------------------

function buildNarrationSystemPrompt(): string {
  return [
    "You are a chief-of-staff assistant. Given ONE pending item, write a crisp call to action.",
    "",
    "Output EXACTLY two lines, nothing else:",
    "HEADLINE: <one imperative line, 90 characters max>",
    "REASONING: <1-2 sentences of grounded context>",
    "",
    "Rules:",
    "- Be specific and grounded ONLY in the item you are given (its title, source, age, notes).",
    "- NEVER invent facts, names, deadlines, or details that aren't in the item.",
    "- If the item is vague, describe it plainly rather than embellishing.",
    "- The headline must start with a verb (Approve, Run, Review, Reply, Open…).",
    "- No markdown, no quotes, no preamble, no trailing commentary.",
  ].join("\n");
}

function buildNarrationPrompt(c: NextMoveCandidate): string {
  const ageMin = Math.max(0, Math.round((Date.now() - c.createdAtMs) / 60_000));
  const lines = [
    `Item kind: ${c.kind}`,
    `Title: ${c.title}`,
    `Source: ${c.source}`,
    `Waiting for: ~${ageMin} minute(s)`,
  ];
  if (c.notes && c.notes !== c.title) {
    lines.push(`Notes: ${truncate(c.notes, 600, "…")}`);
  }
  return lines.join("\n");
}

/** Parse the two-line LLM output. Returns null when it can't be salvaged. */
function parseNarration(
  raw: string,
): { headline: string; reasoning: string } | null {
  const text = raw.trim();
  if (!text) return null;

  let headline = "";
  let reasoning = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const hm = /^HEADLINE:\s*(.+)$/i.exec(trimmed);
    if (hm) {
      headline = hm[1].trim();
      continue;
    }
    const rm = /^REASONING:\s*(.+)$/i.exec(trimmed);
    if (rm) {
      reasoning = rm[1].trim();
      continue;
    }
  }

  // Fallback: if the model ignored the labels but produced prose, use the
  // first non-empty line as the headline.
  if (!headline) {
    const firstLine = text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    if (!firstLine) return null;
    headline = firstLine;
  }

  headline = stripQuotes(headline);
  reasoning = stripQuotes(reasoning);
  if (!headline) return null;
  return { headline, reasoning };
}

function stripQuotes(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}
