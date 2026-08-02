/**
 * Position 3 — the prompts. **Two kinds, and the order between them matters.**
 *
 * 1. **Generic kick-off prompts** ({@link GENERIC_PROMPTS}) are the visible
 *    default. Draft, plan, research, brief me. They depend on nothing, so they
 *    render on a brand-new account with an empty daemon.
 * 2. **Context-rich suggestions** are derived from real state — an
 *    `awaiting_review` item, today's largest free block, an active mission —
 *    and are **hidden behind a control**, revealed on demand.
 *
 * ## Why generic is the default and context is the reward
 *
 * A cold account has no context. A context-only surface is therefore empty at
 * exactly the moment a new user first sees it — the one moment the canvas has
 * to prove there is something to do here. Generic prompts always work; context
 * is what the surface earns once Cue has read something. Putting the derived
 * set behind a disclosure keeps the canvas honest in both directions: the cold
 * user gets four real starting points, and the returning user gets suggestions
 * that name their own rows.
 *
 * An earlier pass made every chip state-derived and deleted the generic set.
 * That is the failure this ordering exists to prevent, and it is why the two
 * kinds are different *types* below rather than a flag on one shape.
 *
 * ## A context suggestion is never fabricated
 *
 * {@link ContextPrompt.sourceId} is a required `string`: a context suggestion
 * cannot be constructed without the id of the row it came from. A
 * {@link GenericPrompt} carries `sourceId: null` and claims no provenance at
 * all. There is no third case — nothing in this module can mint a suggestion
 * that *looks* state-derived without a row behind it.
 *
 * When the three queries yield nothing, {@link CanvasPromptsResult.context} is
 * empty and the reveal says so in words ("nothing is waiting on you") rather
 * than backfilling with copy. When a query *failed*,
 * {@link CanvasPromptsResult.couldNotRead} is set and the reveal says *that*
 * instead — "I couldn't read your work" is a different sentence from "nothing",
 * and collapsing the two is the most expensive lie this surface could tell.
 *
 * ## What this replaces, and why
 *
 * The canvas used to render two prompt sets:
 *
 * - **Six capability pills** hardcoded in `chat-launcher.tsx`. Four of those
 *   six survive here as {@link GENERIC_PROMPTS} — they were never the problem;
 *   the problem was that there was nothing else, and that six of them plus
 *   needs-you cards plus a recents row is not a calm canvas.
 * - **Four daemon starters** from `GET /conversation-starters`. These *look*
 *   state-derived and are not: the generator
 *   (`assistant/src/memory/job-handlers/conversation-starters.ts`) prompts an
 *   LLM with the memory graph, the skill catalogue and the wall clock — and
 *   never reads work items, approvals, missions or the calendar. Nothing in the
 *   row carries provenance either: the API returns `{id,label,prompt,category,
 *   batch}` and `sourceMemoryKinds` never leaves the daemon, so a chip cannot
 *   be resolved back to anything. Generic copy that admits it is generic beats
 *   generated copy wearing state's clothes.
 *
 * Deriving the context set here rather than in the daemon is a deliberate
 * trade: it costs three queries the rail and HQ already make (react-query
 * dedupes them by key, so no extra request) and buys a suggestion that can be
 * checked against the row it claims. When the daemon grows a state-aware
 * generator this hook is the seam to swap.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  calendarDayGetOptions,
  missionsGetOptions,
  workitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";

import { PROMPT_CHIP_ROW_CAP } from "@/domains/chat/home-canvas/home-canvas-model";

/** Same safety-net cadence HQ uses, so the chips cannot lag the deck. */
const POLL_MS = 60_000;

/**
 * Which real row a context suggestion came from.
 *
 * Glyphs match HQ's vocabulary (`hq-tiers.tsx` LANE_META) so the same state
 * wears the same mark on both surfaces — and so the chips are told apart by a
 * glyph rather than a tint (§8: no colour-only state).
 */
export type CanvasContextSource = "needs_you" | "free_block" | "mission";

/** Every chip source, including the generic set that reads no state at all. */
export type CanvasPromptSource = "generic" | CanvasContextSource;

export const PROMPT_SOURCE_GLYPH: Record<CanvasPromptSource, string> = {
  // `✨` is §8's "made, not read" mark. A generic chip wears it so the two
  // kinds are distinguishable at a glance without a tint: `✨` is an offer,
  // `‖ ◱ ◎` are things Cue actually read.
  generic: "✨",
  needs_you: "‖",
  free_block: "◱",
  mission: "◎",
};

interface CanvasPromptBase {
  /** Stable per source row, so React keys survive a refetch. */
  id: string;
  /** Chip face. Short — it sits in a wrap row, not a card. */
  label: string;
  /**
   * What gets sent. Written in the user's voice, and always a **complete**
   * sentence: selecting a chip submits immediately (`handleSelectStarter`), so
   * a trailing fragment like "Draft a reply to " would send half a thought.
   */
  prompt: string;
}

/** A cold-start offer. Depends on no state and claims no provenance. */
export interface GenericPrompt extends CanvasPromptBase {
  kind: "generic";
  source: "generic";
  /** Always `null` — a generic prompt is not derived from a row and says so. */
  sourceId: null;
}

/** A suggestion built from one real row, which it names. */
export interface ContextPrompt extends CanvasPromptBase {
  kind: "context";
  source: CanvasContextSource;
  /**
   * The id of the row this suggestion was built from — work item, mission, or
   * the literal `"today"` for the calendar block.
   *
   * Required, and that is the point: it is what makes "derived from real
   * state" checkable instead of claimed, and it is the field the daemon
   * starters never had.
   */
  sourceId: string;
}

export type CanvasPrompt = GenericPrompt | ContextPrompt;

/**
 * The visible default — four things anyone can start from cold.
 *
 * Deliberately four, not five: §4 allows position 3 five children and the
 * reveal control spends one of them ({@link PROMPT_CHIP_ROW_CAP}). v15's frame
 * shows four prompts and a sentence, which is the same arithmetic.
 */
export const GENERIC_PROMPTS: readonly GenericPrompt[] = [
  {
    kind: "generic",
    source: "generic",
    sourceId: null,
    id: "generic:draft",
    label: "Draft something",
    prompt:
      "I need to draft something. Ask me what it is and who it's for, then write it.",
  },
  {
    kind: "generic",
    source: "generic",
    sourceId: null,
    id: "generic:plan",
    label: "Plan my day",
    prompt: "Plan my day from my calendar and inbox.",
  },
  {
    kind: "generic",
    source: "generic",
    sourceId: null,
    id: "generic:research",
    label: "Research something",
    prompt:
      "I want to research something. Ask me for the topic, then dig in and report back.",
  },
  {
    kind: "generic",
    source: "generic",
    sourceId: null,
    id: "generic:brief",
    label: "Brief me",
    prompt: "Brief me on what's important right now.",
  },
];

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
  /** The visible default. Never empty — it reads no state. */
  generic: readonly GenericPrompt[];
  /** What the control reveals. Empty is a real, sayable answer. */
  context: readonly ContextPrompt[];
  /**
   * True while every source is still loading and none has answered. The reveal
   * says "still reading" rather than "nothing", which would be a claim we have
   * not earned yet.
   */
  isPending: boolean;
  /**
   * True when **any** source failed.
   *
   * Deliberately "any", not "all": with one store unreadable we cannot say
   * "nothing is waiting on you", because the thing waiting on you may be in
   * the store that failed. Whatever suggestions we *do* have are still shown —
   * they came from rows that really answered.
   */
  couldNotRead: boolean;
}

/**
 * Build the prompts.
 *
 * Context order is urgency, not variety: a parked decision beats a mission
 * beats an empty afternoon. The cap comes off the manifest
 * ({@link PROMPT_CHIP_ROW_CAP}), so §4's "up to 5" has exactly one home.
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
    // No assistant is not an error and not "nothing" — there is simply no
    // store to read. The generic set still stands, because it never needed one.
    if (!enabled)
      return {
        generic: GENERIC_PROMPTS,
        context: [],
        isPending: false,
        couldNotRead: false,
      };

    const out: ContextPrompt[] = [];

    // ① Things waiting on a decision. Titles only — the chip hands the item to
    //    the composer, it does not become a second review queue (that is the
    //    rail's and HQ's job, and duplicating it is what §4 removed).
    for (const item of review.data?.items ?? []) {
      const title = item.title?.trim();
      if (!title) continue;
      out.push({
        kind: "context",
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
        kind: "context",
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
        kind: "context",
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
      generic: GENERIC_PROMPTS,
      context: out.slice(0, PROMPT_CHIP_ROW_CAP),
      isPending: !anyAnswered,
      couldNotRead: review.isError || day.isError || missions.isError,
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
