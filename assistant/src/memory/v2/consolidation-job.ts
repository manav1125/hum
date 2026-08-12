/**
 * Memory v2 — `memory_v2_consolidate` job handler.
 *
 * The consolidation job is the centerpiece of v2: an hourly background pass
 * that routes accumulated `memory/buffer.md` entries into concept pages,
 * rewrites `memory/recent.md`, promotes new essentials/threads, and trims the
 * buffer down to entries that arrived after the run started.
 *
 * Consolidation runs as the assistant: `runBackgroundJob()` bootstraps a
 * background conversation and routes the cutoff-templated prompt through
 * `processMessage`, so the standard system prompt (SOUL.md + IDENTITY.md +
 * persona + memory/* autoloads) and tool surface (read_file, write_file,
 * edit_file, list_files, bash) are loaded. Care, judgment, and the
 * assistant's voice are the point — there is no "consolidator persona" to
 * substitute in.
 *
 * The conversation is EPHEMERAL (`ephemeralConversation: true`): the run's
 * useful output is its memory-file writes, and the runner deletes the
 * conversation row once the run settles so hourly runs never accumulate
 * `conversation_type='background'` rows. Timeout/crash leftovers are
 * reclaimed by `sweepStaleConsolidationConversations` at the start of the
 * next run.
 *
 * Lifecycle:
 *   1. Bail if `config.memory.enabled` or `config.memory.v2.enabled` is false
 *      (the worker may have claimed a stale row from before memory was
 *      disabled).
 *   2. Acquire a single-process lock at `memory/.v2-state/consolidation.lock`
 *      so two overlapping schedule windows can't fight over the same files.
 *      The lock contains the holder's PID + timestamp so a crashed run leaves
 *      a diagnosable trace.
 *   3. Capture the cutoff timestamp at dispatch. Any buffer entry timestamped
 *      at or after the cutoff arrived AFTER the run started — leave it for
 *      the next pass.
 *   4. Read `memory/buffer.md`. Bail if empty (no work to do, but the lock
 *      and skip path still log so operators can confirm the schedule fired).
 *   5. Hand off to `runBackgroundJob()` with the templated prompt. The runner
 *      handles bootstrap + processMessage + timeout + error classification,
 *      and (because we set `suppressFailureNotifications: true`) does NOT
 *      emit an `activity.failed` notification on transient failures —
 *      consolidation runs on tight intervals, so a network blip or model
 *      hiccup should not spam the home feed. Sentry-side reporting is
 *      unchanged. The prompt body is loaded via `resolveConsolidationPrompt`
 *      which bounds any operator-provided override to a regular file under
 *      1 MiB before substitution.
 *   6. On success, enqueue `memory_v2_reembed` (re-index any pages the agent
 *      touched). Tracking touched pages via mtime would be more precise but
 *      is fragile across filesystems; the embedder's content-hash cache makes
 *      a conservative full-reembed effectively free. On failure no follow-ups
 *      are enqueued — the agent's writes may be partial and re-embedding
 *      partial state would be misleading.
 *   7. Release the lock. A stale lock is taken over automatically on the next
 *      run (single-writer per workspace): when the holder's PID is no longer
 *      running, or — because the daemon runs as PID 1 in containers and a
 *      restarted daemon collides with the dead holder's PID — when the lock is
 *      older than a TTL well above the run's hard timeout.
 *
 * The handler never propagates exceptions from the run path — `runBackgroundJob`
 * absorbs them and returns a structured result. A thrown error before the
 * runner is invoked (e.g. mkdir failures) bubbles up and the jobs-worker
 * treats it as a retryable failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getDisableBackgroundMemory } from "../../config/env-registry.js";
import type { AssistantConfig } from "../../config/types.js";
import { runBackgroundJob } from "../../runtime/background-job-runner.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import {
  formatBufferTimestamp,
  matchBufferEntryStart,
} from "../buffer-format.js";
import { deleteConversation } from "../conversation-crud.js";
import { listConversationsBySource } from "../conversation-queries.js";
import {
  enqueueMemoryJob,
  type MemoryJob,
  type MemoryJobType,
} from "../jobs-store.js";
import {
  CONSOLIDATION_TIMEOUT_MS,
  getConsolidationLockPath,
  releaseLock,
  STALE_LOCK_TTL_MS,
  tryAcquireLock,
} from "./consolidation-lock.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./constants.js";
import { resolveConsolidationPrompt } from "./prompts/consolidation.js";

const log = getLogger("memory-v2-consolidate");

/** Stable identifier surfaced in `runBackgroundJob` logs and notifications. */
const JOB_NAME = "memory.consolidate";

/**
 * v3 plugin flags. Either being on enqueues `memory_v3_maintain` as a
 * post-consolidation follow-up. These gate the v3 plugin itself.
 */
const MEMORY_V3_SHADOW = "memory-v3-shadow" as const;
const MEMORY_V3_LIVE = "memory-v3-live" as const;

/**
 * Age past which a leftover consolidation conversation is reclaimed by
 * {@link sweepStaleConsolidationConversations}. Consolidation runs on
 * EPHEMERAL conversations — `runBackgroundJob` deletes the row when the run
 * settles — so under normal operation nothing matches this sweep. Leftovers
 * exist only when (a) the run TIMED OUT (the runner keeps the row because the
 * raced turn may still be writing) or (b) the daemon crashed mid-run. Reusing
 * the lock's stale TTL guarantees the previous run's turn is long dead: a run
 * holds its conversation for at most `CONSOLIDATION_TIMEOUT_MS`, and the
 * sweep runs under the consolidation lock so no sibling run is in flight.
 */
const STALE_CONVERSATION_TTL_MS = STALE_LOCK_TTL_MS;

/** Max stale conversations reclaimed per run — bounds sweep cost per pass. */
const STALE_CONVERSATION_SWEEP_LIMIT = 100;

/**
 * Follow-up jobs to fan out after a successful consolidation.
 *
 * Conservatively re-embeds every page rather than tracking which pages the
 * agent touched: mtime-diffing is fragile across filesystems, and the
 * embedder's content-hash cache makes unchanged pages effectively free.
 */
const FOLLOW_UP_JOB_TYPES: readonly MemoryJobType[] = ["memory_v2_reembed"];

/** Follow-up enqueued only when a v3 flag is on. */
const V3_FOLLOW_UP_JOB_TYPE: MemoryJobType = "memory_v3_maintain";

/**
 * Job handler. See file header for the full lifecycle. Returns a discriminated
 * union so tests can assert on the path taken (disabled / locked / empty /
 * invoked / failed) without having to spy on the filesystem.
 */
export type ConsolidationOutcome =
  | { kind: "disabled" }
  | { kind: "locked"; holder: string }
  | { kind: "empty_buffer" }
  | { kind: "run_failed"; reason?: string }
  | {
      kind: "invoked";
      conversationId: string;
      cutoff: string;
      /**
       * Buffer entries beyond `consolidation_max_entries_per_run` left for a
       * follow-up pass via the pulled-back cutoff. `0` when the whole buffer
       * fit in one run.
       */
      deferredEntries: number;
      followUpJobIds: string[];
    };

export async function memoryV2ConsolidateJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<ConsolidationOutcome> {
  if (getDisableBackgroundMemory()) {
    log.debug("CUE_DISABLE_BACKGROUND_MEMORY set; consolidation skipped");
    return { kind: "disabled" };
  }
  if (config.memory.enabled === false) {
    log.debug("memory.enabled is false; consolidation skipped");
    return { kind: "disabled" };
  }

  if (!config.memory.v2.enabled) {
    log.debug("memory.v2.enabled is false; consolidation skipped");
    return { kind: "disabled" };
  }

  const memoryDir = join(getWorkspaceDir(), "memory");
  const lockPath = getConsolidationLockPath(memoryDir);
  const bufferPath = join(memoryDir, "buffer.md");

  // Step 1: acquire lock. Bails immediately if another consolidation is
  // already in flight — the next scheduled run can pick up where we leave off.
  const holder = tryAcquireLock(lockPath);
  if (holder !== null) {
    log.warn({ lockPath, holder }, "consolidation skipped: lock already held");
    return { kind: "locked", holder };
  }

  try {
    // Reclaim leftover consolidation conversations from timed-out or crashed
    // prior runs (normal runs are ephemeral — the runner deletes their row).
    // Runs under the lock so it can never race an in-flight sibling.
    sweepStaleConsolidationConversations();

    // Step 2: bail on empty buffer. Nothing for the agent to consolidate.
    // The lock is released in finally below.
    const bufferContent = readBufferContent(bufferPath);
    if (bufferContent.trim().length === 0) {
      log.debug("buffer.md empty; consolidation skipped");
      return { kind: "empty_buffer" };
    }

    // Step 3: capture cutoff. Formatted to match `buffer.md` entry timestamps
    // (`Mon D, h:mm AM/PM`, see `formatBufferTimestamp`) so the agent's
    // "timestamp ≥ cutoff" check compares like-with-like at minute precision.
    // Same-minute entries land on the next pass — conservative but loss-free.
    // Captured here (not at enqueue time) so late-claimed rows get a fresh
    // cutoff.
    //
    // Chunking: when the buffer holds more than
    // `consolidation_max_entries_per_run` entries (a backlog from missed or
    // failed runs), pull the cutoff back to the first over-cap entry's
    // timestamp. The agent's existing "≥ cutoff stays" rule then defers the
    // overflow loss-free, and the `consolidation_max_buffer_lines` size
    // trigger re-fires while the remainder stays over threshold — so one run
    // never has to read an unbounded backlog into context. Entries sharing
    // the over-cap entry's minute are also deferred (conservative).
    //
    // Entries are counted by their timestamped bullet-start lines
    // (`- [Mon D, h:mm AM/PM] …`) rather than raw non-empty lines: a
    // remembered fact can carry embedded newlines, and its continuation
    // lines belong to the preceding entry, not the count.
    let cutoff = formatBufferTimestamp(new Date());
    let deferredEntries = 0;
    const maxEntries = config.memory.v2.consolidation_max_entries_per_run;
    if (maxEntries != null) {
      const entryTimestamps = bufferContent
        .split("\n")
        .map(extractBufferEntryTimestamp)
        .filter((timestamp): timestamp is string => timestamp !== null);
      if (entryTimestamps.length > maxEntries) {
        const overflowTimestamp = entryTimestamps[maxEntries];
        // Same-minute burst guard: timestamps have minute precision, so when
        // even the FIRST entry shares the over-cap entry's timestamp, a
        // pulled-back cutoff would tell the agent to defer every entry
        // ("timestamp ≥ cutoff stays") — zero progress, and the size trigger
        // would requeue the identical run forever. Fall back to the
        // full-buffer cutoff in that case; partial same-minute runs (some
        // earlier entries have older timestamps) still make progress.
        if (entryTimestamps[0] === overflowTimestamp) {
          log.warn(
            {
              bufferEntries: entryTimestamps.length,
              maxEntries,
              overflowTimestamp,
            },
            "consolidation: entire over-cap prefix shares one minute timestamp; processing full buffer to guarantee progress",
          );
        } else {
          cutoff = overflowTimestamp;
          deferredEntries = entryTimestamps.length - maxEntries;
          log.info(
            {
              bufferEntries: entryTimestamps.length,
              maxEntries,
              deferredEntries,
              cutoff,
            },
            "consolidation chunked: buffer over per-run cap, overflow deferred to next pass",
          );
        }
      }
    }

    // Step 4: hand off to the centralized background-job runner. The runner
    // bootstraps the conversation, drives `processMessage`, applies the
    // timeout policy, classifies errors, and — because we opt out via
    // `suppressFailureNotifications` — does NOT emit an `activity.failed`
    // notification on transient failures. Consolidation runs on tight
    // intervals; a network blip or model hiccup should not spam the feed.
    // Sentry-side reporting is unchanged.
    //
    // The prompt body comes from `resolveConsolidationPrompt`, which honors
    // the `memory.v2.consolidation_prompt_path` config override but bounds
    // it to a regular file under 1 MiB before substitution so a stray path
    // (or a `/dev/zero`-style pseudo-file) cannot exfiltrate megabytes of
    // bytes through the wake hint. The core-pages curation section rides the
    // same v3 gate as the maintenance follow-up: the file feeds the v3 core
    // lane, so on a v2-only install the instruction would curate a file
    // nothing reads.
    // The article SHAPE is keyed on the live flag alone: under shadow, live
    // prompts are still assembled by v2's injection model, so consolidation
    // must keep producing `summary:`-bearing fragment pages until the flip.
    const memoryV3Live = isAssistantFeatureFlagEnabled(MEMORY_V3_LIVE, config);
    const memoryV3Active =
      isAssistantFeatureFlagEnabled(MEMORY_V3_SHADOW, config) || memoryV3Live;
    const prompt = resolveConsolidationPrompt(
      config.memory.v2.consolidation_prompt_path,
      cutoff,
      {
        includeCorePagesSection: memoryV3Active,
        articleShape: memoryV3Live ? "v3" : "v2",
      },
    );

    const runResult = await runBackgroundJob({
      jobName: JOB_NAME,
      source: MEMORY_V2_CONSOLIDATION_SOURCE,
      prompt,
      systemHint: "Memory consolidation",
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      callSite: "memoryV2Consolidation",
      timeoutMs: CONSOLIDATION_TIMEOUT_MS,
      origin: "memory_consolidation",
      suppressFailureNotifications: true,
      // Consolidation's useful output is its memory-file writes (concept
      // pages, recent.md, buffer trim) — the conversation transcript is
      // scaffolding. Hourly runs each persisting a conversation row was the
      // source of the 45k-row conversations-table runaway; the runner
      // deletes the row once the run settles (timeout leftovers are
      // reclaimed by the sweep above on the next pass).
      ephemeralConversation: true,
    });

    if (!runResult.ok) {
      log.error(
        {
          conversationId: runResult.conversationId,
          errorKind: runResult.errorKind,
          err: runResult.error?.message,
        },
        "consolidation run failed; follow-ups skipped",
      );
      return runResult.error?.message !== undefined
        ? { kind: "run_failed", reason: runResult.error.message }
        : { kind: "run_failed" };
    }

    // Step 5: enqueue follow-up jobs. Enqueueing now keeps the dispatch
    // wiring exercised end-to-end so PR 21 only has to swap in the handler
    // bodies. v3 maintenance is appended only while a v3 path (shadow or live)
    // is active, so it never fans out on v2-only installs.
    const followUpJobIds: string[] = [];
    const jobTypes: MemoryJobType[] = [...FOLLOW_UP_JOB_TYPES];
    if (memoryV3Active) {
      jobTypes.push(V3_FOLLOW_UP_JOB_TYPE);
    }
    for (const jobType of jobTypes) {
      try {
        followUpJobIds.push(enqueueMemoryJob(jobType, {}));
      } catch (err) {
        // Best-effort: a failed enqueue here doesn't undo the agent's writes,
        // and the next scheduled consolidation will attempt the same fan-out.
        log.warn(
          { err, jobType },
          "consolidation: failed to enqueue follow-up job; continuing",
        );
      }
    }

    log.info(
      {
        conversationId: runResult.conversationId,
        cutoff,
        deferredEntries,
        followUpJobIds,
      },
      "consolidation invoked",
    );
    return {
      kind: "invoked",
      conversationId: runResult.conversationId,
      cutoff,
      deferredEntries,
      followUpJobIds,
    };
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Delete leftover consolidation conversations older than
 * {@link STALE_CONVERSATION_TTL_MS}.
 *
 * Consolidation conversations are ephemeral (deleted by `runBackgroundJob`
 * when the run settles), so anything this sweep matches is a timeout or
 * crash leftover — plus any backlog persisted by builds that predate the
 * ephemeral change. Best-effort: per-row delete failures are logged and the
 * sweep continues; the next run gets another shot. Exported for tests.
 */
export function sweepStaleConsolidationConversations(
  now: number = Date.now(),
): number {
  let stale: ReturnType<typeof listConversationsBySource>;
  try {
    stale = listConversationsBySource(
      MEMORY_V2_CONSOLIDATION_SOURCE,
      STALE_CONVERSATION_SWEEP_LIMIT,
      { beforeCreatedAt: now - STALE_CONVERSATION_TTL_MS },
    );
  } catch (err) {
    log.warn(
      { err },
      "consolidation: failed to list stale consolidation conversations; skipping sweep",
    );
    return 0;
  }
  let swept = 0;
  for (const row of stale) {
    try {
      deleteConversation(row.id);
      swept++;
    } catch (err) {
      log.warn(
        { err, conversationId: row.id },
        "consolidation: failed to delete stale consolidation conversation; continuing",
      );
    }
  }
  if (swept > 0) {
    log.info({ swept }, "consolidation: swept stale run conversations");
  }
  return swept;
}

/**
 * Read `memory/buffer.md`. Missing file → empty string so the skip-on-empty
 * branch doesn't have to distinguish "no file" from "blank file".
 */
function readBufferContent(bufferPath: string): string {
  try {
    return readFileSync(bufferPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Extract the bracketed timestamp from a `buffer.md` entry line
 * (`- [Mon D, h:mm AM/PM] …`, see `formatRememberEntry`). Returned verbatim
 * so it can serve directly as a consolidation cutoff — both sides of the
 * agent's "timestamp ≥ cutoff" comparison then share the exact
 * `formatBufferTimestamp` shape.
 *
 * Recognition is delegated to the shared matcher in `../buffer-format.ts`,
 * so a remembered fact's continuation lines never register as entries. That
 * matters here beyond tidiness: counting a fact's `- [ ] …` checklist lines
 * or an indented entry-shaped body line as entries would inflate the per-run
 * budget, or hand the agent a cutoff drawn from the middle of a fact.
 */
function extractBufferEntryTimestamp(line: string): string | null {
  return matchBufferEntryStart(line)?.timestamp ?? null;
}

/**
 * Count non-empty lines in `memory/buffer.md`. Used by the scheduler to
 * implement the size-based consolidation trigger. Missing file → 0.
 *
 * Lines, deliberately, not entries. A multiline `remember()` fact is one
 * entry spread over several lines, so the two counts diverge and each answers
 * a different question. This trigger and the injected-Buffer cap that reuses
 * it (`capBufferSection` in `static-context.ts`) both care about how much
 * context the buffer costs, which scales with lines. The per-run budget
 * `consolidation_max_entries_per_run` cares about how many facts the agent
 * must file, so it counts entry-start lines instead.
 *
 * Do not "fix" this to count entries: a single 200-line fact is a context
 * problem the trigger should fire on, even though it is one entry. Blank
 * lines and trailing newlines don't inflate the count.
 */
export function countBufferLines(bufferPath: string): number {
  const content = readBufferContent(bufferPath);
  if (content.length === 0) return 0;
  return content.split("\n").filter((line) => line.trim().length > 0).length;
}
