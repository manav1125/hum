import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Missions — outcome-oriented goals sitting ABOVE projects (the HQ layer).
 * A mission declares a measurable outcome + horizon; initiatives are ordinary
 * projects linked via projects.mission_id; the per-mission orchestrator
 * (src/missions/mission-orchestrator.ts) sprints toward the outcome in
 * cadenced cycles.
 */
export const missions = sqliteTable("missions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** The measurable outcome the mission drives toward ("20 paying customers"). */
  outcome: text("outcome").notNull(),
  /** Optional metric the outcome is tracked by ("MRR", "signups/week"). */
  metric: text("metric"),
  /** Optional target date, epoch ms. */
  horizon: integer("horizon"),
  status: text("status").notNull().default("active"), // 'active' | 'paused' | 'achieved' | 'abandoned'
  /**
   * Per-mission autonomy override: 'observe' | 'assist' | 'autonomous'.
   * Null = fall back to company_profile.workspace_mode.
   */
  mode: text("mode"),
  /** The mission "why" — context brief injected into every planning cycle. */
  brief: text("brief"),
  /** Cycle cadence: 'hourly' | 'daily' | 'weekly'. Null = default (daily). */
  cadence: text("cadence"),
  /** Hard spend cap in cents; null = uncapped. */
  budgetCents: integer("budget_cents"),
  /** Cents spent by orchestrator cycles so far (LLM usage where trackable). */
  spentCents: integer("spent_cents").notNull().default(0),
  /**
   * Bounded (~8KB) regenerated-per-cycle state doc: objective, recent
   * actions, blockers, next action. Keeps long-running missions coherent
   * across cycles without replaying full history.
   */
  continuationSummary: text("continuation_summary"),
  pinned: integer("pinned").notNull().default(0), // 0/1 — pinned missions float to the top
  sortIndex: integer("sort_index"), // nullable manual ordering key (smaller sorts first)
  lastCycleAt: integer("last_cycle_at"), // epoch ms of the last orchestrator cycle
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Company profile — the single-row "who we are" record the orchestrator
 * injects into every planning cycle. The row id is always 'company'.
 */
export const companyProfile = sqliteTable("company_profile", {
  id: text("id").primaryKey(), // always 'company' (single-row table by convention)
  /** Who we are — identity/positioning blurb. */
  identity: text("identity"),
  /** Where we're going — direction/strategy notes. */
  direction: text("direction"),
  /** JSON array of hard boundaries the AI may never cross. */
  neverLines: text("never_lines"),
  /** Workspace-default autonomy mode: 'observe' | 'assist' | 'autonomous'. */
  workspaceMode: text("workspace_mode").notNull().default("assist"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Mission audit trail — one row per orchestrator lifecycle event
 * (cycle_started, planned, item_enqueued, output_ready, checkpoint,
 * budget_stop, reported, error). Powers the mission-detail sprint timeline.
 */
export const missionEvents = sqliteTable("mission_events", {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull(), // reference-by-convention to missions.id (store-enforced)
  kind: text("kind").notNull(),
  /** Groups all events of one orchestrator cycle. */
  cycleId: text("cycle_id"),
  /** JSON payload — event-kind-specific details (plan, item ids, spend…). */
  payload: text("payload"),
  at: integer("at").notNull(),
});

/**
 * Exact-once decomposition fingerprints: one row per (mission, plan-hash).
 * The orchestrator claims the fingerprint BEFORE enqueuing plan items, so a
 * crashed/re-run cycle that produces the same plan can never enqueue
 * duplicates.
 *
 * Adapted from Paperclip (MIT, github.com/paperclipai/paperclip): its
 * decomposition path stamps an exact-once identity (sourceIssueId +
 * planRevisionId) on created tasks and its wake queue dedupes on an
 * idempotencyKey (server/src/services/issue-dependency-wakeups.ts).
 */
export const missionPlanFingerprints = sqliteTable(
  "mission_plan_fingerprints",
  {
    /** `${missionId}:${sha256(plan)}` */
    fingerprint: text("fingerprint").primaryKey(),
    missionId: text("mission_id").notNull(),
    at: integer("at").notNull(),
  },
);
