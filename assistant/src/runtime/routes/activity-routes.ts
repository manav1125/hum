/**
 * Unified Mission Control read model — op `activity_list`.
 *
 * A single server-side projection (docs/MISSION_CONTROL.md §2.2/§3 P3) that
 * UNIONS the existing activity stores into one `ActivityItem[]`, so the client
 * makes ONE call instead of the seven separate queries the five lanes used to
 * fan out. This is a read-model only: every store is read READ-ONLY, nothing is
 * mutated, and the row shape is normalized into lanes + a canonical control set
 * that mirrors exactly what the Activity section components wire to today.
 *
 * Sources unioned (all read-only):
 *   - work-items  (`work-item-store`)          → in_progress / scheduled(queued) / done / awaiting_you
 *   - home feed   (`feed-writer` + `work-item-feed`) → inbound
 *   - pending interactions (`pending-interactions`)  → awaiting_you
 *   - schedules   (`schedule-store`)           → scheduled
 *   - watchers    (`watcher-store`)            → scheduled
 *   - sequences   (`sequence/store`)           → scheduled
 *   - subagents   (`subagent/manager`)         → in_progress / done
 *
 * Dedup: a running work-item that also appears as a feed card (same underlying
 * object) collapses to ONE `ActivityItem` — the work-item projection wins
 * because it carries the live controls. The feed→work-item bridge id convention
 * (`mergeWorkItemsIntoFeed` writes `wi-<workItemId>` feed ids) is used to detect
 * the overlap.
 */

import type { FeedItem } from "../../home/feed-types.js";
import { readHomeFeed } from "../../home/feed-writer.js";
import { mergeWorkItemsIntoFeed } from "../../home/work-item-feed.js";
import { listSchedules } from "../../schedule/schedule-store.js";
import { listSequences } from "../../sequence/store.js";
import { getSubagentManager } from "../../subagent/index.js";
import type { SubagentState } from "../../subagent/types.js";
import { TERMINAL_STATUSES } from "../../subagent/types.js";
import { getLogger } from "../../util/logger.js";
import { listWatchers } from "../../watcher/watcher-store.js";
import {
  dedupeTerminalWorkItemsForDisplay,
  listWorkItems,
  type WorkItem,
} from "../../work-items/work-item-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getAll as getAllPendingInteractions } from "../pending-interactions.js";
import type { RouteDefinition } from "./types.js";
import {
  extractWorkItemResult,
  resolveWorkItemRunConversationId,
} from "./work-items-routes.js";

const log = getLogger("activity-routes");

// ---------------------------------------------------------------------------
// The unified object (docs/MISSION_CONTROL.md §2.2)
// ---------------------------------------------------------------------------

export type ActivityLane =
  | "inbound"
  | "awaiting_you"
  | "in_progress"
  | "scheduled"
  | "done";

export type ActivityKind =
  | "work_item"
  | "feed"
  | "interaction"
  | "schedule"
  | "watcher"
  | "sequence"
  | "subagent"
  | "heartbeat";

export type ActivityUrgency = "critical" | "high" | "medium" | "low";

export interface ActivityControl {
  id: string;
  label: string;
  /**
   * Daemon-relative path (e.g. `/v1/work-items/<id>/run`). The web client
   * prefixes `/v1/assistants/{assistant_id}` via the gateway. The `:id`
   * placeholder is already substituted with the concrete id.
   */
  endpoint: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
}

export interface ActivityResult {
  summary: string;
  highlights: string[];
  conversationId?: string;
}

export interface ActivityItem {
  /** Stable, prefixed by kind: "wi:", "feed:", "sub:", "sched:", … */
  id: string;
  kind: ActivityKind;
  lane: ActivityLane;
  title: string;
  summary?: string;
  source: {
    channel?: string;
    provenance: string;
    conversationId?: string;
  };
  status: string;
  urgency: ActivityUrgency;
  controls: ActivityControl[];
  result?: ActivityResult;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Canonical control set — mirrors the Activity section components' endpoints.
// Keep these in lockstep with apps/web/src/domains/activity/sections/*.
// ---------------------------------------------------------------------------

function runWorkItemControl(id: string): ActivityControl {
  return {
    id: "run",
    label: "Run now",
    endpoint: `/v1/work-items/${id}/run`,
    method: "POST",
  };
}

function cancelWorkItemControl(id: string): ActivityControl {
  return {
    id: "cancel",
    label: "Cancel",
    endpoint: `/v1/work-items/${id}/cancel`,
    method: "POST",
  };
}

function outputWorkItemControl(id: string): ActivityControl {
  return {
    id: "output",
    label: "Output",
    endpoint: `/v1/work-items/${id}/output`,
    method: "GET",
  };
}

function approveInteractionControl(): ActivityControl {
  // Approvals resolve by requestId via the standalone /v1/confirm endpoint
  // (decision in the request body). The control points at the endpoint; the
  // client supplies `{ requestId, decision: "allow" }`.
  return {
    id: "approve",
    label: "Approve",
    endpoint: `/v1/confirm`,
    method: "POST",
  };
}

function declineInteractionControl(): ActivityControl {
  return {
    id: "decline",
    label: "Decline",
    endpoint: `/v1/confirm`,
    method: "POST",
  };
}

function runScheduleControl(id: string): ActivityControl {
  return {
    id: "run",
    label: "Run now",
    endpoint: `/v1/schedules/${id}/run`,
    method: "POST",
  };
}

function toggleScheduleControl(id: string, enabled: boolean): ActivityControl {
  return {
    id: enabled ? "pause" : "resume",
    label: enabled ? "Pause" : "Resume",
    endpoint: `/v1/schedules/${id}/toggle`,
    method: "POST",
  };
}

function cancelScheduleControl(id: string): ActivityControl {
  return {
    id: "cancel",
    label: "Cancel",
    endpoint: `/v1/schedules/${id}/cancel`,
    method: "POST",
  };
}

function watcherDigestControl(): ActivityControl {
  return {
    id: "digest",
    label: "Digest",
    endpoint: `/v1/watchers/digest`,
    method: "POST",
  };
}

function pauseSequenceControl(): ActivityControl {
  return {
    id: "pause",
    label: "Pause",
    endpoint: `/v1/sequences/pause`,
    method: "POST",
  };
}

function resumeSequenceControl(): ActivityControl {
  return {
    id: "resume",
    label: "Resume",
    endpoint: `/v1/sequences/resume`,
    method: "POST",
  };
}

function abortSubagentControl(id: string): ActivityControl {
  return {
    id: "abort",
    label: "Abort",
    endpoint: `/v1/subagents/${id}/abort`,
    method: "POST",
  };
}

// ---------------------------------------------------------------------------
// Per-store projections (read-only)
// ---------------------------------------------------------------------------

const TERMINAL_WORK_ITEM_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
  "archived",
]);

function isoFromEpochMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

/** Map a work-item to its lane. */
function workItemLane(item: WorkItem): ActivityLane {
  switch (item.status) {
    case "running":
      return "in_progress";
    case "awaiting_review":
      return "awaiting_you";
    case "queued":
      return "scheduled";
    case "done":
    case "failed":
    case "cancelled":
    case "archived":
      return "done";
    default:
      return "in_progress";
  }
}

function workItemUrgency(item: WorkItem): ActivityUrgency {
  if (item.status === "failed") return "high";
  if (item.status === "awaiting_review") return "high";
  if (item.priorityTier <= 0) return "high";
  if (item.priorityTier === 1) return "medium";
  return "low";
}

function projectWorkItem(item: WorkItem, includeResult: boolean): ActivityItem {
  const lane = workItemLane(item);

  const controls: ActivityControl[] = [];
  switch (lane) {
    case "in_progress":
      controls.push(
        outputWorkItemControl(item.id),
        cancelWorkItemControl(item.id),
      );
      break;
    case "scheduled":
      // queued work-items: runnable + cancellable
      controls.push(
        runWorkItemControl(item.id),
        cancelWorkItemControl(item.id),
      );
      break;
    case "awaiting_you":
      controls.push(outputWorkItemControl(item.id));
      break;
    case "done":
      // re-runnable
      controls.push(runWorkItemControl(item.id));
      break;
    default:
      break;
  }

  // Done items carry an inline result via the shared extractor. Each extraction
  // is a conversation read, so the caller bounds this to the most-recent few
  // terminal items (see buildActivityList) — never every historical work-item.
  let result: ActivityResult | undefined;
  if (includeResult && TERMINAL_WORK_ITEM_STATUSES.has(item.status)) {
    const { conversationId } = resolveWorkItemRunConversationId(item);
    if (conversationId) {
      try {
        const extracted = extractWorkItemResult(conversationId);
        if (extracted.summary || extracted.highlights.length > 0) {
          result = {
            summary: extracted.summary,
            highlights: extracted.highlights,
            conversationId: extracted.conversationId,
          };
        }
      } catch (err) {
        log.warn(
          { err: String(err), workItemId: item.id },
          "Failed to extract work-item result for done lane",
        );
      }
    }
  }

  return {
    id: `wi:${item.id}`,
    kind: "work_item",
    lane,
    title: item.title,
    summary: item.notes ?? undefined,
    source: {
      channel: item.sourceType ?? undefined,
      provenance: item.sourceType
        ? `work-item · ${item.sourceType}`
        : "work-item",
      conversationId: item.lastRunConversationId ?? undefined,
    },
    status: item.status,
    urgency: workItemUrgency(item),
    controls,
    result,
    createdAt: isoFromEpochMs(item.createdAt),
    updatedAt: isoFromEpochMs(item.updatedAt),
  };
}

function feedUrgency(item: FeedItem): ActivityUrgency {
  return item.urgency ?? "medium";
}

function projectFeedItem(item: FeedItem): ActivityItem {
  return {
    id: `feed:${item.id}`,
    kind: "feed",
    lane: "inbound",
    title: item.title ?? item.summary,
    summary: item.summary,
    source: {
      channel: item.category,
      provenance: item.fromAssistant ? "assistant" : "action-board",
      conversationId: item.conversationId,
    },
    status: item.status,
    urgency: feedUrgency(item),
    // Inbound cards drive their actions through the home-feed action endpoint,
    // which is feed-action-specific (mode-aware). The lane body still renders
    // Home's feed card, so we leave `controls` empty here rather than inventing
    // a non-canonical control surface.
    controls: [],
    createdAt: item.createdAt,
    updatedAt: item.timestamp,
  };
}

function interactionTitle(kind: string, toolName?: string): string {
  if (toolName) return `Approve: ${toolName}`;
  switch (kind) {
    case "confirmation":
    case "acp_confirmation":
      return "Approval requested";
    case "secret":
      return "Secret requested";
    case "question":
      return "Question";
    default:
      return "Awaiting you";
  }
}

interface PendingInteractionRow {
  requestId: string;
  conversationId: string;
  kind: string;
  confirmationDetails?: { toolName?: string; riskLevel?: string };
}

function projectInteraction(row: PendingInteractionRow): ActivityItem {
  const toolName = row.confirmationDetails?.toolName;
  const risk = row.confirmationDetails?.riskLevel;
  const urgency: ActivityUrgency = risk === "high" ? "critical" : "high";
  const now = new Date().toISOString();

  return {
    id: `int:${row.requestId}`,
    kind: "interaction",
    lane: "awaiting_you",
    title: interactionTitle(row.kind, toolName),
    summary: toolName ? `Tool: ${toolName}` : undefined,
    source: {
      provenance: `interaction · ${row.kind}`,
      conversationId: row.conversationId,
    },
    status: row.kind,
    urgency,
    controls: [approveInteractionControl(), declineInteractionControl()],
    createdAt: now,
    updatedAt: now,
  };
}

interface ScheduleRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: string;
  message: string;
  nextRunAt: number;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdFromConversationId: string | null;
}

function projectSchedule(s: ScheduleRow): ActivityItem {
  return {
    id: `sched:${s.id}`,
    kind: "schedule",
    lane: "scheduled",
    title: s.name,
    summary: s.description || s.message || undefined,
    source: {
      provenance: "schedule",
      conversationId: s.createdFromConversationId ?? undefined,
    },
    status: s.status,
    urgency: "low",
    controls: [
      runScheduleControl(s.id),
      toggleScheduleControl(s.id, s.enabled),
      cancelScheduleControl(s.id),
    ],
    createdAt: isoFromEpochMs(s.createdAt),
    updatedAt: isoFromEpochMs(s.updatedAt),
  };
}

interface WatcherRow {
  id: string;
  name: string;
  providerId: string;
  status: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

function projectWatcher(w: WatcherRow): ActivityItem {
  return {
    id: `watch:${w.id}`,
    kind: "watcher",
    lane: "scheduled",
    title: w.name,
    summary: `Watching ${w.providerId}`,
    source: {
      provenance: `watcher · ${w.providerId}`,
      conversationId: w.conversationId ?? undefined,
    },
    status: w.status,
    urgency: "low",
    controls: [watcherDigestControl()],
    createdAt: isoFromEpochMs(w.createdAt),
    updatedAt: isoFromEpochMs(w.updatedAt),
  };
}

interface SequenceRow {
  id: string;
  name: string;
  description: string | null;
  channel: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

function projectSequence(seq: SequenceRow): ActivityItem {
  const paused = seq.status === "paused";
  return {
    id: `seq:${seq.id}`,
    kind: "sequence",
    lane: "scheduled",
    title: seq.name,
    summary: seq.description ?? `${seq.channel} sequence`,
    source: { provenance: `sequence · ${seq.channel}` },
    status: seq.status,
    urgency: "low",
    controls: paused ? [resumeSequenceControl()] : [pauseSequenceControl()],
    createdAt: isoFromEpochMs(seq.createdAt),
    updatedAt: isoFromEpochMs(seq.updatedAt),
  };
}

function projectSubagent(state: SubagentState): ActivityItem {
  const terminal = TERMINAL_STATUSES.has(state.status);
  const lane: ActivityLane = terminal ? "done" : "in_progress";
  return {
    id: `sub:${state.config.id}`,
    kind: "subagent",
    lane,
    title: state.config.label,
    summary: state.config.objective,
    source: {
      provenance: "subagent",
      conversationId: state.conversationId,
    },
    status: state.status,
    urgency: state.status === "failed" ? "high" : "low",
    controls: terminal ? [] : [abortSubagentControl(state.config.id)],
    createdAt: isoFromEpochMs(state.createdAt),
    updatedAt: isoFromEpochMs(
      state.completedAt ?? state.startedAt ?? state.createdAt,
    ),
  };
}

// ---------------------------------------------------------------------------
// The union handler
// ---------------------------------------------------------------------------

/**
 * Build the whole Mission Control board in one pass. Reads each store
 * READ-ONLY, projects rows into lanes with canonical controls, and dedups the
 * feed↔work-item overlap. Each store is wrapped defensively so one failing
 * store degrades that lane's contribution rather than the whole board.
 */
export function buildActivityList(): {
  items: ActivityItem[];
  counts: Record<ActivityLane, number>;
} {
  const items: ActivityItem[] = [];

  // --- work items (the spine: carries the live controls + results) ---
  let workItems: WorkItem[] = [];
  try {
    // Collapse duplicate terminal work-items before projection so the
    // "Recently done" lane never shows the same finished task twice (same
    // normalized title + same source channel, keeping the most recent).
    // Active items pass through untouched — they still feed the other lanes.
    workItems = dedupeTerminalWorkItemsForDisplay(listWorkItems());
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read work-items");
  }
  // Only the most-recent terminal work-items get an inline result — each
  // extraction is a conversation read, so extracting for every historical
  // work-item makes this O(N) DB reads and times the request out. Bound it to
  // the items the Done lane would actually surface.
  const RESULT_LIMIT = 15;
  const recentTerminalIds = new Set(
    workItems
      .filter((w) => TERMINAL_WORK_ITEM_STATUSES.has(w.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, RESULT_LIMIT)
      .map((w) => w.id),
  );
  for (const wi of workItems) {
    items.push(projectWorkItem(wi, recentTerminalIds.has(wi.id)));
  }

  // Set of work-item ids already projected — used to dedup feed cards that are
  // really the same underlying work-item (mergeWorkItemsIntoFeed emits feed ids
  // of the form `wi-<workItemId>`).
  const workItemIds = new Set(workItems.map((w) => w.id));

  // --- home feed → inbound (deduped against work-items) ---
  try {
    const feed = readHomeFeed();
    let feedItems: FeedItem[] = feed.items;
    try {
      const queued = listWorkItems({ status: "queued" });
      feedItems = mergeWorkItemsIntoFeed(feed.items, queued, new Date());
    } catch {
      // Fall back to on-disk feed items only.
    }
    for (const fi of feedItems) {
      // Dedup: a feed card backed by a work-item (`wi-<id>`) is the same object
      // already projected from the work-item store — skip it.
      const backingId = fi.id.startsWith("wi-") ? fi.id.slice(3) : null;
      if (backingId && workItemIds.has(backingId)) continue;
      items.push(projectFeedItem(fi));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read home feed");
  }

  // --- pending interactions → awaiting_you ---
  try {
    const interactions = getAllPendingInteractions();
    for (const row of interactions) {
      items.push(projectInteraction(row as unknown as PendingInteractionRow));
    }
  } catch (err) {
    log.warn(
      { err: String(err) },
      "activity_list: failed to read pending interactions",
    );
  }

  // --- schedules → scheduled ---
  try {
    const schedules = listSchedules();
    for (const s of schedules) {
      if (s.status === "cancelled") continue;
      items.push(projectSchedule(s as unknown as ScheduleRow));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read schedules");
  }

  // --- watchers → scheduled ---
  try {
    const watchers = listWatchers();
    for (const w of watchers) {
      items.push(projectWatcher(w as unknown as WatcherRow));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read watchers");
  }

  // --- sequences → scheduled ---
  try {
    const sequences = listSequences();
    for (const seq of sequences) {
      if (seq.status === "archived") continue;
      items.push(projectSequence(seq as unknown as SequenceRow));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read sequences");
  }

  // --- subagents → in_progress / done ---
  try {
    const snapshot = getSubagentManager().listAll();
    for (const { state } of snapshot) {
      items.push(projectSubagent(state));
    }
  } catch (err) {
    log.warn({ err: String(err) }, "activity_list: failed to read subagents");
  }

  const counts: Record<ActivityLane, number> = {
    inbound: 0,
    awaiting_you: 0,
    in_progress: 0,
    scheduled: 0,
    done: 0,
  };
  for (const item of items) {
    counts[item.lane] += 1;
  }

  return { items, counts };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "activity_list",
    endpoint: "activity",
    method: "GET",
    // Mirror the other read routes (listWorkItems / listSchedules): a read
    // scope, restricted to actor principals.
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List the unified Mission Control activity board",
    description:
      "Union the work-item, home-feed, pending-interaction, schedule, watcher, " +
      "sequence, and subagent stores into one normalized ActivityItem[] with " +
      "lanes, normalized status, and a canonical control set. Replaces the " +
      "seven separate client queries the Mission Control lanes used to make.",
    tags: ["activity"],
    handler: () => {
      const { items, counts } = buildActivityList();
      return { items, counts };
    },
  },
];
