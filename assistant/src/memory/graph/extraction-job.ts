// ---------------------------------------------------------------------------
// Memory Graph — Extraction job handler
//
// Wraps runGraphExtraction for the jobs worker. Handles both:
// - Mid-conversation batch extraction (incremental, from checkpoint)
// - End-of-conversation extraction (full transcript)
// ---------------------------------------------------------------------------

import type { AssistantConfig } from "../../config/types.js";
import { getLogger } from "../../util/logger.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "../checkpoints.js";
import {
  type JobOutcome,
  jobOutcomeFromDetail,
  jobSkipped,
} from "../job-outcome.js";
import { asString } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { runGraphExtraction } from "./extraction.js";

const log = getLogger("graph-extraction-job");

/**
 * Job handler for `graph_extract`. Runs incremental or full extraction
 * depending on whether a checkpoint exists for this conversation.
 *
 * Checkpoint key: `graph_extract:<conversationId>:last_ts`
 * Value: epoch ms of the most recent message processed.
 *
 * Trigger sources:
 * - Indexer after batchSize messages (default 10)
 * - Indexer idle debounce (default 300s)
 * - Conversation dispose (end of conversation)
 */
export async function graphExtractJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<JobOutcome> {
  const conversationId = asString(job.payload.conversationId);
  const scopeId = asString(job.payload.scopeId) || "default";
  if (!conversationId) return jobSkipped("no conversationId in the payload");

  // Read checkpoint for incremental extraction
  const checkpointKey = `graph_extract:${conversationId}:last_ts`;
  const lastTs = getMemoryCheckpoint(checkpointKey);
  const afterTimestamp = lastTs ? parseInt(lastTs, 10) : undefined;

  const activeContextNodeIds = Array.isArray(job.payload.activeContextNodeIds)
    ? (job.payload.activeContextNodeIds as string[])
    : undefined;

  try {
    const result = await runGraphExtraction(conversationId, scopeId, config, {
      afterTimestamp,
      activeContextNodeIds,
    });

    // Update checkpoint to the newest message actually processed — using
    // Date.now() could skip messages that arrived during extraction.
    if (result.lastProcessedTimestamp) {
      setMemoryCheckpoint(checkpointKey, String(result.lastProcessedTimestamp));
    }

    log.info(
      {
        conversationId,
        incremental: !!afterTimestamp,
        ...result,
      },
      "Graph extraction job complete",
    );

    // This log line already carried the answer. Roughly 190 of 237 runs in a
    // single day said `nodesCreated: 0` next to the word "complete", and the
    // job still reported ordinary success because nothing above it could tell
    // the two apart. The outcome is that difference, made returnable.
    //
    // A single quiet conversation genuinely yields nothing, so one empty run
    // is not a fault — see `job-outcome-health.ts` for the run that is.
    return jobOutcomeFromDetail(
      {
        nodesCreated: result.nodesCreated,
        nodesUpdated: result.nodesUpdated,
        nodesReinforced: result.nodesReinforced,
        edgesCreated: result.edgesCreated,
        triggersCreated: result.triggersCreated,
      },
      "read the conversation and found nothing worth adding to the graph",
    );
  } catch (err) {
    log.error(
      { conversationId, err: err instanceof Error ? err.message : String(err) },
      "Graph extraction job failed",
    );
    throw err;
  }
}
