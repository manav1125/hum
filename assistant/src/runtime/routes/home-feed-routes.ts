/**
 * Home activity feed routes.
 *
 * Exposes the three endpoints the macOS Home page uses to render and
 * interact with the activity feed:
 *
 *   - `GET  /v1/home/feed`                         — read + filter
 *   - `PATCH /v1/home/feed/:id`                    — mark seen / acted_on
 *   - `POST  /v1/home/feed/:id/actions/:actionId`  — trigger an action
 *
 * The routes are always available — the `home-feed` feature flag gates
 * the client rendering path only, so the daemon surface can ship ahead
 * of the rollout and client versions can adopt independently of
 * feature-flag timing.
 *
 * All persistence goes through `readHomeFeed` / `patchFeedItemStatus`
 * in `home/feed-writer.ts`; this module does not touch the on-disk
 * file directly. The writer already applies the TTL filter on read
 * and owns all SSE publication, so the route handlers stay pure
 * shape + validation + banner computation.
 */

import { z } from "zod";

import {
  type FeedItem,
  FeedItemSchema,
  type FeedItemStatus,
  HomeFeedResponseSchema,
} from "../../api/responses/home.js";
import { buildDailyActionBoard } from "../../home/action-board.js";
import { draftReplyForMessage } from "../../home/auto-draft.js";
import {
  allowsBackground,
  classifyFeedActionMode,
  type FeedActionMode,
  resolveDefaultMode,
} from "../../home/feed-action-mode.js";
import { patchFeedItemStatus, readHomeFeed } from "../../home/feed-writer.js";
import { revalidateHomeContentInBackground } from "../../home/home-content-refresh.js";
import { getPersonalizedGreeting } from "../../home/home-greeting.js";
import { getImpactSummary } from "../../home/impact-store.js";
import { getSuggestedPrompts } from "../../home/suggested-prompts.js";
import {
  mergeWorkItemsIntoFeed,
  WORK_ITEM_FEED_PREFIX,
  workItemToFeedItem,
} from "../../home/work-item-feed.js";
import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { getAutonomyPolicy } from "../../permissions/autonomy-policy-reader.js";
import { createTask } from "../../tasks/task-store.js";
import { getLogger } from "../../util/logger.js";
import { broadcastWorkItemStatus } from "../../work-items/work-item-runner.js";
import {
  createWorkItem,
  findActiveWorkItemBySource,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { triageAndMaybeAutoRunWorkItem } from "../../work-items/work-item-triage.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { runBackgroundJob } from "../background-job-runner.js";
import { BadRequestError, InternalError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("home-feed-routes");

// ---------------------------------------------------------------------------
// Response / request schemas
// ---------------------------------------------------------------------------

const patchFeedItemRequestSchema = z.object({
  status: z.enum(["new", "seen", "acted_on", "dismissed"]),
});

const listHomeFeedRequestSchema = z.object({
  includeDismissed: z.boolean().optional(),
  statuses: z
    .array(z.enum(["new", "seen", "acted_on", "dismissed"]))
    .optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  urgencies: z.array(z.enum(["low", "medium", "high", "critical"])).optional(),
  categories: z
    .array(
      z.enum([
        "security",
        "scheduling",
        "background",
        "email",
        "slack",
        "telegram",
        "whatsapp",
        "chat",
        "task",
        "system",
      ]),
    )
    .optional(),
  conversationId: z.string().optional(),
  fromAssistant: z.boolean().optional(),
  noteworthy: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const listHomeFeedResponseSchema = z.object({
  items: z.array(FeedItemSchema),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct testing)
// ---------------------------------------------------------------------------

export function computeGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Welcome back";
}

export function formatRelativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (seconds < 172800) return "yesterday";
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Resolve a feed item by id, looking first at the on-disk feed and falling
 * back to a synthesized work-item card. Work-item cards are computed in the
 * GET handler (not persisted), so `POST /actions/:actionId` must reconstruct
 * the same card to find its action — otherwise a one-click on a work-item
 * card would 404.
 */
function resolveFeedItemById(itemId: string): FeedItem | undefined {
  const onDisk = readHomeFeed().items.find((i) => i.id === itemId);
  if (onDisk) return onDisk;

  if (itemId.startsWith(WORK_ITEM_FEED_PREFIX)) {
    const workItemId = itemId.slice(WORK_ITEM_FEED_PREFIX.length);
    const wi = getWorkItem(workItemId);
    if (wi) return workItemToFeedItem(wi, new Date());
  }
  return undefined;
}

function timeAwayBucket(seconds: number): string {
  if (seconds < 1800) return "<1800";
  if (seconds < 14400) return "1800-14400";
  if (seconds < 43200) return "14400-43200";
  if (seconds < 86400) return "43200-86400";
  return ">=86400";
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Annotate each feed item's actions with their smart-default execution mode +
 * background eligibility, so the client can render the action split-button
 * without re-deriving the autonomy policy. Pure given a resolved policy.
 */
function annotateFeedActionModes(
  items: FeedItem[],
  policy: Awaited<ReturnType<typeof getAutonomyPolicy>>,
): FeedItem[] {
  return items.map((item) => {
    if (!item.actions || item.actions.length === 0) return item;
    return {
      ...item,
      actions: item.actions.map((a) => {
        const cls = classifyFeedActionMode(a);
        return {
          ...a,
          defaultMode: resolveDefaultMode(cls, policy),
          allowBackground: allowsBackground(cls),
        };
      }),
    };
  });
}

export async function handleGetHomeFeed({
  queryParams = {},
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const raw = queryParams.timeAwaySeconds;
  if (raw === undefined) {
    throw new BadRequestError(
      "Missing required query parameter: timeAwaySeconds",
    );
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestError("timeAwaySeconds must be a non-negative integer");
  }
  const timeAwaySeconds = parsed;

  const now = new Date();

  const feed = readHomeFeed();
  // v2 schema dropped per-item `minTimeAway` gating; surface every item
  // and let the client decide what to render based on its own
  // session state. `timeAwaySeconds` survives only to feed the
  // context-banner relative-time label.
  //
  // Union the on-disk feed (action-board + triage cards) with queued
  // work-items mapped to FeedItems, so agent-created work-queue items
  // (the 7 Slack items, etc.) finally surface on Home. Deterministic —
  // no model involved — and deduped against the on-disk feed so an item
  // isn't double-listed. A read here is acceptable: this GET handler
  // stays read-only (the DB read is a pure query, the file read already
  // happens above).
  let filtered: FeedItem[];
  try {
    const queued = listWorkItems({ status: "queued" });
    filtered = mergeWorkItemsIntoFeed(feed.items, queued, now);
  } catch (err) {
    log.warn(
      { err: String(err) },
      "Failed to union work-items into home feed; serving feed-file items only",
    );
    filtered = feed.items;
  }

  // Dismissed cards are the user saying "go away" — they must not resurface
  // on Home. The feed file retains them (for `home/feed/query` with
  // includeDismissed=true and for dedup against re-synthesis), so filter at
  // the read edge, mirroring the default in `handleListHomeFeed`.
  filtered = filtered.filter((item) => item.status !== "dismissed");

  // Stale-while-revalidate: serve whatever is cached right now and kick
  // off a bounded background regeneration of any stale LLM content. The
  // refresh publishes `home_feed_updated` when fresh content lands, so
  // connected clients refetch and the personalized content swaps in.
  // This is the accepted exception to GET-handler idempotency documented
  // in `src/runtime/AGENTS.md` — the handler itself stays read-only and
  // returns immediately with cached/fallback copy.
  revalidateHomeContentInBackground();

  const personalizedGreeting = getPersonalizedGreeting();
  const suggestedPrompts = await getSuggestedPrompts();

  const contextBanner = {
    greeting: personalizedGreeting ?? computeGreeting(now),
    timeAwayLabel: formatRelativeTime(timeAwaySeconds),
    newCount: filtered.filter((i) => i.status === "new").length,
  };

  log.debug(
    {
      timeAwayBucket: timeAwayBucket(timeAwaySeconds),
      totalItems: feed.items.length,
      filteredItems: filtered.length,
      newCount: contextBanner.newCount,
      suggestedPromptsCount: suggestedPrompts.length,
    },
    "GET /v1/home/feed",
  );

  return {
    items: annotateFeedActionModes(filtered, await getAutonomyPolicy()),
    updatedAt: feed.updatedAt,
    contextBanner,
    suggestedPrompts,
  };
}

export async function handlePatchFeedItem({
  pathParams = {},
  body,
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const itemId = pathParams.id;

  const parsed = patchFeedItemRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("Invalid request body");
  }
  const status: FeedItemStatus = parsed.data.status;

  const currentFeed = readHomeFeed();
  const existing = currentFeed.items.find((i) => i.id === itemId);
  if (!existing) {
    // Work-item cards are synthesized in the GET handler, not persisted to
    // the feed file. A status flip on one (e.g. mark "seen") is a UI-only
    // concern — the item's real lifecycle lives in the work-item store — so
    // echo the synthesized card with the requested status instead of 404/500.
    if (itemId.startsWith(WORK_ITEM_FEED_PREFIX)) {
      const card = resolveFeedItemById(itemId);
      if (card) {
        return { ...card, status } as unknown as Record<string, unknown>;
      }
    }
    throw new NotFoundError(`Feed item not found: ${itemId}`);
  }

  const updated = await patchFeedItemStatus(itemId, status);
  if (!updated) {
    log.warn(
      { itemId, status },
      "patchFeedItemStatus returned null despite pre-check — treating as write failure",
    );
    throw new InternalError("Failed to persist feed item status");
  }

  return updated as unknown as Record<string, unknown>;
}

export function handleListHomeFeed({
  body = {},
}: RouteHandlerArgs): Record<string, unknown> {
  const parsed = listHomeFeedRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid list request: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  const params = parsed.data;

  const beforeMs =
    params.before !== undefined ? Date.parse(params.before) : undefined;
  if (beforeMs !== undefined && Number.isNaN(beforeMs)) {
    throw new BadRequestError(
      `Invalid 'before' timestamp; expected ISO-8601 (got "${params.before}")`,
    );
  }
  const afterMs =
    params.after !== undefined ? Date.parse(params.after) : undefined;
  if (afterMs !== undefined && Number.isNaN(afterMs)) {
    throw new BadRequestError(
      `Invalid 'after' timestamp; expected ISO-8601 (got "${params.after}")`,
    );
  }

  // `statuses` is the explicit override. Otherwise default to excluding
  // dismissed unless includeDismissed=true — the assistant's primary use
  // case is "what's still outstanding", so dismissed items are noise
  // unless explicitly requested.
  const statusFilter: Set<FeedItemStatus> | null = params.statuses
    ? new Set(params.statuses)
    : params.includeDismissed
      ? null
      : new Set<FeedItemStatus>(["new", "seen", "acted_on"]);

  const urgencySet = params.urgencies ? new Set(params.urgencies) : null;
  const categorySet = params.categories ? new Set(params.categories) : null;

  const feed = readHomeFeed();

  const filtered = feed.items.filter((item) => {
    if (statusFilter && !statusFilter.has(item.status)) return false;
    if (urgencySet) {
      if (!item.urgency || !urgencySet.has(item.urgency)) return false;
    }
    if (categorySet) {
      if (!item.category || !categorySet.has(item.category)) return false;
    }
    if (
      params.conversationId !== undefined &&
      item.conversationId !== params.conversationId
    )
      return false;
    if (
      params.fromAssistant !== undefined &&
      (item.fromAssistant ?? false) !== params.fromAssistant
    )
      return false;
    if (
      params.noteworthy !== undefined &&
      (item.noteworthy ?? false) !== params.noteworthy
    )
      return false;

    if (beforeMs !== undefined || afterMs !== undefined) {
      const createdMs = Date.parse(item.createdAt);
      if (Number.isNaN(createdMs)) return false;
      if (beforeMs !== undefined && createdMs >= beforeMs) return false;
      if (afterMs !== undefined && createdMs <= afterMs) return false;
    }

    return true;
  });

  const total = filtered.length;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  const items = filtered.slice(offset, offset + limit);

  return {
    items,
    total,
    returned: items.length,
    hasMore: total > offset + items.length,
    updatedAt: feed.updatedAt,
  };
}

/** How long a background home-action agent run may take before timing out. */
const HOME_ACTION_TIMEOUT_MS = 180_000;

const feedActionRequestSchema = z.object({
  // "smart" (default) routes off the autonomy policy; the others force a mode.
  mode: z.enum(["smart", "background", "thread"]).optional(),
});

/**
 * Best-effort channel/source tag for a feed item, for work-item provenance.
 *
 * Normalizes the two provenance shapes the feed carries (matching
 * `work-item-feed.ts#feedItemSourceKey`): action-board channel cards tag
 * `metadata.channel` / `metadata.sourceConversationId`; work-item-derived
 * cards tag `metadata.sourceType` / `metadata.sourceId`. Falling back to the
 * item's `category` / `id` keeps non-channel cards (email, calendar) keyed on
 * something stable. The resolved `(sourceType, sourceId)` is stamped onto the
 * dispatched work item so it carries its real channel instead of a generic
 * "task", and so the dedup guard keys channel commitments per channel/thread.
 */
function feedItemSource(item: FeedItem): {
  sourceType?: string;
  sourceId?: string;
} {
  const md = (item.metadata ?? undefined) as
    | {
        sourceType?: unknown;
        sourceId?: unknown;
        channel?: unknown;
        sourceConversationId?: unknown;
      }
    | undefined;
  const sourceType =
    typeof md?.sourceType === "string"
      ? md.sourceType
      : typeof md?.channel === "string"
        ? md.channel
        : typeof item.category === "string"
          ? item.category
          : undefined;
  const sourceId =
    typeof md?.sourceId === "string"
      ? md.sourceId
      : typeof md?.sourceConversationId === "string"
        ? md.sourceConversationId
        : item.id;
  return {
    ...(sourceType ? { sourceType } : {}),
    ...(sourceId ? { sourceId } : {}),
  };
}

/**
 * Create the parent task + the work-item row for a dispatched feed action.
 * The `work_items.taskId` foreign key requires a real `tasks` row, so we mint
 * a lightweight one per dispatch (the action prompt is its template).
 *
 * Deduplicates against the queue: if an active (queued/running/awaiting_review)
 * work-item already exists for the same commitment — keyed on the feed item's
 * `(sourceType, sourceId)` plus title — the existing item is returned instead
 * of minting a second one. Without this, repeated dispatches of the same feed
 * action (double-taps, client retries, the same commitment card re-surfacing
 * across action-board builds) each created a distinct work-item UUID for one
 * underlying commitment.
 */
function createFeedActionWorkItem(
  item: FeedItem,
  action: { label: string; prompt: string },
) {
  // Prefer the item's own title ("Reply on WordPress guidance…") over the
  // action label ("Run it"/"Draft reply"), which is too generic for the
  // Activity row + the result card.
  const title = item.title?.trim() || action.label;
  const source = feedItemSource(item);

  const existing = findActiveWorkItemBySource({
    title,
    sourceType: source.sourceType ?? null,
    sourceId: source.sourceId ?? null,
  });
  if (existing) {
    log.info(
      {
        workItemId: existing.id,
        status: existing.status,
        title,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      },
      "Feed action reused existing active work item (duplicate enqueue suppressed)",
    );
    return existing;
  }

  const task = createTask({ title, template: action.prompt });
  const workItem = createWorkItem({
    taskId: task.id,
    title,
    notes: action.prompt,
    ...source,
  });
  // Rank the fresh item so the queue is urgency-ordered. Auto-run is skipped:
  // the caller's execution-mode logic (thread/background/needs_you) owns the
  // run decision for feed actions — needs_you items must wait for approval.
  void triageAndMaybeAutoRunWorkItem(workItem.id, { skipAutoRun: true });
  return workItem;
}

/**
 * Trigger a Home feed action. Three execution modes:
 *
 *   - "thread"     — seed a foreground conversation the user drives (the
 *                    original behavior).
 *   - "background" — dispatch an autonomous agent run; show it live in
 *                    Activity → Running, then post a "Done" card back to Home.
 *   - "needs_you"  — queue it but do NOT run; it waits for explicit approval.
 *
 * The default ("smart") picks the mode from the action's category + the
 * user's autonomy policy: research/draft → background, send/money/delete →
 * needs_you (never silently fires), a "never" policy → manual thread.
 */
export async function handlePostFeedAction({
  pathParams = {},
  body,
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const itemId = pathParams.id;
  const actionId = pathParams.actionId;

  const item: FeedItem | undefined = resolveFeedItemById(itemId);
  if (!item) {
    throw new NotFoundError(`Feed item not found: ${itemId}`);
  }

  const action = item.actions?.find((a) => a.id === actionId);
  if (!action) {
    throw new NotFoundError(`Action not found on item ${itemId}: ${actionId}`);
  }

  const parsed = feedActionRequestSchema.safeParse(body ?? {});
  const requestedMode = parsed.success ? parsed.data.mode : undefined;

  // Resolve the effective execution mode.
  let mode: FeedActionMode;
  if (requestedMode === "background") {
    mode = "background";
  } else if (requestedMode === "thread") {
    mode = "thread";
  } else {
    // "smart" (or unspecified): route off the autonomy policy.
    const policy = await getAutonomyPolicy();
    mode = resolveDefaultMode(classifyFeedActionMode(action), policy);
  }

  // ── Thread: seed a foreground conversation the user drives. ──────────
  if (mode === "thread") {
    try {
      const conversation = createConversation({
        title: action.label,
        source: "home-feed",
      });
      await addMessage(
        conversation.id,
        "user",
        JSON.stringify([{ type: "text", text: action.prompt }]),
      );
      return { mode: "thread", conversationId: conversation.id };
    } catch (err) {
      log.warn(
        { err, itemId, actionId },
        "Failed to create conversation from feed action",
      );
      throw new InternalError("Failed to create conversation for feed action");
    }
  }

  // ── Needs you: queue it, but never auto-run. ────────────────────────
  if (mode === "needs_you") {
    const wi = createFeedActionWorkItem(item, action);
    // Broadcast the queued item so SSE-connected clients reflect it in
    // Activity → Queued immediately, rather than waiting for the next poll.
    broadcastWorkItemStatus(wi.id);
    // Retire the originating Home card so it leaves "Needs you" on Home — the
    // commitment has moved into the work queue (Activity → Queued). Without
    // this the card lingers on Home even though "Run it" was clicked, so the
    // click reads as a no-op. The queued work item carries the live state from
    // here on. Skip for synthesized work-item cards (no on-disk row to patch).
    if (!item.id.startsWith(WORK_ITEM_FEED_PREFIX)) {
      void patchFeedItemStatus(item.id, "acted_on");
    }
    log.info(
      { itemId, actionId, workItemId: wi.id },
      "Feed action queued (needs approval)",
    );
    return { mode: "needs_you", workItemId: wi.id };
  }

  // ── Background: dispatch an autonomous run, surface it in Activity. ──
  const wi = createFeedActionWorkItem(item, action);
  updateWorkItem(wi.id, { status: "running" });
  broadcastWorkItemStatus(wi.id);

  // Fire-and-forget — return immediately; the run reports back via the
  // work-item status broadcast + a Home result card.
  void runBackgroundJob({
    jobName: `home-action:${item.id}`,
    source: "home-feed-action",
    prompt: action.prompt,
    systemHint: action.label,
    trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
    callSite: "homeAction",
    timeoutMs: HOME_ACTION_TIMEOUT_MS,
    origin: "task",
    conversationType: "background",
  })
    .then(async (result) => {
      updateWorkItem(wi.id, {
        status: result.ok ? "done" : "failed",
        lastRunConversationId: result.conversationId || null,
        lastRunStatus: result.ok ? "ok" : "failed",
      });
      broadcastWorkItemStatus(wi.id);

      if (result.ok) {
        // Post a "Done" card back to Home. runBackgroundJob already emits an
        // activity.failed card on failure, so we only emit on success.
        await emitNotificationSignal({
          sourceEventName: "activity.complete",
          sourceChannel: "assistant_tool",
          sourceContextId: `home-action:${item.id}`,
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: true,
            visibleInSourceNow: false,
          },
          contextPayload: {
            title: `Done — ${action.label}`,
            summary: `Cue finished "${action.label}" in the background. Open it to review.`,
          },
          dedupeKey: `home-action:${item.id}`,
        });
        // Retire the original card so it doesn't linger next to the result.
        patchFeedItemStatus(item.id, "acted_on");
      }
    })
    .catch((err) => {
      log.warn(
        { err, itemId, workItemId: wi.id },
        "Home action background run failed to dispatch",
      );
      updateWorkItem(wi.id, { status: "failed", lastRunStatus: "failed" });
      broadcastWorkItemStatus(wi.id);
    });

  log.info(
    { itemId, actionId, workItemId: wi.id },
    "Feed action dispatched to background",
  );
  return { mode: "background", workItemId: wi.id };
}

const actionBoardResponseSchema = z.object({
  written: z.number().int().nonnegative(),
  skipped: z.string().optional(),
  emailsScanned: z.number().int().nonnegative(),
  eventsScanned: z.number().int().nonnegative(),
});

export async function handleBuildActionBoard(): Promise<
  Record<string, unknown>
> {
  const result = await buildDailyActionBoard();
  log.info(result, "POST /v1/home/action-board/build");
  return result as unknown as Record<string, unknown>;
}

const draftReplyRequestSchema = z.object({
  messageId: z.string().min(1),
});

const draftReplyResponseSchema = z.object({
  ok: z.boolean(),
  draftId: z.string().optional(),
  threadId: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  error: z.string().optional(),
});

export async function handleDraftReply({
  body,
}: RouteHandlerArgs): Promise<Record<string, unknown>> {
  const parsed = draftReplyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("messageId is required");
  }
  const result = await draftReplyForMessage(parsed.data.messageId);
  log.info(
    { ok: result.ok, draftId: result.draftId },
    "POST /v1/home/draft-reply",
  );
  return result as unknown as Record<string, unknown>;
}

/** Hard cap on a single batch draft run, so a click can't fan out unbounded. */
const MAX_BATCH_DRAFTS = 10;

const draftRepliesResponseSchema = z.object({
  drafted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(
    z.object({
      messageId: z.string(),
      ok: z.boolean(),
      draftId: z.string().optional(),
      subject: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

/**
 * Draft replies for every email card on today's action board (cards that carry
 * a `sourceMessageId`). Explicit, user-invoked, capped — it never runs on its
 * own. Drafts are saved to Gmail Drafts and never sent.
 */
export async function handleDraftRepliesForBoard(): Promise<
  Record<string, unknown>
> {
  const messageIds = readHomeFeed()
    .items.filter((i) => i.id.startsWith("action-board:"))
    .map(
      (i) =>
        (i.metadata as { sourceMessageId?: string } | undefined)
          ?.sourceMessageId,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, MAX_BATCH_DRAFTS);

  const results: Array<{
    messageId: string;
    ok: boolean;
    draftId?: string;
    subject?: string;
    error?: string;
  }> = [];
  for (const messageId of messageIds) {
    const r = await draftReplyForMessage(messageId);
    results.push({
      messageId,
      ok: r.ok,
      ...(r.draftId ? { draftId: r.draftId } : {}),
      ...(r.subject ? { subject: r.subject } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  const drafted = results.filter((r) => r.ok).length;
  log.info(
    { drafted, failed: results.length - drafted },
    "POST /v1/home/draft-replies",
  );
  return { drafted, failed: results.length - drafted, results };
}

const impactResponseSchema = z.object({
  rangeDays: z.number().int().positive(),
  hoursSaved: z.number().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  byCategory: z.array(
    z.object({
      category: z.string(),
      count: z.number().int().nonnegative(),
      hours: z.number().nonnegative(),
    }),
  ),
  byDay: z.array(z.number().nonnegative()),
  recent: z.array(
    z.object({
      detail: z.string(),
      category: z.string(),
      at: z.string(),
    }),
  ),
});

export function handleGetImpact({
  queryParams = {},
}: RouteHandlerArgs): Record<string, unknown> {
  const raw = queryParams.rangeDays;
  let rangeDays = 7;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 365) {
      rangeDays = parsed;
    }
  }
  return getImpactSummary(rangeDays) as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "get_home_feed",
    endpoint: "home/feed",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetHomeFeed,
    summary: "Get home activity feed",
    description:
      "Return the current Home activity feed with TTL + time-away filtering applied. Also returns a context banner (greeting, relative time-away label, new-item count).",
    tags: ["home"],
    queryParams: [
      {
        name: "timeAwaySeconds",
        type: "integer",
        required: true,
        description:
          "Seconds since the user was last active in the client. Used to compute the context-banner relative-time label.",
      },
    ],
    responseBody: HomeFeedResponseSchema,
  },
  {
    operationId: "patch_home_feed_item",
    endpoint: "home/feed/:id",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePatchFeedItem,
    summary: "Patch home feed item status",
    description:
      "Update the `status` field of a single feed item (e.g. mark it seen or acted_on). Returns the updated item on success, 404 if the item does not exist, 500 if the underlying write fails.",
    tags: ["home"],
    requestBody: patchFeedItemRequestSchema,
    responseBody: FeedItemSchema,
    additionalResponses: {
      "404": { description: "Feed item not found" },
      "500": { description: "Failed to persist feed item status" },
    },
  },
  {
    operationId: "list_home_feed",
    endpoint: "home/feed/query",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleListHomeFeed,
    summary: "List home feed items with filters",
    description:
      "Return home feed items filtered by status, urgency, category, conversation, and date range. Defaults to excluding dismissed items. Used by the assistant CLI to inspect what notifications have been surfaced to the user.",
    tags: ["home"],
    requestBody: listHomeFeedRequestSchema,
    responseBody: listHomeFeedResponseSchema,
  },
  {
    operationId: "build_action_board",
    endpoint: "home/action-board/build",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleBuildActionBoard,
    summary: "Build the daily action board (all streams)",
    description:
      "Gather connected data across ALL streams (Gmail unread + today's Calendar + connected messaging channels: Slack/Telegram/WhatsApp), synthesize one cross-stream prioritized action list, and write the cards to the Home feed. Idempotent per day. Returns counts of items written and data scanned. Path kept stable for existing callers.",
    tags: ["home"],
    responseBody: actionBoardResponseSchema,
  },
  {
    operationId: "draft_reply",
    endpoint: "home/draft-reply",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleDraftReply,
    summary: "Auto-draft a reply to an email",
    description:
      "Compose a reply to the given Gmail message in the user's voice and save it to Drafts (threaded, never sent). Returns the draft id.",
    tags: ["home"],
    requestBody: draftReplyRequestSchema,
    responseBody: draftReplyResponseSchema,
  },
  {
    operationId: "get_impact",
    endpoint: "home/impact",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleGetImpact,
    summary: "Get the weekly impact recap",
    description:
      "Aggregate recorded impact events (drafts, triage, …) over the last rangeDays (default 7) into hours-saved, task count, by-category breakdown, and a recent-activity list for the Impact / Home surfaces.",
    tags: ["home"],
    queryParams: [
      {
        name: "rangeDays",
        type: "integer",
        required: false,
        description: "Window in days (1–365, default 7).",
      },
    ],
    responseBody: impactResponseSchema,
  },
  {
    operationId: "draft_replies_for_board",
    endpoint: "home/draft-replies",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleDraftRepliesForBoard,
    summary: "Auto-draft replies for all action-board emails",
    description:
      "Compose reply drafts (saved to Drafts, never sent) for every email card on today's action board. Explicit, user-invoked, capped at 10. Returns per-message results.",
    tags: ["home"],
    responseBody: draftRepliesResponseSchema,
  },
  {
    operationId: "trigger_home_feed_action",
    endpoint: "home/feed/:id/actions/:actionId",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handlePostFeedAction,
    summary: "Trigger home feed action",
    description:
      "Execute a feed action. `mode` selects how it runs: 'smart' (default) routes off the action's category + the autonomy policy; 'background' dispatches an autonomous run (shown in Activity, result card posted to Home); 'thread' seeds a foreground conversation. Returns the resolved mode plus a `conversationId` (thread) or `workItemId` (background/needs_you).",
    tags: ["home"],
    requestBody: feedActionRequestSchema,
    responseBody: z.object({
      mode: z.enum(["thread", "background", "needs_you"]),
      conversationId: z.string().optional(),
      workItemId: z.string().optional(),
    }),
    additionalResponses: {
      "404": { description: "Feed item or action not found" },
      "500": { description: "Failed to dispatch feed action" },
    },
  },
];
