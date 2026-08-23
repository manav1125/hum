import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { contacts } from "./contacts.js";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  template: text("template").notNull(),
  inputSchema: text("input_schema"),
  contextFlags: text("context_flags"),
  requiredTools: text("required_tools"),
  createdFromConversationId: text("created_from_conversation_id"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskRuns = sqliteTable("task_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id"),
  status: text("status").notNull().default("pending"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  error: text("error"),
  principalId: text("principal_id"),
  memoryScopeId: text("memory_scope_id"),
  createdAt: integer("created_at").notNull(),
});

export const taskCandidates = sqliteTable("task_candidates", {
  id: text("id").primaryKey(),
  sourceConversationId: text("source_conversation_id").notNull(),
  compiledTemplate: text("compiled_template").notNull(),
  confidence: real("confidence"),
  requiredTools: text("required_tools"), // JSON array string
  createdAt: integer("created_at").notNull(),
  promotedTaskId: text("promoted_task_id"), // set when candidate is promoted to a real task
});

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  title: text("title").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("queued"), // queued | running | awaiting_review | failed | cancelled | done | archived
  priorityTier: integer("priority_tier").notNull().default(1), // 0=high, 1=medium, 2=low
  sortIndex: integer("sort_index"), // manual ordering within same priority tier; null = fall back to updated_at
  lastRunId: text("last_run_id"),
  lastRunConversationId: text("last_run_conversation_id"),
  lastRunStatus: text("last_run_status"), // 'completed' | 'failed' | null
  sourceType: text("source_type"), // reserved for future bridge (e.g. 'followup', 'triage')
  sourceId: text("source_id"), // reserved for future bridge
  // 315-work-item-origin-conversation. The conversation this item was created
  // FROM — distinct from last_run_conversation_id (where the run happened) and
  // from source_type/source_id (which external CHANNEL it arrived on, which is
  // legitimately null for a local desktop/voice task). Lets the originating
  // thread show what it spawned and stops the thread agent re-doing work that
  // is already running or already done.
  originConversationId: text("origin_conversation_id"),
  requiredTools: text("required_tools"), // JSON array snapshot of tools needed for this run (null=unknown, []=none, ["bash",...]=specific)
  approvedTools: text("approved_tools"), // JSON array of pre-approved tool names
  approvalStatus: text("approval_status").default("none"), // 'none' | 'approved' | 'denied'
  projectId: text("project_id"), // nullable reference-by-convention to projects.id (store-enforced)
  dueAt: integer("due_at"), // nullable deadline, epoch ms (triage-extracted or user-set)
  labels: text("labels"), // nullable JSON array string of freeform labels
  assignee: text("assignee"), // nullable; null reads as "cue" (the AI runs it)
  taskBudgetCents: integer("task_budget_cents"), // WS1: per-task hard cap in cents; null/0 = unlimited (pre-WS1 behavior)
  context: text("context"), // nullable per-task notes/context the user adds; injected into the agent before a run
  sourceContext: text("source_context"), // nullable JSON: {origin, snippet} of where the task came from (triage-stamped)
  lastActivityAt: integer("last_activity_at"), // nullable epoch ms; bumped on any event/update so ranking de-prioritizes stale items
  lastProgressNote: text("last_progress_note"), // nullable one-line live-activity note ("Searching the web…") the runner stamps while status='running'
  // WS3 (303-work-item-liveness). recoveryAttempts: times the startup watchdog
  // requeued this item after a stranded run (bounds retries). livenessState:
  // null = healthy; 'recovered' = requeued after a daemon-restart orphan;
  // 'stalled' = hit the retry cap and was failed as a recovery incident.
  recoveryAttempts: integer("recovery_attempts").notNull().default(0),
  livenessState: text("liveness_state"),
  // 305-work-item-auto-run-eligibility. null = eligible for the policy-gated
  // auto-run path; 'parked' = user parked this task — it must never auto-run
  // (quick-add, plain to-dos, needs-you items). Cleared on explicit run.
  autoRunEligibility: text("auto_run_eligibility"),
  // 307-work-item-hygiene. completedElsewhere: 0/1 — the owner marked this
  // task done as "completed elsewhere" (the work happened outside Cue; no
  // output/run is claimed). autoFiledBy: null | 'cue' | 'user_unfiled' —
  // auto-file provenance ('cue' = the background auto-filer set project_id;
  // 'user_unfiled' = the user deliberately unfiled, never re-file).
  // autoFileConfidence: the auto-filer's 0–1 confidence, set with 'cue'.
  completedElsewhere: integer("completed_elsewhere").notNull().default(0),
  autoFiledBy: text("auto_filed_by"),
  autoFileConfidence: real("auto_file_confidence"),
  // 314-work-item-assessment. The pre-run assessment verdict: what Cue
  // understood the task to be, and whether it can actually do it with the
  // context it has. Written by work-items/work-item-assessment.ts before the
  // execution turn; null verdict = never assessed (pre-314 behaviour).
  // assessmentInputHash is the cache key — a matching hash reuses the stored
  // verdict instead of paying for another LLM call.
  assessmentVerdict: text("assessment_verdict"), // 'execute' | 'clarify' | 'not_ai_task' | 'blocked'
  assessmentUnderstanding: text("assessment_understanding"),
  assessmentPlan: text("assessment_plan"), // set with 'execute'
  assessmentQuestion: text("assessment_question"), // set with 'clarify' — exactly one question
  assessmentMissing: text("assessment_missing"), // set with 'blocked' — the one missing thing
  assessmentConfidence: real("assessment_confidence"),
  assessmentInputHash: text("assessment_input_hash"),
  assessmentAt: integer("assessment_at"),
  // 317-work-item-life-lens-and-waiting. domain: 'work' | 'life' — the same
  // rows on the same engine, organised on different axes (work groups by
  // mission, life groups by horizon). Also the privacy boundary: "hide Life"
  // is one predicate. Every pre-317 row is 'work'. horizon: 'this_week' |
  // 'soon' | 'someday', meaningful only for life items.
  domain: text("domain").notNull().default("work"),
  horizon: text("horizon"),
  // 317. waitingOn: reference-by-convention to contacts.id (store-enforced,
  // like project_id) — the person this item is blocked on, distinct from
  // `assignee` (who owns it). lastChasedAt: epoch ms of the last nudge; null
  // = never chased, which reads differently from "chased a while ago".
  waitingOn: text("waiting_on"),
  lastChasedAt: integer("last_chased_at"),
  // 318-arrivals. The `arrivals` row this item was surfaced from — set only
  // for items that came through the arrival relevance gate (watcher hits), so
  // a card can honestly say "Cue looked at this and kept it, because …" and
  // link to the filed siblings. Null on every item created any other way
  // (quick-add, chat, mission cycle) and on every pre-318 row. Deliberately
  // NOT auto_filed_by/auto_file_confidence: those mean "assigned to a
  // project", a different axis entirely.
  arrivalId: text("arrival_id"),
  // 332-notes. The `notes` row this item was ACCEPTED out of. Provenance runs
  // one way only: the task remembers the note, never the reverse, so deleting
  // a note leaves this id dangling on purpose and the card reads "from a note
  // you deleted". Cascading would mean tidying your notes silently empties
  // your HQ. Null on every item captured any other way and on every pre-332
  // row.
  noteId: text("note_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  emoji: text("emoji"),
  color: text("color"),
  status: text("status").notNull().default("active"), // 'active' | 'archived'
  category: text("category"), // nullable freeform bucket ("personal" | "professional" | "other" | …)
  context: text("context"), // nullable project brief/instructions the agent reads for every task in the project
  sortIndex: integer("sort_index"), // nullable manual ordering key (smaller sorts first)
  pinned: integer("pinned").notNull().default(0), // 0/1 — pinned projects float to the top
  missionId: text("mission_id"), // nullable reference-by-convention to missions.id (store-enforced) — initiatives link
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const projectKnowledge = sqliteTable("project_knowledge", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(), // reference-by-convention to projects.id (store-enforced)
  kind: text("kind").notNull(), // 'file' | 'link'
  attachmentId: text("attachment_id"), // set when kind='file'; reference-by-convention to attachments.id
  url: text("url"), // set when kind='link'
  label: text("label"), // display name; defaults to filename/url at the store layer
  addedAt: integer("added_at").notNull(),
});

/**
 * Sprint outputs — the first-class registry of deliverables produced by
 * work-item runs (docs, decks, sheets, images, videos…). One row per
 * deliverable, either file-backed (attachment_id) or an external pointer
 * (external_url). mission_id/project_id are denormalized at write time from
 * the owning work item so mission rollups are a single indexed read.
 * References are by convention (store-enforced, no FKs), matching
 * work_items.project_id.
 */
export const workOutputs = sqliteTable("work_outputs", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(), // reference-by-convention to work_items.id
  missionId: text("mission_id"), // denormalized from the work item's project at write time
  projectId: text("project_id"), // denormalized from the work item at write time
  attachmentId: text("attachment_id"), // set for file-backed outputs; reference-by-convention to attachments.id
  externalUrl: text("external_url"), // set for link-backed outputs (deployed site, shared doc…)
  kind: text("kind").notNull(), // 'document' | 'deck' | 'spreadsheet' | 'pdf' | 'image' | 'video' | 'other'
  title: text("title").notNull(),
  why: text("why"), // one-line "why it exists" purpose shown on the card
  agent: text("agent"), // the assignee that produced it (null reads as "cue")
  reviewState: text("review_state").notNull().default("pending"), // 'pending' | 'approved'
  createdAt: integer("created_at").notNull(),
});

/**
 * Act/reversal ledger — one row per autonomous act the agent completed on
 * the owner's behalf (today: completed background work-item runs). Powers
 * the "N acts · M reversed" trust evidence and the TIME BACK "~N hrs" chip.
 * `reversed` flips to 1 when the owner undoes the act (work-item redo or
 * output-review rejection). No backfill by design — honest zero-start.
 * References are by convention (store-enforced, no FKs), matching
 * work_outputs.
 */
export const agentActs = sqliteTable("agent_acts", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull().default("cue"), // the assignee that acted
  workItemId: text("work_item_id"), // reference-by-convention to work_items.id
  missionId: text("mission_id"), // denormalized from the work item's project at write time
  kind: text("kind").notNull(), // 'run_completed' | 'output_produced' | 'message_drafted' | 'schedule_fired' | 'other'
  title: text("title"), // human title of what the act did (the work item's title); null = no natural source
  reversed: integer("reversed").notNull().default(0), // 0/1 — the owner undid this act
  reversedAt: integer("reversed_at"), // epoch ms, set when reversed flips to 1
  estMinutesSaved: integer("est_minutes_saved"), // conservative heuristic estimate (see agent-act-store)
  costCents: integer("cost_cents"), // the run's real attributable LLM cost in cents; null = unknown, NOT zero
  model: text("model"), // dominant model of the run (highest summed cost); null = unknown
  createdAt: integer("created_at").notNull(),
});

/**
 * Agent registry — one row per standing role the owner staffs their company
 * with (Ops / Growth / Inbox / …). The server-side home for the Agents · org
 * page charters (replacing the Phase-1 localStorage config). `name` is both the
 * display name and the work-item `assignee` match key (matched case-insensitively);
 * `cue` is the implicit house agent and is not a row. References are by
 * convention (store-enforced, no FKs), matching the sibling HQ tables.
 */
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // display + work-item assignee match key (case-insensitive)
  emoji: text("emoji"), // single glyph for the role tile
  domain: text("domain"), // short domain blurb ("Operations")
  charter: text("charter"), // the standing mandate
  tier: text("tier").notNull().default("1"), // autonomy tier '1'..'4' (text for headroom)
  capCents: integer("cap_cents"), // weekly spend cap in cents; null = uncapped
  // WS1 budget policy (302-budget-policies). warnPercent: soft-alert threshold;
  // null = use the workspace config default. hardStopEnabled: 0 (default) =
  // cap_cents is advisory only (pre-WS1 behavior); 1 = the run-start budget
  // check pauses the agent's runs at cap_cents.
  warnPercent: integer("warn_percent"), // null = config default (e.g. 80)
  hardStopEnabled: integer("hard_stop_enabled").notNull().default(0), // 0/1
  paused: integer("paused").notNull().default(0), // 0/1
  model: text("model"), // per-agent model pin (provider/model string); null = no pin
  toolScopes: text("tool_scopes"), // JSON string array of coarse skill/domain ids; null = unrestricted
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Guardrail checkpoints — the "Cue always asks before…" rule registry behind
 * the Guardrails surface. `pattern` is the enforcement pattern the template
 * compiles to: `autonomy:<class>` patterns are enforced by the permission
 * checker (an enabled checkpoint tightens that autonomy category to "ask");
 * the legacy compiled patterns "tool:publish_*" / "contact:*" alias to
 * autonomy:publish / autonomy:contact; any other pattern form is
 * declarative-only. `scope` is 'everywhere',
 * 'agent:<agentId>', or 'mission:<missionId>'. References are by convention
 * (store-enforced, no FKs), matching the sibling HQ tables.
 */
export const guardrailCheckpoints = sqliteTable("guardrail_checkpoints", {
  id: text("id").primaryKey(),
  template: text("template").notNull(), // 'send_message' | 'spend_over' | 'publish' | 'delete' | 'contact' | 'custom'
  label: text("label").notNull(), // plain-English rule name
  pattern: text("pattern").notNull(), // compiled enforcement pattern (see module doc)
  scope: text("scope").notNull().default("everywhere"),
  thresholdCents: integer("threshold_cents"), // spend_over dollar line (advisory)
  enabled: integer("enabled").notNull().default(1), // 0/1
  isDefault: integer("is_default").notNull().default(0), // 0/1 — seeded starter rule
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Standing auto-confirm rules — the persisted "Make it a rule" decisions behind
 * the in-context rule card. After the owner confirms a one-off inbound
 * commitment, they can promote that decision into a STANDING rule so the same
 * class of item auto-runs next time instead of parking for approval:
 *
 *   trigger_type='sender'   trigger_value='Rachel'  → "auto-confirm anything from Rachel"
 *   trigger_type='channel'  trigger_value='slack'   → "auto-confirm anything from Slack"
 *   trigger_type='category' trigger_value='draft'   → "auto-confirm drafts"
 *   trigger_type='tool'     trigger_value='web_fetch'→ "auto-confirm web fetches"
 *
 * `action` is always 'auto_confirm' today (a column for headroom). A rule
 * LOOSENS the per-category autonomy policy's `policy_ask` deferral for MATCHING
 * work items only — it is consulted by the work-item auto-run gate
 * (work-items/work-item-triage.ts → maybeAutoRunWorkItem). It NEVER overrides
 * the hard-deny safety floor (host/browser/purchase/send/money never auto-run,
 * rule or no rule). Provenance columns record which one-off the rule was minted
 * from. References are by convention (store-enforced, no FKs), matching the
 * sibling HQ tables.
 */
export const standingRules = sqliteTable("standing_rules", {
  id: text("id").primaryKey(),
  triggerType: text("trigger_type").notNull(), // 'sender' | 'channel' | 'category' | 'tool'
  triggerValue: text("trigger_value").notNull(), // e.g. 'Rachel' | 'slack' | 'draft' | 'web_fetch'
  action: text("action").notNull().default("auto_confirm"), // 'auto_confirm' (headroom for future actions)
  label: text("label").notNull(), // plain-English rule name shown in the Trust console
  enabled: integer("enabled").notNull().default(1), // 0/1 — the rule is active
  // Provenance: the one-off interaction this rule was promoted from (nullable —
  // reference-by-convention to work_items.id / tasks.id).
  sourceWorkItemId: text("source_work_item_id"),
  sourceTaskId: text("source_task_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const workItemEvents = sqliteTable("work_item_events", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id")
    .notNull()
    .references(() => workItems.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'created' | 'status_changed' | 'run_started' | 'run_finished' | 'approved' | 'assessed' | 'run_step'
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  actor: text("actor"), // 'user' | 'runner' | 'triage' | 'assessor' | 'system'
  // 314-work-item-assessment: human-readable narration for this row ("Reading
  // Q2-deck.pdf from project knowledge"). Set on 'assessed' and 'run_step'
  // rows; null on lifecycle-only rows.
  detail: text("detail"),
  at: integer("at").notNull(),
});

export const followups = sqliteTable("followups", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(), // 'email', 'slack', 'whatsapp', etc.
  conversationId: text("conversation_id").notNull(), // external conversation identifier
  contactId: text("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  sentAt: integer("sent_at").notNull(), // epoch ms — when the outbound message was sent
  expectedResponseBy: integer("expected_response_by"), // epoch ms — deadline for expected reply
  status: text("status").notNull().default("pending"), // 'pending' | 'resolved' | 'overdue' | 'nudged'
  reminderCronId: text("reminder_cron_id"), // optional cron job ID for reminder
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
