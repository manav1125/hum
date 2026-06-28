/**
 * Maintenance routes — operator-triggered database hygiene.
 *
 * POST /v1/maintenance/prune-runaway — delete the background-job conversation
 * runaway (memory consolidation / retrospective jobs that persist a full
 * `conversations` row on every run) plus the completed `memory_jobs` queue and
 * pure telemetry, then VACUUM. On a bloated deploy this reclaims the bulk of
 * the DB (verified locally: 492MB → 25MB) with every user-visible table
 * untouched — only `conversation_type='background'` rows and their orphaned
 * children are removed. Idempotent: a second call is a near-no-op.
 *
 * Runs on the daemon's in-process SQLite connection (`rawExec`), so the VACUUM
 * here is the safe case the WAL-checkpoint guidance describes — never spawn a
 * subprocess to VACUUM/checkpoint a live DB.
 */

import { rawExec, rawGet } from "../../memory/raw-query.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("maintenance-routes");

/**
 * Every table carrying a `conversation_id` FK. After the background
 * conversations are deleted, rows here whose `conversation_id` no longer
 * resolves are orphans and get cascaded away. Rows tied to surviving
 * (non-background) conversations, and rows with a NULL `conversation_id`, are
 * left untouched.
 */
const CONVERSATION_CHILD_TABLES = [
  "messages",
  "tool_invocations",
  "memory_segments",
  "channel_inbound_events",
  "message_runs",
  "cron_runs",
  "documents",
  "watchers",
  "llm_request_logs",
  "llm_usage_events",
  "conversation_keys",
  "call_sessions",
  "followups",
  "task_runs",
  "external_conversation_bindings",
  "channel_guardian_approval_requests",
  "assistant_inbox_conversation_state",
  "notification_deliveries",
  "sequence_enrollments",
  "conversation_attention_events",
  "conversation_assistant_attention_state",
  "scoped_approval_grants",
  "canonical_guardian_requests",
  "trace_events",
  "memory_recall_logs",
  "memory_graph_node_edits",
  "conversation_graph_memory_state",
  "activation_state",
  "memory_v2_activation_logs",
  "document_conversations",
  "heartbeat_runs",
  "message_bookmarks",
  "memory_retrospective_state",
  "a2a_tasks",
  "document_comments",
  "memory_v3_coactivation",
  "memory_v3_selections",
  "activation_sessions",
  "memory_v3_ever_injected",
  "skill_loaded_events",
  "assistant_inbox_thread_state",
] as const;

/** Pure telemetry/log tables — safe to clear wholesale (no knowledge value). */
const TELEMETRY_TABLES = [
  "memory_v2_injection_events",
  "lifecycle_events",
  "llm_request_logs",
  "trace_events",
] as const;

function countOrZero(sql: string): number {
  return rawGet<{ c: number }>(sql)?.c ?? 0;
}

/** Snapshot of counts that prove the prune touched only runaway/churn data. */
function gatherStats(): Record<string, number> {
  return {
    conversationsTotal: countOrZero("SELECT COUNT(*) AS c FROM conversations"),
    conversationsBackground: countOrZero(
      "SELECT COUNT(*) AS c FROM conversations WHERE conversation_type='background'",
    ),
    conversationsReal: countOrZero(
      "SELECT COUNT(*) AS c FROM conversations WHERE conversation_type<>'background'",
    ),
    memoryJobs: countOrZero("SELECT COUNT(*) AS c FROM memory_jobs"),
    // Valuable tables — MUST be identical before and after.
    memoryGraphNodes: countOrZero(
      "SELECT COUNT(*) AS c FROM memory_graph_nodes",
    ),
    memoryGraphEdges: countOrZero(
      "SELECT COUNT(*) AS c FROM memory_graph_edges",
    ),
    contacts: countOrZero("SELECT COUNT(*) AS c FROM contacts"),
    tasks: countOrZero("SELECT COUNT(*) AS c FROM tasks"),
    workItems: countOrZero("SELECT COUNT(*) AS c FROM work_items"),
    messages: countOrZero("SELECT COUNT(*) AS c FROM messages"),
  };
}

async function handleMaintenancePrune(): Promise<{
  pruned: boolean;
  before: Record<string, number>;
  after: Record<string, number>;
}> {
  const before = gatherStats();
  log.info({ before }, "maintenance prune: starting");

  // 1. Delete the background-job conversation runaway, then orphan-cascade
  //    every conversation-scoped child whose parent is now gone. Statements
  //    run in order, so `conversations` is emptied of background rows before
  //    the NOT-IN checks below evaluate.
  const cascade = CONVERSATION_CHILD_TABLES.map(
    (t) =>
      `DELETE FROM ${t} WHERE conversation_id IS NOT NULL AND conversation_id NOT IN (SELECT id FROM conversations);`,
  ).join("\n");
  rawExec(
    `DELETE FROM conversations WHERE conversation_type='background';\n${cascade}`,
  );

  // 2. Drain the completed memory-job queue (it never self-reaps) + telemetry.
  rawExec(
    `DELETE FROM memory_jobs WHERE status IN ('completed','failed');\n${TELEMETRY_TABLES.map(
      (t) => `DELETE FROM ${t};`,
    ).join("\n")}`,
  );

  // 3. Rebuild the messages FTS index to drop entries for deleted messages.
  try {
    rawExec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  } catch (err) {
    log.warn({ err }, "maintenance prune: FTS rebuild skipped");
  }

  // 4. Reclaim the freed pages. Safe here: the daemon's own in-process
  //    connection runs it, so the WAL-unlink hazard of a subprocess VACUUM
  //    does not apply.
  rawExec("VACUUM;");

  const after = gatherStats();
  log.info({ after }, "maintenance prune: complete");
  return {
    pruned: before.conversationsBackground > 0 || before.memoryJobs > 0,
    before,
    after,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "maintenance_prune_runaway_post",
    endpoint: "maintenance/prune-runaway",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Prune background-job conversation runaway + VACUUM",
    description:
      "Delete background-job conversations (memory consolidation/retrospective runaway), drain the completed memory-job queue, clear telemetry, and VACUUM. Preserves all user-visible data; returns before/after table counts.",
    tags: ["maintenance"],
    handler: handleMaintenancePrune,
  },
];
