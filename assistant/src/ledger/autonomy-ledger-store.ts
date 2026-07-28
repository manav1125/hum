/**
 * The autonomy-ledger store — durable, append-only, bounded.
 *
 * Contract, in one line: **the ledger observes, it never blocks.** Every write
 * path here swallows its own failures (logging at warn) exactly like
 * `recordWorkItemEvent` / `recordAgentAct`, because the sole caller is the tool
 * executor and a ledger failure must never fail a tool call.
 *
 * Retention is enforced on write. This database has a documented history of
 * runaway growth (45k background-job conversations → a 500MB assistant.db), so
 * the ledger is capped on BOTH axes:
 *
 *   · age  — rows older than {@link LEDGER_RETENTION_DAYS} are deleted;
 *   · count — only the newest {@link LEDGER_MAX_ROWS} rows are kept.
 *
 * The prune is amortised (every {@link PRUNE_EVERY_N_WRITES} inserts, plus the
 * first insert after process start) so a consequential action never pays for a
 * full sweep. Consequential actions are rare by construction — the ledger only
 * sees the class the approval gate hard-checkpoints — so both caps are
 * generous: at the cap the table is a few MB, not hundreds.
 */

import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { autonomyLedger } from "../memory/schema/index.js";
import { redactSecrets } from "../security/secret-scanner.js";
import { getLogger } from "../util/logger.js";
import type {
  ConsequentialActionClass,
  LedgerOutcome,
} from "./consequential-action.js";

const log = getLogger("autonomy-ledger");

/** Rows older than this are pruned. ~6 months of "what did Cue do". */
export const LEDGER_RETENTION_DAYS = 180;

/** Hard row ceiling; the newest rows win. */
export const LEDGER_MAX_ROWS = 20_000;

/** Amortisation interval for the retention sweep. */
const PRUNE_EVERY_N_WRITES = 50;

/** Longest text any single ledger column will store. */
const MAX_TEXT = 500;

/** How the action was authorised, when it ran. */
export type LedgerApprovalMode =
  | "inline_card"
  | "trust_rule"
  | "scoped_grant"
  | "auto";

export interface AutonomyLedgerEntry {
  id: string;
  at: number;
  toolName: string;
  actionClass: ConsequentialActionClass;
  summary: string;
  target: string | null;
  outcome: LedgerOutcome;
  /** 0/1 — a human was present when this happened. */
  attended: number;
  approvedVia: LedgerApprovalMode | null;
  approvalDetail: string | null;
  conversationId: string | null;
  workItemId: string | null;
  agent: string | null;
  requestId: string | null;
  durationMs: number | null;
  reason: string | null;
}

export interface RecordLedgerEntryInput {
  toolName: string;
  actionClass: ConsequentialActionClass;
  summary: string;
  target?: string | null;
  outcome: LedgerOutcome;
  attended: boolean;
  approvedVia?: LedgerApprovalMode | null;
  approvalDetail?: string | null;
  conversationId?: string | null;
  requestId?: string | null;
  durationMs?: number | null;
  reason?: string | null;
  at?: number;
}

/** Redact + bound one free-text field before it is persisted. */
function scrub(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const redacted = redactSecrets(trimmed);
  return redacted.length <= MAX_TEXT
    ? redacted
    : `${redacted.slice(0, MAX_TEXT - 1)}…`;
}

let writesSincePrune = PRUNE_EVERY_N_WRITES;

/**
 * Resolve the work item (and its assignee) behind a run conversation, using
 * the same `last_run_conversation_id` binding the Guardrails held-approval and
 * spend attribution reads use. Best-effort: a miss or a failure just leaves the
 * row unattributed.
 */
function resolveRunAttribution(conversationId: string | null | undefined): {
  workItemId: string | null;
  agent: string | null;
} {
  if (!conversationId) return { workItemId: null, agent: null };
  try {
    const row = getSqliteFrom(getDb())
      .prepare(
        /*sql*/ `SELECT id, assignee FROM work_items
                 WHERE last_run_conversation_id = ?
                 LIMIT 1`,
      )
      .get(conversationId) as
      | { id: string; assignee: string | null }
      | undefined;
    if (!row) return { workItemId: null, agent: null };
    return { workItemId: row.id, agent: row.assignee?.trim() || "cue" };
  } catch {
    return { workItemId: null, agent: null };
  }
}

/**
 * Append one consequential action to the ledger. Returns the written row, or
 * null when the write failed — **never throws**.
 */
export function recordAutonomyLedgerEntry(
  input: RecordLedgerEntryInput,
): AutonomyLedgerEntry | null {
  try {
    const { workItemId, agent } = resolveRunAttribution(input.conversationId);
    const entry: AutonomyLedgerEntry = {
      id: randomUUID(),
      at: input.at ?? Date.now(),
      toolName: input.toolName.slice(0, MAX_TEXT),
      actionClass: input.actionClass,
      summary: scrub(input.summary) ?? "Cue took a consequential action.",
      target: scrub(input.target),
      outcome: input.outcome,
      attended: input.attended ? 1 : 0,
      approvedVia: input.approvedVia ?? null,
      approvalDetail: scrub(input.approvalDetail),
      conversationId: input.conversationId ?? null,
      workItemId,
      agent,
      requestId: input.requestId ?? null,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
      reason: scrub(input.reason),
    };

    getDb().insert(autonomyLedger).values(entry).run();

    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY_N_WRITES) {
      writesSincePrune = 0;
      pruneAutonomyLedger();
    }

    return entry;
  } catch (err) {
    log.warn(
      {
        err: String(err),
        toolName: input.toolName,
        outcome: input.outcome,
      },
      "autonomy-ledger write failed (ignored — the tool call was not affected)",
    );
    return null;
  }
}

/**
 * Enforce both retention bounds. Best-effort and never throws; returns the
 * number of rows deleted (0 on failure).
 */
export function pruneAutonomyLedger(opts?: {
  retentionDays?: number;
  maxRows?: number;
}): number {
  const retentionDays = opts?.retentionDays ?? LEDGER_RETENTION_DAYS;
  const maxRows = opts?.maxRows ?? LEDGER_MAX_ROWS;
  try {
    const raw = getSqliteFrom(getDb());
    let deleted = 0;

    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      deleted += raw
        .prepare(/*sql*/ `DELETE FROM autonomy_ledger WHERE at < ?`)
        .run(cutoff).changes;
    }

    if (Number.isFinite(maxRows) && maxRows > 0) {
      // Keep the newest `maxRows`; `rowid` breaks ties inside one millisecond.
      deleted += raw
        .prepare(
          /*sql*/ `DELETE FROM autonomy_ledger
                   WHERE id NOT IN (
                     SELECT id FROM autonomy_ledger
                     ORDER BY at DESC, rowid DESC
                     LIMIT ?
                   )`,
        )
        .run(maxRows).changes;
    }

    return deleted;
  } catch (err) {
    log.warn({ err: String(err) }, "autonomy-ledger prune failed (ignored)");
    return 0;
  }
}

export interface ListLedgerOptions {
  limit?: number;
  /** Only rows at or after this epoch ms. */
  since?: number;
  /** Only rows at or before this epoch ms. */
  until?: number;
  outcome?: LedgerOutcome;
  actionClass?: ConsequentialActionClass;
  /** true = only rows that happened with NO human present. */
  unattendedOnly?: boolean;
  conversationId?: string;
}

/** Newest-first ledger rows. Reads throw — only writes are best-effort. */
export function listAutonomyLedger(
  opts?: ListLedgerOptions,
): AutonomyLedgerEntry[] {
  const db = getDb();
  const conditions = [];
  if (opts?.since != null) conditions.push(gte(autonomyLedger.at, opts.since));
  if (opts?.until != null) conditions.push(lte(autonomyLedger.at, opts.until));
  if (opts?.outcome) conditions.push(eq(autonomyLedger.outcome, opts.outcome));
  if (opts?.actionClass) {
    conditions.push(eq(autonomyLedger.actionClass, opts.actionClass));
  }
  if (opts?.unattendedOnly) {
    conditions.push(eq(autonomyLedger.attended, 0));
  }
  if (opts?.conversationId) {
    conditions.push(eq(autonomyLedger.conversationId, opts.conversationId));
  }

  return db
    .select()
    .from(autonomyLedger)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(autonomyLedger.at), sql`rowid DESC`)
    .limit(Math.max(1, Math.min(opts?.limit ?? 50, 500)))
    .all() as AutonomyLedgerEntry[];
}

export interface AutonomyLedgerSummary {
  /** Rows in the window. */
  total: number;
  executed: number;
  parked: number;
  denied: number;
  failed: number;
  /** Executed rows that ran with NO human present — the number that matters. */
  executedUnattended: number;
  /** Executed rows nobody explicitly approved (approvedVia 'auto' or null). */
  executedWithoutApproval: number;
  byClass: Array<{ actionClass: ConsequentialActionClass; count: number }>;
}

/** Counts over a trailing window (default 30 days). */
export function getAutonomyLedgerSummary(opts?: {
  days?: number;
}): AutonomyLedgerSummary {
  const days = opts?.days != null && opts.days > 0 ? opts.days : 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const raw = getSqliteFrom(getDb());

  const totals = raw
    .prepare(
      /*sql*/ `SELECT
         COUNT(*)                                                       AS total,
         SUM(outcome = 'executed')                                      AS executed,
         SUM(outcome = 'parked')                                        AS parked,
         SUM(outcome = 'denied')                                        AS denied,
         SUM(outcome = 'failed')                                        AS failed,
         SUM(outcome = 'executed' AND attended = 0)                     AS executed_unattended,
         SUM(outcome = 'executed'
             AND (approved_via IS NULL OR approved_via = 'auto'))       AS executed_without_approval
       FROM autonomy_ledger WHERE at >= ?`,
    )
    .get(since) as Record<string, number | null>;

  const byClass = (
    raw
      .prepare(
        /*sql*/ `SELECT action_class AS actionClass, COUNT(*) AS count
                 FROM autonomy_ledger WHERE at >= ?
                 GROUP BY action_class
                 ORDER BY count DESC, action_class ASC`,
      )
      .all(since) as Array<{ actionClass: string; count: number }>
  ).map((r) => ({
    actionClass: r.actionClass as ConsequentialActionClass,
    count: Number(r.count),
  }));

  return {
    total: Number(totals?.total ?? 0),
    executed: Number(totals?.executed ?? 0),
    parked: Number(totals?.parked ?? 0),
    denied: Number(totals?.denied ?? 0),
    failed: Number(totals?.failed ?? 0),
    executedUnattended: Number(totals?.executed_unattended ?? 0),
    executedWithoutApproval: Number(totals?.executed_without_approval ?? 0),
    byClass,
  };
}

/**
 * Test seam for the amortised prune counter.
 *
 * @param primed `true` reproduces process start (the next write sweeps);
 *               the default `false` suppresses the sweep so a test can seed
 *               fixtures with arbitrary timestamps.
 */
export function __resetLedgerPruneCounterForTests(primed = false): void {
  writesSincePrune = primed ? PRUNE_EVERY_N_WRITES : 0;
}
