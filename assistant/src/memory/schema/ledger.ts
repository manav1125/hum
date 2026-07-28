import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The autonomy ledger — an append-only record of every CONSEQUENTIAL action
 * Cue attempted on the owner's behalf: the high-consequence classes the
 * approval gate recognises (send / contact / money / publish / delete /
 * purchase, plus network-egress shells, browser submit controls, script-mode
 * schedules and opaque external runners) and host file mutations.
 *
 * This is deliberately NOT `tool_invocations` and NOT `agent_acts`:
 *
 *   · `tool_invocations` is a raw per-conversation technical audit log. It is
 *     rotated by `auditLogRetentionDays` AND deleted with its conversation
 *     (the conversation prune wipes it), and it carries no notion of
 *     attended/unattended, approval provenance, or the target reached.
 *   · `agent_acts` is the value/trust ledger — one row per COMPLETED
 *     background work-item run. It answers "how much did Cue do for me", not
 *     "what did Cue do to the outside world".
 *
 * This table answers the question that went unanswered when a background run
 * emailed an external partner with no approval: *what did Cue actually DO on
 * my behalf while I wasn't watching?* One row per consequential attempt,
 * whatever the outcome — executed, parked, denied, or failed — with who
 * authorised it and what it reached.
 *
 * Rows are standalone by design: no foreign keys, so deleting a conversation
 * never erases the record of what was done from it. Written best-effort from
 * the single tool chokepoint (`ToolExecutor`); a write failure is logged and
 * swallowed and can never fail a tool call. Bounded by both age and row count
 * (see `ledger/autonomy-ledger-store.ts`) — this database has a history of
 * runaway growth.
 */
export const autonomyLedger = sqliteTable(
  "autonomy_ledger",
  {
    id: text("id").primaryKey(),
    /** Epoch ms the action reached its outcome. */
    at: integer("at").notNull(),
    /** The tool as invoked, namespace included (`gmail__GMAIL_SEND_EMAIL`). */
    toolName: text("tool_name").notNull(),
    /**
     * The consequence class: 'send' | 'contact' | 'money' | 'publish' |
     * 'delete' | 'purchase' | 'host_file' | 'network_egress' |
     * 'browser_submit' | 'schedule_script' | 'external_runner' | 'other'.
     */
    actionClass: text("action_class").notNull(),
    /** One human-readable sentence: what Cue did, redacted. */
    summary: text("summary").notNull(),
    /** Recipient / host / URL / path reached, when known. Redacted. */
    target: text("target"),
    /** 'executed' | 'parked' | 'denied' | 'failed'. */
    outcome: text("outcome").notNull(),
    /** 0/1 — was a human present (interactive client attached) at the time. */
    attended: integer("attended").notNull(),
    /**
     * How the action was authorised, when it ran: 'inline_card' (the owner
     * answered a confirmation), 'trust_rule' (a standing always-allow rule
     * matched), 'scoped_grant', or 'auto' (no human in the loop). Null on
     * parked/denied/failed-before-approval rows — nothing was authorised.
     */
    approvedVia: text("approved_via"),
    /** Free-text provenance detail (approval reason / matched rule id). */
    approvalDetail: text("approval_detail"),
    /** Conversation the action ran in. Not an FK — see the module doc. */
    conversationId: text("conversation_id"),
    /** Work item whose run this was, resolved best-effort at write time. */
    workItemId: text("work_item_id"),
    /** The assignee credited with the run ("cue" when unattributed). */
    agent: text("agent"),
    /** Per-turn request id, for correlating with logs. */
    requestId: text("request_id"),
    /** Wall-clock ms the attempt took. */
    durationMs: integer("duration_ms"),
    /** Error / denial reason, redacted and truncated. Null when it ran. */
    reason: text("reason"),
  },
  (table) => [
    index("idx_autonomy_ledger_at").on(table.at),
    index("idx_autonomy_ledger_outcome_at").on(table.outcome, table.at),
    index("idx_autonomy_ledger_conversation").on(table.conversationId),
  ],
);
