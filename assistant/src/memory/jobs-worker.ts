import { join } from "node:path";

import { maybeRunDbSnapshot } from "../backup/db-snapshot.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { AssistantConfig } from "../config/types.js";
import {
  runContactMemoryExtraction,
  runContactMemorySweep,
} from "../contacts/contact-memory-extract-job.js";
import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { maintainJob as memoryV3MaintainJob } from "../plugins/defaults/memory-v3-shadow/maintain-job.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import {
  getLastScheduledCleanupEnqueueMs,
  markScheduledCleanupEnqueued,
} from "./cleanup-schedule-state.js";
import { conversationAnalyzeJob } from "./conversation-analyze-job.js";
import { sweepOrphanConversationMemoryTables } from "./conversation-memory-cleanup.js";
import { getMemorySqlite, getSqlite } from "./db-connection.js";
import { maybeRunDbMaintenance } from "./db-maintenance.js";
import { bootstrapFromHistory } from "./graph/bootstrap.js";
import { runConsolidation } from "./graph/consolidation.js";
import { runDecayTick } from "./graph/decay.js";
import { graphExtractJob } from "./graph/extraction-job.js";
import {
  embedGraphNodeJob,
  embedGraphTriggerJob,
} from "./graph/graph-search.js";
import { runNarrativeRefinement } from "./graph/narrative.js";
import { runPatternScan } from "./graph/pattern-scan.js";
import { backfillJob } from "./job-handlers/backfill.js";
import {
  pruneOldActivationLogsJob,
  pruneOldBackgroundConversationsJob,
  pruneOldConversationsJob,
  pruneOldLlmRequestLogsJob,
  pruneOldTraceEventsJob,
} from "./job-handlers/cleanup.js";
import { generateConversationStartersJob } from "./job-handlers/conversation-starters.js";
// ── Per-job-type handlers ──────────────────────────────────────────
import {
  embedAttachmentJob,
  embedMediaJob,
  embedSegmentJob,
  embedSummaryJob,
} from "./job-handlers/embedding.js";
import {
  deleteQdrantVectorsJob,
  rebuildIndexJob,
} from "./job-handlers/index-maintenance.js";
import { mediaProcessingJob } from "./job-handlers/media-processing.js";
import { buildConversationSummaryJob } from "./job-handlers/summarization.js";
import {
  JOB_OUTCOME_UNREPORTED,
  jobCompleted,
  jobEmpty,
  type JobHandlerResult,
  type JobOutcome,
  jobOutcomeFromDetail,
  jobProduced,
  jobProducedOrEmpty,
  jobSkipped,
} from "./job-outcome.js";
import { recordJobOutcome } from "./job-outcome-health.js";
import {
  BackendUnavailableError,
  classifyError,
  RETRY_MAX_ATTEMPTS,
  retryDelayForAttempt,
} from "./job-utils.js";
import { embedConceptPageJob } from "./jobs/embed-concept-page.js";
import { embedPkbFileJob } from "./jobs/embed-pkb-file.js";
import {
  claimMemoryJobs,
  completeMemoryJob,
  deferMemoryJob,
  EMBED_JOB_TYPES,
  enqueueMemoryJob,
  enqueuePruneOldActivationLogsJob,
  enqueuePruneOldBackgroundConversationsJob,
  enqueuePruneOldConversationsJob,
  enqueuePruneOldLlmRequestLogsJob,
  enqueuePruneOldTraceEventsJob,
  failMemoryJob,
  failStalledJobs,
  hasActiveJobOfType,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS,
  type MemoryJob,
  type MemoryJobType,
  pruneOldMemoryJobs,
  resetRunningJobsToPending,
  SLOW_LLM_JOB_TYPES,
} from "./jobs-store.js";
import { memoryRetrospectiveJob } from "./memory-retrospective-job.js";
import { sweepOrphanMemoryRetrospectiveConversations } from "./memory-retrospective-startup-cleanup.js";
import { QdrantCircuitOpenError } from "./qdrant-circuit-breaker.js";
import {
  memoryV2ActivationRecomputeJob,
  memoryV2MigrateJob,
  memoryV2ReembedJob,
} from "./v2/backfill-jobs.js";
import {
  countBufferLines,
  memoryV2ConsolidateJob,
} from "./v2/consolidation-job.js";
import { memoryV2SweepJob } from "./v2/sweep-job.js";

const log = getLogger("memory-jobs-worker");

const AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD = {
  trigger: MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS.automatic,
} as const;

/**
 * Minimum buffer entries required for a scheduled consolidation run. The
 * time-based schedule noops when `memory/buffer.md` has fewer non-empty lines
 * than this threshold — the LLM cost of a full consolidation pass outweighs
 * the benefit when the buffer is nearly empty. Mirrors the heartbeat
 * max-consecutive-runs skip pattern. Manual "Run now" and the size-based
 * trigger are not affected.
 */
export const MIN_BUFFER_LINES_FOR_CONSOLIDATION = 10;

/**
 * V1 job types that read or write the v1 Qdrant collection via
 * `getQdrantClient()`. When `memory.v2.enabled` is true, the v1 client is
 * intentionally left uninitialized in `lifecycle.ts`, so these handlers would
 * throw `BackendUnavailableError` and accumulate as a deferred backlog. Stale
 * rows from indexer.ts and other unguarded enqueue sites must short-circuit
 * here for the same reason `graph_extract` does below.
 */
const V1_QDRANT_JOB_TYPES = new Set<MemoryJobType>([
  "embed_segment",
  "embed_summary",
  "embed_media",
  "embed_attachment",
  "embed_graph_node",
  "embed_pkb_file",
  "rebuild_index",
  "delete_qdrant_vectors",
]);

/**
 * Job types whose handlers have been removed. Existing rows may still sit in
 * the database — the worker completes them silently instead of throwing.
 */
const LEGACY_JOB_TYPES = new Set([
  "embed_item",
  "extract_items",
  "batch_extract",
  "extract_entities",
  "cleanup_stale_superseded_items",
  "backfill_entity_relations",
  "refresh_weekly_summary",
  "refresh_monthly_summary",
  "journal_carry_forward",
  "generate_capability_cards",
  "generate_thread_starters",
  "memory_v2_rebuild_edges",
  // Retired memory-v3 job types — handlers were removed in the v3 rip. Kept
  // here so pre-upgrade rows enqueued by the old write path drop gracefully.
  "memory_v3_consolidate",
  "memory_v3_index_maintenance",
  "memory_v3_edge_learning",
]);

export const POLL_INTERVAL_MIN_MS = 1_500;
export const POLL_INTERVAL_MAX_MS = 30_000;

export interface MemoryJobsWorker {
  runOnce(): Promise<number>;
  stop(): void;
}

export function startMemoryJobsWorker(): MemoryJobsWorker {
  const recovered = resetRunningJobsToPending();
  if (recovered > 0) {
    log.info({ recovered }, "Recovered stale running memory jobs");
  }

  // After running-job recovery (so legitimate in-flight retries aren't
  // swept), clean up orphan memory-retrospective background conversations
  // left behind by daemon crashes mid-job. Best-effort — never block worker
  // startup on cleanup failures.
  try {
    sweepOrphanMemoryRetrospectiveConversations();
  } catch (err) {
    log.warn(
      { err },
      "Memory-retrospective startup cleanup failed; continuing worker startup",
    );
  }

  let stopped = false;
  let tickRunning = false;
  let timer: ReturnType<typeof setTimeout>;
  let currentIntervalMs = POLL_INTERVAL_MIN_MS;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      const processed = await runMemoryJobsOnce({
        enableScheduledCleanup: true,
      });
      if (processed > 0) {
        // Per-tick claim budget equals the lane caps, so when a tick
        // processed work the next tick must run immediately to drain any
        // remaining backlog. Holding the 1.5s floor between ticks would cap
        // sustained throughput at lane-cap jobs per 1.5s and starve large
        // backlogs of short jobs.
        currentIntervalMs = 0;
      } else {
        currentIntervalMs = Math.min(
          Math.max(currentIntervalMs * 2, POLL_INTERVAL_MIN_MS),
          POLL_INTERVAL_MAX_MS,
        );
      }
    } catch (err) {
      log.error({ err }, "Memory worker tick failed");
      currentIntervalMs = Math.min(
        Math.max(currentIntervalMs * 2, POLL_INTERVAL_MIN_MS),
        POLL_INTERVAL_MAX_MS,
      );
    } finally {
      tickRunning = false;
    }
  };

  const scheduleTick = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().then(() => {
        if (!stopped) scheduleTick();
      });
    }, currentIntervalMs);
    (timer as NodeJS.Timeout).unref?.();
  };

  void tick().then(() => {
    if (!stopped) scheduleTick();
  });

  return {
    async runOnce(): Promise<number> {
      return runMemoryJobsOnce({ enableScheduledCleanup: true });
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

type ProcessGroup = (group: MemoryJob[]) => Promise<number>;

export async function runMemoryJobsOnce(
  options: { enableScheduledCleanup?: boolean } = {},
): Promise<number> {
  const config = getConfig();
  if (config.memory.enabled === false) return 0;
  const enableScheduledCleanup = options.enableScheduledCleanup === true;

  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "skip") {
    if (shouldLogDiskPressureBackgroundSkip("memory-jobs-worker")) {
      log.warn(
        {
          source: "memory",
          ...diskPressureBackgroundSkipLogFields(diskPressureGate),
        },
        "Memory jobs worker skipped during disk pressure cleanup mode",
      );
    }
    return 0;
  }

  // Fail jobs that have been running longer than the configured timeout
  const timedOut = failStalledJobs(config.memory.jobs.stalledJobTimeoutMs);
  if (timedOut > 0) {
    log.warn({ timedOut }, "Timed out stalled memory jobs");
  }

  const cfgSlow = Math.max(1, config.memory.jobs.slowLlmConcurrency);
  const cfgFast = Math.max(1, config.memory.jobs.fastConcurrency);
  const cfgEmbed = Math.max(1, config.memory.jobs.embedConcurrency);

  // Claim per-lane budgets so a backlog of slow LLM jobs cannot starve fast
  // jobs (and vice versa). The Qdrant circuit breaker still gates only the
  // embed lane inside `claimMemoryJobs`.
  const claimed = claimMemoryJobs({
    slowLlm: cfgSlow,
    fast: cfgFast,
    embed: cfgEmbed,
  });

  if (claimed.length === 0) {
    if (enableScheduledCleanup) {
      maybeEnqueueScheduledCleanupJobs(config);
    }
    maybeEnqueueGraphMaintenanceJobs(config);
    maybeEnqueueContactMemorySweepJob(config);
    maybePruneOldMemoryJobs();
    await maybeSweepOrphanConversationMemoryRows();
    maybeCheckpointWal();
    await maybeRunDbMaintenance();
    await maybeRunDbSnapshot();
    return 0;
  }

  const slowSet = new Set<MemoryJobType>(SLOW_LLM_JOB_TYPES);
  const embedSet = new Set<MemoryJobType>(EMBED_JOB_TYPES);
  const slowJobs: MemoryJob[] = [];
  const fastJobs: MemoryJob[] = [];
  const embedJobs: MemoryJob[] = [];
  for (const job of claimed) {
    if (slowSet.has(job.type)) {
      slowJobs.push(job);
    } else if (embedSet.has(job.type)) {
      embedJobs.push(job);
    } else {
      fastJobs.push(job);
    }
  }

  const processGroup: ProcessGroup = async (group) => {
    let groupProcessed = 0;
    for (const job of group) {
      try {
        const result = normalizeHandlerResult(await processJob(job, config));
        applyQueueResolution(job, result);
        // Observation only, and only for rows that actually completed. A
        // bookkeeping failure must never turn a job that succeeded into one
        // that failed, so the streak counter is kept out of the path that
        // decides the job's status; and a dead-lettered/deferred row's truth
        // lives in `status` + `last_error` — counting a failed wake as an
        // "empty run" would launder failure back into the empty-streak axis.
        if (result.queue.queueResolution === "completed") {
          try {
            recordJobOutcome(job.type, result.outcome);
          } catch (healthErr) {
            log.debug(
              { err: healthErr, jobId: job.id, type: job.type },
              "Recording job outcome health failed; job completion unaffected",
            );
          }
        }
        groupProcessed += 1;
      } catch (err) {
        try {
          handleJobError(job, err);
        } catch (handlerErr) {
          log.error(
            { err: handlerErr, jobId: job.id, type: job.type },
            "handleJobError itself threw, job left in running status",
          );
        }
      }
    }
    return groupProcessed;
  };

  // Run all three lanes in parallel. Each lane runs its own bounded task pool
  // so a slow `graph_consolidate` cannot block embed or fast jobs from making
  // progress, and per-`(type, conversationId)` grouping inside each lane keeps
  // same-conversation jobs serialized.
  const [slowProcessed, fastProcessed, embedProcessed] = await Promise.all([
    runLanePool(slowJobs, cfgSlow, processGroup),
    runLanePool(fastJobs, cfgFast, processGroup),
    runLanePool(embedJobs, cfgEmbed, processGroup),
  ]);

  if (enableScheduledCleanup) {
    maybeEnqueueScheduledCleanupJobs(config);
  }
  maybeEnqueueGraphMaintenanceJobs(config);
  maybeEnqueueContactMemorySweepJob(config);
  maybePruneOldMemoryJobs();
  maybeCheckpointWal();
  await maybeRunDbMaintenance();
  await maybeRunDbSnapshot();
  return slowProcessed + fastProcessed + embedProcessed;
}

// ── WAL checkpoint ─────────────────────────────────────────────────

/** Minimum interval between periodic PASSIVE WAL checkpoints. */
const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let lastWalCheckpointMs = 0;

/**
 * Periodic PASSIVE WAL checkpoint on the daemon's own in-process
 * connection. The autocheckpoint (1000 pages) stalls behind any
 * long-lived reader, and once stalled the WAL grows without bound until
 * the next clean shutdown (observed at 265MB in production, with every
 * write paying the oversized-WAL cost). A periodic PASSIVE checkpoint
 * makes whatever progress the current reader set allows — it never
 * blocks, never takes conflicting locks, and (unlike TRUNCATE) can never
 * unlink the WAL out from under peer connections, so it is safe to run
 * on the live connection per the WAL rules in assistant/CLAUDE.md.
 * In-memory throttle (not a durable checkpoint): an extra checkpoint
 * after a daemon restart is free.
 */
export function maybeCheckpointWal(nowMs = Date.now()): void {
  if (nowMs - lastWalCheckpointMs < WAL_CHECKPOINT_INTERVAL_MS) return;
  lastWalCheckpointMs = nowMs;
  try {
    getSqlite().exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (err) {
    log.warn({ err }, "Periodic PASSIVE WAL checkpoint failed");
  }
  try {
    getMemorySqlite().exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch (err) {
    log.warn({ err }, "Periodic PASSIVE memory-DB WAL checkpoint failed");
  }
}

// ── memory_jobs reaper ─────────────────────────────────────────────

/** How often the terminal-row reaper actually runs (per checkpoint). */
const MEMORY_JOBS_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const MEMORY_JOBS_PRUNE_CHECKPOINT_KEY = "memory_jobs_prune:last_run";

/**
 * Checkpoint-gated wrapper around `pruneOldMemoryJobs` (jobs-store.ts):
 * delete completed/failed `memory_jobs` rows older than the 7-day retention
 * on a periodic worker tick. Mirrors `maybeRunDbMaintenance`'s durable
 * checkpoint so the cadence survives daemon restarts, and runs BEFORE db
 * maintenance in the tick so a VACUUM on the same tick can reclaim the freed
 * pages. Best-effort: a prune failure is logged and the checkpoint still
 * advances so a persistent error can't hammer every tick.
 */
export function maybePruneOldMemoryJobs(nowMs = Date.now()): void {
  const lastRun = parseInt(
    getMemoryCheckpoint(MEMORY_JOBS_PRUNE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < MEMORY_JOBS_PRUNE_INTERVAL_MS) return;
  try {
    pruneOldMemoryJobs(undefined, nowMs);
  } catch (err) {
    log.error({ err }, "Failed to prune old terminal memory jobs");
  }
  setMemoryCheckpoint(MEMORY_JOBS_PRUNE_CHECKPOINT_KEY, String(nowMs));
}

// ── relocated memory tables — orphan sweep ─────────────────────────

/** How often the cross-DB orphan sweep runs (per durable checkpoint). */
const MEMORY_ORPHAN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const MEMORY_ORPHAN_SWEEP_CHECKPOINT_KEY =
  "memory_orphan_sweep:last_run";

/**
 * Checkpoint-gated wrapper around `sweepOrphanConversationMemoryTables`
 * (conversation-memory-cleanup.ts). The relocated conversation-keyed
 * memory tables lost their main-DB `ON DELETE CASCADE` when they moved to
 * assistant-memory.db; deletes purge them explicitly, and this sweep is
 * the backstop for purges lost to a crash between the two databases'
 * (non-atomic) delete pair. Best-effort: a sweep failure is logged and the
 * checkpoint still advances so a persistent error can't hammer every tick.
 */
export async function maybeSweepOrphanConversationMemoryRows(
  nowMs = Date.now(),
): Promise<void> {
  const lastRun = parseInt(
    getMemoryCheckpoint(MEMORY_ORPHAN_SWEEP_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < MEMORY_ORPHAN_SWEEP_INTERVAL_MS) return;
  try {
    await sweepOrphanConversationMemoryTables();
  } catch (err) {
    log.error({ err }, "Failed to sweep orphan relocated memory rows");
  }
  setMemoryCheckpoint(MEMORY_ORPHAN_SWEEP_CHECKPOINT_KEY, String(nowMs));
}

/**
 * Run a single lane's jobs through a bounded task pool of size `concurrency`.
 *
 * Jobs targeting different conversations (via payload.conversationId) are
 * placed in separate groups and run in parallel up to the lane's concurrency
 * cap. Jobs targeting the same conversation — or global jobs without a
 * conversationId — share a group and run sequentially to avoid checkpoint
 * races.
 */
async function runLanePool(
  jobs: MemoryJob[],
  concurrency: number,
  processGroup: ProcessGroup,
): Promise<number> {
  if (jobs.length === 0) return 0;

  const groups = new Map<string, MemoryJob[]>();
  for (const job of jobs) {
    const convId =
      typeof job.payload.conversationId === "string"
        ? job.payload.conversationId
        : null;
    const groupKey = convId ? `${job.type}:${convId}` : job.type;
    let group = groups.get(groupKey);
    if (!group) {
      group = [];
      groups.set(groupKey, group);
    }
    group.push(job);
  }

  let processed = 0;
  const typeGroups = [...groups.values()];

  if (typeGroups.length <= concurrency) {
    const results = await Promise.allSettled(typeGroups.map(processGroup));
    for (const result of results) {
      if (result.status === "fulfilled") {
        processed += result.value;
      } else {
        log.error(
          { err: result.reason },
          "Memory job group rejected unexpectedly — jobs in this batch may have been dropped",
        );
      }
    }
    return processed;
  }

  // Task pool: keep `concurrency` groups in flight at all times so a new group
  // starts the instant any slot frees up.
  let nextIdx = 0;
  const startNext = (): Promise<void> | undefined => {
    if (nextIdx >= typeGroups.length) return undefined;
    const group = typeGroups[nextIdx++]!;
    return processGroup(group)
      .then(
        (count) => {
          processed += count;
        },
        (err) => {
          log.error(
            { err },
            "Memory job group rejected unexpectedly — jobs in this batch may have been dropped",
          );
        },
      )
      .then(() => startNext());
  };

  const workers = Array.from(
    { length: Math.min(concurrency, typeGroups.length) },
    () => startNext()!,
  );
  await Promise.all(workers);
  return processed;
}

// ── Graph lifecycle job handlers ──────────────────────────────────

function graphDecayJob(job: MemoryJob): JobOutcome {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = runDecayTick(scopeId);
  log.info({ jobId: job.id, ...result }, "Graph decay tick complete");
  // `nodesProcessed` is what it read; the decays and downgrades are what it
  // wrote. A tick over a graph nobody touched legitimately changes nothing.
  return jobOutcomeFromDetail(
    {
      emotionalDecays: result.emotionalDecays,
      fidelityDowngrades: result.fidelityDowngrades,
    },
    `decay tick examined ${result.nodesProcessed} nodes and changed none of them`,
  );
}

async function graphConsolidateJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<JobOutcome> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runConsolidation(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.totalUpdated,
      deleted: result.totalDeleted,
      mergeEdges: result.totalMergeEdges,
    },
    "Graph consolidation complete",
  );
  return jobOutcomeFromDetail(
    {
      nodesUpdated: result.totalUpdated,
      nodesDeleted: result.totalDeleted,
      mergeEdges: result.totalMergeEdges,
    },
    "consolidation found nothing to merge, retire or rewrite",
  );
}

async function graphPatternScanJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<JobOutcome> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runPatternScan(scopeId, config);
  log.info(
    {
      jobId: job.id,
      patterns: result.patternsDetected,
      edges: result.edgesCreated,
    },
    "Graph pattern scan complete",
  );
  return jobOutcomeFromDetail(
    {
      patternsDetected: result.patternsDetected,
      edgesCreated: result.edgesCreated,
    },
    "pattern scan found no recurring shape worth recording",
  );
}

async function graphNarrativeRefineJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<JobOutcome> {
  const scopeId = (job.payload as { scopeId?: string })?.scopeId ?? "default";
  const result = await runNarrativeRefinement(scopeId, config);
  log.info(
    {
      jobId: job.id,
      updated: result.nodesUpdated,
      arcs: result.arcsIdentified,
    },
    "Graph narrative refinement complete",
  );
  // Counts `nodesUpdated` only. `arcsIdentified` is what the model claimed it
  // saw, not what reached the store — counting it would let a talkative model
  // report progress on a pass that wrote nothing.
  return jobProducedOrEmpty(
    result.nodesUpdated,
    `narrative pass named ${result.arcsIdentified} arcs and updated no nodes`,
    {
      nodesUpdated: result.nodesUpdated,
      arcsIdentified: result.arcsIdentified,
    },
  );
}

async function contactMemoryExtractJob(
  job: MemoryJob<{ conversationId?: string }>,
): Promise<JobOutcome> {
  const { conversationId } = job.payload;
  if (!conversationId) {
    log.warn(
      { jobId: job.id },
      "contact_memory_extract: missing conversationId",
    );
    return jobSkipped("no conversationId in the payload");
  }
  const outcome = await runContactMemoryExtraction(conversationId);
  log.debug(
    { jobId: job.id, conversationId, outcome: outcome.kind },
    "contact-memory extraction complete",
  );
  switch (outcome.kind) {
    case "extracted":
      // `savedCount: 0` is a real empty: the model was reached and read the
      // transcript. This is the 697-runs case, and it is the reason
      // `jobProducedOrEmpty` exists rather than a bare count.
      return jobProducedOrEmpty(
        outcome.savedCount,
        "read the conversation and found nothing worth remembering about anyone",
      );
    case "empty_reply":
      return jobEmpty("the model was reached and returned nothing at all");
    case "not_identified":
      return jobSkipped("the conversation is not bound to a known person");
    case "no_transcript":
      return jobSkipped("the conversation has no readable transcript");
    case "no_provider":
      return jobSkipped("no inference provider is configured for extraction");
    case "disabled":
      return jobSkipped("contact-memory extraction is switched off");
  }
}

async function contactMemorySweepJob(job: MemoryJob): Promise<JobOutcome> {
  const result = await runContactMemorySweep();
  // Logged at info with the counts, not at debug with a bare "complete": a
  // sweep that examined people and saved nothing must be legible in the log
  // without anyone having to already suspect it.
  log.info({ jobId: job.id, ...result }, "contact-memory sweep complete");
  switch (result.outcome) {
    case "progress":
      return jobProduced(result.saved, {
        saved: result.saved,
        examined: result.examined,
        provisioned: result.provisioned,
      });
    case "barren":
      // The sweep's own word for "we looked at people and wrote nothing".
      return jobEmpty(
        `read ${result.examined} people's correspondence and remembered nothing from any of it`,
        { examined: result.examined, candidates: result.candidates },
      );
    case "nothing_new":
      return jobSkipped(
        `nobody's mail had changed since the last sweep (${result.alreadyRead} already read)`,
      );
    case "no_candidates":
      return jobSkipped("nobody has readable correspondence to sweep");
    case "no_provider":
      return jobSkipped("no inference provider is configured for the sweep");
    case "disabled":
      return jobSkipped("the correspondence sweep is switched off");
  }
}

// ── Job error handling ─────────────────────────────────────────────

function handleJobError(job: MemoryJob, err: unknown): void {
  if (err instanceof BackendUnavailableError) {
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Embedding backend unavailable, job exceeded max deferrals",
      );
    } else {
      log.debug(
        { jobId: job.id, type: job.type },
        "Embedding backend unavailable, deferring job",
      );
    }
  } else if (err instanceof QdrantCircuitOpenError) {
    const result = deferMemoryJob(job.id);
    if (result === "failed") {
      log.error(
        { jobId: job.id, type: job.type },
        "Qdrant circuit breaker open, job exceeded max deferrals",
      );
    } else {
      log.debug(
        { jobId: job.id, type: job.type },
        "Qdrant circuit breaker open, deferring job",
      );
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    const category = classifyError(err);
    if (category === "retryable") {
      const delay = retryDelayForAttempt(job.attempts + 1);
      failMemoryJob(job.id, message, {
        retryDelayMs: delay,
        maxAttempts: RETRY_MAX_ATTEMPTS,
      });
      log.warn(
        { err, jobId: job.id, type: job.type, delay, category },
        "Memory job failed (retryable)",
      );
    } else {
      failMemoryJob(job.id, message, { maxAttempts: 1 });
      log.warn(
        { err, jobId: job.id, type: job.type, category },
        "Memory job failed (fatal)",
      );
    }
  }
}

// ── Job dispatch ───────────────────────────────────────────────────

/**
 * Lift a bare {@link JobOutcome} into the two-axis {@link JobHandlerResult}.
 * A bare outcome keeps the historical contract — the row completes and
 * failure is signaled by throwing. Cases that report failure through a
 * returned domain outcome (the retrospective's `wake_failed` /
 * `no_usable_output`, the consolidation's `run_failed`) return a full
 * result carrying the row's real disposition.
 */
function normalizeHandlerResult(
  result: JobOutcome | JobHandlerResult,
): JobHandlerResult {
  return "queue" in result ? result : jobCompleted(result);
}

/**
 * Apply a handler's queue resolution to its claimed row. This is the
 * worker's half of the outcome-truthfulness boundary (upstream 6d3f5d2e5b):
 * the persisted `memory_jobs.status` must reflect the handler's actual
 * outcome, so a handler that reports failure through a returned value
 * dead-letters, retries, or defers instead of silently completing.
 */
function applyQueueResolution(job: MemoryJob, result: JobHandlerResult): void {
  const queue = result.queue;
  switch (queue.queueResolution) {
    case "completed": {
      completeMemoryJob(job.id, result.outcome);
      return;
    }
    case "failed": {
      failMemoryJob(job.id, queue.errorMessage ?? "handler failed", {
        maxAttempts: 1,
      });
      return;
    }
    case "retryable": {
      failMemoryJob(job.id, queue.errorMessage ?? "handler failed", {
        retryDelayMs:
          queue.retryDelayMs ?? retryDelayForAttempt(job.attempts + 1),
        maxAttempts: RETRY_MAX_ATTEMPTS,
      });
      return;
    }
    case "deferred": {
      deferMemoryJob(
        job.id,
        queue.deferralExhaustedMessage
          ? { exhaustedMessage: queue.deferralExhaustedMessage }
          : {},
      );
      return;
    }
  }
}

/**
 * Run one job and say what it did.
 *
 * The return type is the point of this function. It used to be `void`, which
 * meant the worker's only vocabulary was "threw" versus "did not throw" — and
 * "did not throw" covered both a full extraction and a run that read nothing,
 * wrote nothing and advanced its checkpoint anyway. Handlers that cannot yet
 * answer return {@link JOB_OUTCOME_UNREPORTED}: an honest gap that gets
 * counted, rather than a silent promotion to success. Handlers whose domain
 * outcome carries a failure the queue must record return a full
 * {@link JobHandlerResult} instead of a bare outcome.
 */
async function processJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<JobOutcome | JobHandlerResult> {
  if (config.memory.v2.enabled && V1_QDRANT_JOB_TYPES.has(job.type)) {
    // On the owner's instance this is 13,000 `embed_segment` rows a week that
    // reach `completed` without touching a store. Correct behaviour — v2 does
    // not read the v1 collection — but it must not read as work.
    return jobSkipped(
      "memory.v2 is active; the v1 embedding path this job writes is not read",
    );
  }
  switch (job.type) {
    case "embed_segment":
      await embedSegmentJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "embed_summary":
      await embedSummaryJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "prune_old_conversations":
      return pruneOldConversationsJob(job, config);
    case "prune_old_background_conversations":
      return pruneOldBackgroundConversationsJob(job, config);
    case "prune_old_llm_request_logs":
      return await pruneOldLlmRequestLogsJob(job, config);
    case "prune_old_trace_events":
      return await pruneOldTraceEventsJob(job, config);
    case "prune_old_activation_logs":
      return await pruneOldActivationLogsJob(job, config);
    case "build_conversation_summary":
      // Stale rows enqueued before v2 was enabled must not consume the
      // `conversationSummarization` LLM budget — v2 readers do not consume
      // `memorySummaries`, mirroring the `graph_extract` gate below.
      if (config.memory.v2.enabled) {
        return jobSkipped(
          "memory.v2 is active; nothing reads the summaries this job writes",
        );
      }
      await buildConversationSummaryJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "backfill":
      await backfillJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "rebuild_index":
      await rebuildIndexJob();
      return JOB_OUTCOME_UNREPORTED;
    case "delete_qdrant_vectors":
      await deleteQdrantVectorsJob(job);
      return JOB_OUTCOME_UNREPORTED;
    case "media_processing":
      await mediaProcessingJob(job);
      return JOB_OUTCOME_UNREPORTED;
    case "embed_media":
      await embedMediaJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "embed_attachment":
      await embedAttachmentJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "embed_graph_node":
      await embedGraphNodeJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "embed_pkb_file":
      await embedPkbFileJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "graph_trigger_embed":
      await embedGraphTriggerJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "graph_extract":
      // Runs under BOTH v1 and v2. The graph store this job writes is the
      // source the Memory page reads for its episodic / semantic / etc.
      // counts; v2's concept-page store never classifies into those typed
      // buckets, so suppressing extraction under v2 leaves the Memory page
      // frozen. The indexer enqueues this under both modes to match.
      return await graphExtractJob(job, config);
    case "conversation_analyze":
      await conversationAnalyzeJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "graph_decay":
      return graphDecayJob(job);
    case "graph_consolidate":
      return await graphConsolidateJob(job, config);
    case "graph_pattern_scan":
      return await graphPatternScanJob(job, config);
    case "graph_narrative_refine":
      return await graphNarrativeRefineJob(job, config);
    case "generate_conversation_starters":
      return await generateConversationStartersJob(job);
    case "graph_bootstrap": {
      const result = await bootstrapFromHistory();
      return jobOutcomeFromDetail(
        {
          nodesCreated: result.totalNodesCreated,
          nodesUpdated: result.totalNodesUpdated,
          nodesReinforced: result.totalNodesReinforced,
          edgesCreated: result.totalEdgesCreated,
          triggersCreated: result.totalTriggersCreated,
        },
        `bootstrap read ${result.conversationsProcessed} conversations and built nothing from any of them`,
      );
    }
    case "embed_concept_page":
      await embedConceptPageJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "memory_v2_sweep":
      return await memoryV2SweepJob(job, config);
    case "memory_v2_consolidate": {
      const result = await memoryV2ConsolidateJob(job, config);
      switch (result.kind) {
        case "invoked":
          // The pages are written by an agent inside the forked conversation,
          // so this job cannot count them. What it CAN say is that it handed
          // the work off, which is a different claim from having done it.
          return jobProduced(1, {
            deferredEntries: result.deferredEntries,
            followUpJobs: result.followUpJobIds.length,
          });
        case "empty_buffer":
          return jobEmpty("the buffer had nothing left to consolidate");
        case "run_failed":
          // A failed run dead-letters the row with the failure reason; retry
          // cadence is owned by the consolidation scheduler's own backoff,
          // not the queue's attempt budget (maxAttempts 1 via `failed`).
          return {
            outcome: jobEmpty(
              `the consolidation run did not complete${result.reason ? ` — ${result.reason}` : ""}`,
            ),
            queue: {
              queueResolution: "failed",
              errorMessage: `consolidation run failed: ${result.reason ?? "unknown"}`,
            },
          };
        case "locked":
          return jobSkipped("another consolidation run holds the lock");
        case "disabled":
          return jobSkipped("memory-v2 consolidation is switched off");
      }
      return JOB_OUTCOME_UNREPORTED;
    }
    case "memory_v2_migrate":
      await memoryV2MigrateJob(job, config);
      return JOB_OUTCOME_UNREPORTED;
    case "memory_v2_reembed": {
      const enqueued = await memoryV2ReembedJob(job, config);
      return jobProducedOrEmpty(
        enqueued,
        "no concept pages exist to re-embed",
        { embedJobsEnqueued: enqueued },
      );
    }
    case "memory_v2_activation_recompute": {
      const updated = await memoryV2ActivationRecomputeJob(job, config);
      return jobProducedOrEmpty(
        updated,
        "every stored activation state was already up to date",
        { conversationsUpdated: updated },
      );
    }
    case "memory_v3_maintain": {
      const result = await memoryV3MaintainJob(job, config);
      if (result.disabled) return jobSkipped("memory-v3 is switched off");
      return jobOutcomeFromDetail(
        { reembedded: result.reembedded, pruned: result.pruned },
        "the v3 section store needed no repair",
      );
    }
    case "memory_retrospective": {
      const result = await memoryRetrospectiveJob(job, config);
      switch (result.kind) {
        case "invoked":
          // Same shape as v2 consolidation: the `remember()` calls happen in
          // the woken conversation. Handing off is the write this job makes.
          return jobProduced(1, {
            newMessages: result.newMessageCount,
            followUpJobs: result.followUpJobIds.length,
          });
        case "no_new_messages":
          return jobSkipped("nothing has been said since the last pass");
        case "source_processing":
          // Defer the SAME row on the bounded deferral counter instead of
          // completing it: the retry re-checks the processing flag, and a
          // stranded flag dead-letters with an honest message instead of
          // minting an endless stream of "completed" skips.
          return {
            outcome: jobSkipped(
              "the source conversation is still being processed",
            ),
            queue: {
              queueResolution: "deferred",
              deferralExhaustedMessage:
                "source conversation stayed mid-turn through the deferral budget; a later trigger will re-enqueue",
            },
          };
        case "wake_failed":
          // The wake never went live: dead-letter with an honest last_error.
          // Retry stays event-driven (cooldown + trigger re-enqueue), so the
          // queue's attempt budget deliberately does not double-drive it.
          return {
            outcome: jobEmpty(
              `the retrospective conversation could not be woken${result.reason ? ` — ${result.reason}` : ""}`,
            ),
            queue: {
              queueResolution: "failed",
              errorMessage: `retrospective wake failed: ${result.reason ?? "unknown"}`,
            },
          };
        case "no_usable_output":
          // The wake went live but the run persisted neither a verified
          // memory write nor the explicit no-findings reply. The window
          // stays retryable in retrospective state; the row must not read
          // `completed`.
          return {
            outcome: jobEmpty(
              `the retrospective run produced no usable output${result.reason ? ` — ${result.reason}` : ""}`,
            ),
            queue: {
              queueResolution: "failed",
              errorMessage: `retrospective run produced no usable output: ${result.reason ?? "unknown"}`,
            },
          };
        case "disabled":
          return jobSkipped("memory retrospectives are switched off");
      }
      return JOB_OUTCOME_UNREPORTED;
    }
    case "contact_memory_extract":
      return await contactMemoryExtractJob(job);
    case "contact_memory_sweep":
      return await contactMemorySweepJob(job);

    default: {
      const rawType = (job as { type: string }).type;
      if (LEGACY_JOB_TYPES.has(rawType)) {
        log.debug({ jobId: job.id, type: rawType }, "Dropping legacy job");
        return jobSkipped("this job type no longer has a handler");
      }
      throw new Error(`Unknown memory job type: ${rawType}`);
    }
  }
}

/**
 * Enqueue periodic cleanup jobs using config-driven retention windows.
 * Enqueue is deduped in jobs-store, so repeated calls remain safe.
 */
function maybeEnqueueScheduledCleanupJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): boolean {
  const cleanup = config.memory.cleanup;
  if (!cleanup.enabled) return false;
  if (nowMs - getLastScheduledCleanupEnqueueMs() < cleanup.enqueueIntervalMs)
    return false;

  const pruneConversationsJobId =
    cleanup.conversationRetentionDays > 0
      ? enqueuePruneOldConversationsJob(cleanup.conversationRetentionDays)
      : null;
  const pruneBackgroundConversationsJobId =
    cleanup.backgroundConversationRetentionDays > 0
      ? enqueuePruneOldBackgroundConversationsJob(
          cleanup.backgroundConversationRetentionDays,
        )
      : null;
  const pruneLlmRequestLogsJobId =
    cleanup.llmRequestLogRetentionMs !== null
      ? enqueuePruneOldLlmRequestLogsJob(cleanup.llmRequestLogRetentionMs)
      : null;
  const pruneTraceEventsJobId =
    cleanup.traceEventRetentionDays > 0
      ? enqueuePruneOldTraceEventsJob(cleanup.traceEventRetentionDays)
      : null;
  const pruneActivationLogsJobId =
    cleanup.activationLogRetentionDays > 0
      ? enqueuePruneOldActivationLogsJob(cleanup.activationLogRetentionDays)
      : null;
  markScheduledCleanupEnqueued(nowMs);
  log.debug(
    {
      pruneConversationsJobId,
      pruneBackgroundConversationsJobId,
      pruneLlmRequestLogsJobId,
      pruneTraceEventsJobId,
      pruneActivationLogsJobId,
      enqueueIntervalMs: cleanup.enqueueIntervalMs,
      conversationRetentionDays: cleanup.conversationRetentionDays,
      backgroundConversationRetentionDays:
        cleanup.backgroundConversationRetentionDays,
      llmRequestLogRetentionMs: cleanup.llmRequestLogRetentionMs,
      traceEventRetentionDays: cleanup.traceEventRetentionDays,
      activationLogRetentionDays: cleanup.activationLogRetentionDays,
    },
    "Enqueued scheduled memory cleanup jobs",
  );
  return true;
}

// ── Graph maintenance scheduling ──────────────────────────────────

const GRAPH_DECAY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const GRAPH_CONSOLIDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const GRAPH_PATTERN_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const GRAPH_NARRATIVE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
// Backstop cadence for v3 self-maintenance. The primary trigger is the
// post-consolidation follow-up (see `consolidation-job.ts`); this interval only
// covers the case where that follow-up is missed (enqueue failure). A
// conservative cadence is fine since
// the maintenance pass is idempotent and cheap when there's nothing to do.
const GRAPH_V3_MAINTAIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * How often the correspondence sweep runs. Mail is not a real-time substrate
 * and each sweep spends flash calls, so this is deliberately slow; the sweep
 * is idempotent and skips anyone whose mail has not changed.
 */
const CONTACT_MEMORY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const CONTACT_MEMORY_SWEEP_CHECKPOINT = "contact_memory_sweep:last_run";

/**
 * Enqueue the periodic contact-memory correspondence sweep.
 *
 * Separate from graph maintenance because it is not graph work and must keep
 * running whichever memory version is active: the People surface is fed by
 * `contact_memory`, and the conversation-keyed extraction only ever names
 * people who arrived through an interactive channel. Without this, an owner
 * whose correspondence is email accumulates nobody.
 *
 * Durable checkpoint so the interval survives restarts, and deduped against an
 * already-active sweep so a wedged sweep cannot flood the queue.
 */
export function maybeEnqueueContactMemorySweepJob(
  config: AssistantConfig,
  nowMs = Date.now(),
): boolean {
  if (config.memory.enabled === false) return false;
  const lastRun = parseInt(
    getMemoryCheckpoint(CONTACT_MEMORY_SWEEP_CHECKPOINT) ?? "0",
    10,
  );
  if (nowMs - lastRun < CONTACT_MEMORY_SWEEP_INTERVAL_MS) return false;
  if (hasActiveJobOfType("contact_memory_sweep")) return false;
  enqueueMemoryJob("contact_memory_sweep", {});
  setMemoryCheckpoint(CONTACT_MEMORY_SWEEP_CHECKPOINT, String(nowMs));
  return true;
}

export const GRAPH_MAINTENANCE_CHECKPOINTS = {
  decay: "graph_maintenance:decay:last_run",
  consolidate: "graph_maintenance:consolidate:last_run",
  patternScan: "graph_maintenance:pattern_scan:last_run",
  narrative: "graph_maintenance:narrative:last_run",
  memoryV2Consolidate: "memory_v2_consolidate_last_run",
  memoryV3Maintain: "memory_v3_maintain_last_run",
} as const;

/**
 * Enqueue periodic graph maintenance jobs.
 *
 * Mutually exclusive between v1 and v2:
 *   - v2 active (`memory.v2.enabled` on) → only one buffer-drainer is
 *     scheduled (see below).
 *   - v2 inactive → the four v1 entries (decay, consolidate, pattern_scan,
 *     narrative) are scheduled instead.
 *
 * The `memory/buffer.md` is shared, so exactly one consolidator owns the drain
 * at a time. When v2 is active, the v2 consolidator (`memory_v2_consolidate`)
 * is the sole buffer-drainer.
 *
 * Read/write paths route to v2 when the flag is on, so v1 graph data goes
 * unread; running v1 maintenance alongside v2 is wasted compute and LLM
 * spend. The v1 code path remains live so flipping the flag back to off
 * fully re-engages v1.
 *
 * Uses durable checkpoints so intervals survive daemon restarts — jobs only
 * fire when the actual elapsed time since last run exceeds the interval.
 * Sweep is intentionally not on this schedule: it is debounced from the
 * live `graph_extract` trigger path (see `indexMessageNow` in `indexer.ts`)
 * so it runs on the same idle/message-count cadence.
 *
 * Independently of the v1/v2 split, a flag-gated `memory_v3_maintain` backstop
 * is appended when a v3 path is active so the topic tree self-heals even if the
 * primary post-consolidation follow-up enqueue is missed.
 */
export function maybeEnqueueGraphMaintenanceJobs(
  config: AssistantConfig,
  nowMs = Date.now(),
): void {
  const memoryEnabled = config.memory.enabled !== false;
  if (!memoryEnabled) return;

  const v2Active = config.memory.v2.enabled;

  // The single buffer-drainer entry for the v2-active branch. Referenced again
  // below by the size-based trigger.
  const consolidateEntry = {
    key: GRAPH_MAINTENANCE_CHECKPOINTS.memoryV2Consolidate,
    intervalMs: config.memory.v2.consolidation_interval_hours * 60 * 60 * 1000,
    jobType: "memory_v2_consolidate" as MemoryJobType,
  };

  const schedule: Array<{
    key: string;
    intervalMs: number;
    jobType: MemoryJobType;
  }> = v2Active
    ? [consolidateEntry]
    : [
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.decay,
          intervalMs: GRAPH_DECAY_INTERVAL_MS,
          jobType: "graph_decay",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.consolidate,
          intervalMs: GRAPH_CONSOLIDATE_INTERVAL_MS,
          jobType: "graph_consolidate",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.patternScan,
          intervalMs: GRAPH_PATTERN_SCAN_INTERVAL_MS,
          jobType: "graph_pattern_scan",
        },
        {
          key: GRAPH_MAINTENANCE_CHECKPOINTS.narrative,
          intervalMs: GRAPH_NARRATIVE_INTERVAL_MS,
          jobType: "graph_narrative_refine",
        },
      ];

  // v3 self-maintenance backstop. Orthogonal to the v1/v2 mutual exclusion
  // above: it owns its own checkpoint and operates on the v3 topic tree, so it
  // runs under either branch. Gated on the same flags that gate the v3 plugin
  // so it stays inert when v3 is off. The post-consolidation follow-up in
  // `consolidation-job.ts` remains the primary trigger; this interval only
  // self-heals when that follow-up is missed (failed enqueue). The job handler
  // itself no-ops when v3 is off, so
  // this guard is belt-and-suspenders that also avoids a wasted enqueue.
  if (
    isAssistantFeatureFlagEnabled("memory-v3-shadow", config) ||
    isAssistantFeatureFlagEnabled("memory-v3-live", config)
  ) {
    schedule.push({
      key: GRAPH_MAINTENANCE_CHECKPOINTS.memoryV3Maintain,
      intervalMs: GRAPH_V3_MAINTAIN_INTERVAL_MS,
      jobType: "memory_v3_maintain",
    });
  }

  let enqueuedConsolidate = false;
  for (const { key, intervalMs, jobType } of schedule) {
    const lastRun = parseInt(getMemoryCheckpoint(key) ?? "0", 10);
    if (nowMs - lastRun >= intervalMs) {
      // Noop scheduled consolidation when the buffer has too few entries to
      // justify an LLM run — mirrors the heartbeat max-consecutive-runs skip.
      // The checkpoint advances so the next check fires after the regular
      // interval. Manual "Run now" is unaffected (routes layer, not schedule).
      if (jobType === consolidateEntry.jobType) {
        const bufferPath = join(getWorkspaceDir(), "memory", "buffer.md");
        if (countBufferLines(bufferPath) < MIN_BUFFER_LINES_FOR_CONSOLIDATION) {
          log.debug(
            "Scheduled consolidation skipped: buffer under minimum line threshold",
          );
          setMemoryCheckpoint(key, String(nowMs));
          continue;
        }
      }
      const payload =
        jobType === consolidateEntry.jobType
          ? AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD
          : {};
      enqueueMemoryJob(jobType, payload);
      setMemoryCheckpoint(key, String(nowMs));
      if (jobType === consolidateEntry.jobType) enqueuedConsolidate = true;
    }
  }

  // Size-based trigger: when the shared buffer crosses the configured line
  // count, drain it now rather than waiting out the interval. Retargets to the
  // same consolidator the interval branch above selected.
  //
  // The size branch is checkpoint-blind by design (it must fire before the
  // interval elapses), so it dedupes against an already-active consolidate job
  // instead — otherwise it would re-enqueue on every worker tick while the
  // buffer stays over threshold, flooding the queue with redundant LLM work.
  const maxLines = config.memory.v2.consolidation_max_buffer_lines;
  if (
    v2Active &&
    !enqueuedConsolidate &&
    maxLines !== null &&
    !hasActiveJobOfType(consolidateEntry.jobType)
  ) {
    const bufferPath = join(getWorkspaceDir(), "memory", "buffer.md");
    if (countBufferLines(bufferPath) >= maxLines) {
      enqueueMemoryJob(
        consolidateEntry.jobType,
        AUTOMATIC_CONSOLIDATION_JOB_PAYLOAD,
      );
      setMemoryCheckpoint(consolidateEntry.key, String(nowMs));
    }
  }
}
