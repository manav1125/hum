/**
 * Position 3 — up to five prompt chips, **derived from real state**.
 *
 * §4 allows the canvas five chips and nothing else. What earns them is that
 * they are not starters: a clean surface still has to prove Cue knows things,
 * and the only way a chip does that is by naming something Cue actually read
 * this morning. So every chip here traces to a row in one of three queries —
 * a needs-you item, today's free block, an active mission — and carries the
 * id of the row it came from ({@link CanvasPrompt.sourceId}).
 *
 * ## What this replaces, and why
 *
 * The canvas used to render two prompt sets, neither state-derived:
 *
 * - **Six capability pills** hardcoded in `chat-launcher.tsx` ("Draft a reply",
 *   "Plan my day", "Triage inbox", "Research", "Make a doc", "Brief me"). Pure
 *   copy, identical for every user on every day.
 * - **Four daemon starters** from `GET /conversation-starters`. These *look*
 *   state-derived and are not: the generator
 *   (`assistant/src/memory/job-handlers/conversation-starters.ts`) prompts an
 *   LLM with the memory graph, the skill catalogue and the wall clock — and
 *   never reads work items, approvals, missions or the calendar. Worse, the
 *   memory graph is seeded with capability descriptions of the skills
 *   themselves, so for a light user the "personalised" chips degrade into
 *   capability advertisements wearing state's clothes. Nothing in the row
 *   carries provenance either: the API returns `{id,label,prompt,category,
 *   batch}` and `sourceMemoryKinds` is a per-batch constant that never leaves
 *   the daemon, so a chip cannot be resolved back to anything.
 *
 * Deriving here rather than in the daemon is a deliberate trade: it costs
 * three queries the rail and HQ already make (react-query dedupes them by key,
 * so no extra request) and buys a chip that can be checked against the row it
 * claims. When the daemon grows a state-aware generator this hook is the seam
 * to swap.
 *
 * ## No state, no chips
 *
 * If none of the three queries yields anything, this returns an empty list and
 * position 3 renders nothing. That is the honest outcome and §4 permits it —
 * "up to 5". Backfilling with generic copy is the exact move being removed.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  calendarDayGetOptions,
  missionsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { PROMPT_CHIP_CAP } from "@/domains/chat/home-canvas/home-canvas-model";

/** Same safety-net cadence HQ uses, so the chips cannot lag the deck. */
const POLL_MS = 60_000;

/**
 * Which real row a chip came from.
 *
 * Glyphs match HQ's vocabulary (`hq-tiers.tsx` LANE_META) so the same state
 * wears the same mark on both surfaces — and so the chips are told apart by a
 * glyph rather than a tint (§8: no colour-only state).
 */
export type CanvasPromptSource = "needs_you" | "free_block" | "mission";

export const PROMPT_SOURCE_GLYPH: Record<CanvasPromptSource, string> = {
  needs_you: "‖",
  free_block: "◱",
  mission: "◎",
};

export interface CanvasPrompt {
  /** Stable per source row, so React keys survive a refetch. */
  id: string;
  /** Chip face. Short — it sits in a wrap row, not a card. */
  label: string;
  /** What lands in the composer. Written in the user's voice. */
  prompt: string;
  source: CanvasPromptSource;
  /**
   * The id of the row this chip was built from — work item, mission, or the
   * literal `"today"` for the calendar block.
   *
   * Not decoration: it is what makes "derived from real state" checkable
   * instead of claimed, and it is the field the daemon starters never had.
   */
  sourceId: string;
}

/** Trim a row title down to chip length without lying about where it ends. */
function shorten(title: string, max = 34): string {
  const t = title.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "2h 30m" · "45m". Never rounds up into a block that does not exist. */
function blockLength(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "2:30pm" in the viewer's locale, from an ISO instant. */
function clock(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface CanvasPromptsResult {
  prompts: CanvasPrompt[];
  /**
   * True while every source is still loading and none has answered. The chips
   * row renders nothing rather than flashing a shorter set first.
   */
  isPending: boolean;
}

/**
 * Build the chips.
 *
 * Order is urgency, not variety: a parked decision beats a mission beats an
 * empty afternoon. The cap comes off the manifest ({@link PROMPT_CHIP_CAP}),
 * so §4's "up to 5" has exactly one home.
 */
export function useCanvasPrompts(
  assistantId: string | null,
): CanvasPromptsResult {
  const enabled = Boolean(assistantId);
  const path = { assistant_id: assistantId ?? "" };

  // The needs-you store — the same query the rail badge and HQ read.
  const review = useQuery({
    ...workitemsGetOptions({ path, query: { status: "awaiting_review" } }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  // Today's shape. `largestFreeBlock` is the daemon's own arithmetic over busy
  // commitments — recomputing it here would be a second opinion on a number
  // HQ already draws.
  const day = useQuery({
    ...calendarDayGetOptions({ path }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 30_000,
  });

  const missions = useQuery({
    ...missionsGetOptions({ path }),
    enabled,
    refetchInterval: POLL_MS,
    staleTime: 15_000,
  });

  return useMemo(() => {
    if (!enabled) return { prompts: [], isPending: false };

    const out: CanvasPrompt[] = [];

    // ① Things waiting on a decision. Titles only — the chip hands the item to
    //    the composer, it does not become a second review queue (that is the
    //    rail's and HQ's job, and duplicating it is what §4 removed).
    for (const item of review.data?.items ?? []) {
      const title = item.title?.trim();
      if (!title) continue;
      out.push({
        id: `needs-you:${item.id}`,
        label: shorten(title),
        prompt: `Walk me through "${title}" and tell me what you need from me.`,
        source: "needs_you",
        sourceId: item.id,
      });
    }

    // ② The free block. One chip, only when there is a real one to name.
    const block =
      day.data?.connection.state === "connected"
        ? (day.data.largestFreeBlock ?? null)
        : null;
    if (block && block.minutes >= 30) {
      const from = clock(block.start);
      out.push({
        id: "free-block:today",
        label: `Use my ${blockLength(block.minutes)} free`,
        prompt: from
          ? `I have ${blockLength(block.minutes)} free from ${from} today. What's the best use of it?`
          : `I have ${blockLength(block.minutes)} free today. What's the best use of it?`,
        source: "free_block",
        sourceId: "today",
      });
    }

    // ③ Active missions, strongest first as the daemon returns them.
    for (const mission of missions.data?.missions ?? []) {
      if (mission.status !== "active") continue;
      const title = mission.title?.trim();
      if (!title) continue;
      out.push({
        id: `mission:${mission.id}`,
        label: shorten(title),
        prompt: `Where is "${title}" right now, and what's the next move?`,
        source: "mission",
        sourceId: mission.id,
      });
    }

    const anyAnswered =
      review.isSuccess ||
      day.isSuccess ||
      missions.isSuccess ||
      review.isError ||
      day.isError ||
      missions.isError;

    return {
      prompts: out.slice(0, PROMPT_CHIP_CAP),
      isPending: !anyAnswered,
    };
  }, [
    enabled,
    review.data,
    review.isSuccess,
    review.isError,
    day.data,
    day.isSuccess,
    day.isError,
    missions.data,
    missions.isSuccess,
    missions.isError,
  ]);
}
