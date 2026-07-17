/**
 * Standing auto-confirm rules store — the persisted "Make it a rule" decisions
 * behind the in-context rule card.
 *
 * A standing rule promotes a one-off confirmation into a durable decision:
 * "auto-confirm anything from Rachel" (sender), "auto-confirm anything from
 * Slack" (channel), "auto-confirm drafts" (category), or "auto-confirm web
 * fetches" (tool). Matching work items then CLEAR the per-category autonomy
 * policy's `policy_ask` deferral in the auto-run gate
 * (work-item-triage.ts → maybeAutoRunWorkItem) instead of parking for a manual
 * "Run it".
 *
 * Safety doctrine (load-bearing):
 *   - A rule only ever LOOSENS the `policy_ask` deferral for items it matches.
 *   - It NEVER overrides the hard-deny floor (`hardDeniedAutoRunTools`):
 *     host/browser/purchase/send/money-class items never auto-run, rule or no
 *     rule. The gate checks the floor BEFORE consulting rules.
 *   - It never broadens autonomy beyond what the rule literally names — a
 *     sender/channel rule authorizes only items from that sender/channel; a
 *     category/tool rule authorizes an item only when every policy-blocked
 *     class is one the rule covers (see `ruleAuthorizesAutoRun`).
 *
 * Referential integrity is by convention (no FKs), matching the sibling HQ
 * stores (agent-store, mission-store, checkpoint-store).
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { standingRules } from "../memory/schema/tasks.js";
import {
  type AutonomyClass,
  classifyAutonomy,
} from "../permissions/autonomy-class.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("standing-rules-store");

// ── Types ────────────────────────────────────────────────────────────

export const STANDING_RULE_TRIGGER_TYPES = [
  "sender",
  "channel",
  "category",
  "tool",
] as const;
export type StandingRuleTriggerType =
  (typeof STANDING_RULE_TRIGGER_TYPES)[number];

export const STANDING_RULE_ACTIONS = ["auto_confirm"] as const;
export type StandingRuleAction = (typeof STANDING_RULE_ACTIONS)[number];

export interface StandingRule {
  id: string;
  triggerType: StandingRuleTriggerType;
  triggerValue: string;
  action: StandingRuleAction;
  /** Plain-English rule name shown in the Trust console. */
  label: string;
  /** 0/1 — the rule is active. */
  enabled: number;
  /** Nullable provenance: the one-off this rule was minted from. */
  sourceWorkItemId: string | null;
  sourceTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function isValidTriggerType(
  value: unknown,
): value is StandingRuleTriggerType {
  return (
    typeof value === "string" &&
    (STANDING_RULE_TRIGGER_TYPES as readonly string[]).includes(value)
  );
}

export function isValidAction(value: unknown): value is StandingRuleAction {
  return (
    typeof value === "string" &&
    (STANDING_RULE_ACTIONS as readonly string[]).includes(value)
  );
}

// ── Cached enabled-rule read (auto-run gate hot path) ────────────────

// The auto-run gate consults rules once per capture; a short TTL avoids a DB
// read per capture in a burst while mutations invalidate immediately so a new
// rule takes effect on the very next matching item.
let enabledCache: StandingRule[] | null = null;
let enabledCacheAt = 0;
const ENABLED_CACHE_TTL_MS = 5_000;

/** Invalidate the enforcement read cache (called by every mutation; exported for tests). */
export function invalidateStandingRuleCache(): void {
  enabledCache = null;
  enabledCacheAt = 0;
}

/**
 * Enabled rules, cached for {@link ENABLED_CACHE_TTL_MS}. The gate's read path
 * — cheap and only touches SQLite.
 */
export function listEnabledStandingRulesCached(): StandingRule[] {
  const now = Date.now();
  if (enabledCache && now - enabledCacheAt < ENABLED_CACHE_TTL_MS) {
    return enabledCache;
  }
  const rows = getDb()
    .select()
    .from(standingRules)
    .where(eq(standingRules.enabled, 1))
    .all() as StandingRule[];
  enabledCache = rows;
  enabledCacheAt = now;
  return rows;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** List all rules, oldest-first (stable rule list for the Trust console). */
export function listStandingRules(): StandingRule[] {
  return getDb()
    .select()
    .from(standingRules)
    .orderBy(asc(standingRules.createdAt), asc(standingRules.id))
    .all() as StandingRule[];
}

/** Fetch a single rule by id. */
export function getStandingRule(id: string): StandingRule | undefined {
  return getDb()
    .select()
    .from(standingRules)
    .where(eq(standingRules.id, id))
    .get() as StandingRule | undefined;
}

/**
 * Find an existing enabled rule with the same (triggerType, triggerValue,
 * action). Trigger values are compared case-insensitively so "Slack" and
 * "slack" collapse to one rule. Used to make creation idempotent.
 */
export function findEquivalentStandingRule(opts: {
  triggerType: StandingRuleTriggerType;
  triggerValue: string;
  action: StandingRuleAction;
}): StandingRule | undefined {
  const normalized = opts.triggerValue.trim().toLowerCase();
  return getDb()
    .select()
    .from(standingRules)
    .where(
      and(
        eq(standingRules.enabled, 1),
        eq(standingRules.triggerType, opts.triggerType),
        eq(standingRules.action, opts.action),
        sql`lower(trim(${standingRules.triggerValue})) = ${normalized}`,
      ),
    )
    .get() as StandingRule | undefined;
}

export interface CreateStandingRuleOptions {
  triggerType: StandingRuleTriggerType;
  triggerValue: string;
  action?: StandingRuleAction;
  label?: string;
  sourceWorkItemId?: string | null;
  sourceTaskId?: string | null;
}

/**
 * Create a standing rule (idempotent). Throws on an invalid trigger type,
 * empty trigger value, or invalid action — route handlers translate to
 * BadRequest.
 *
 * Idempotency: if an enabled rule with the same (triggerType, triggerValue,
 * action) already exists, it is returned unchanged rather than duplicated —
 * a second "Make it a rule" tap on the same suggestion is a no-op. When a
 * duplicate is found the provenance columns are refreshed to the latest
 * source so the Trust console shows where it was most recently reaffirmed.
 */
export function createStandingRule(
  opts: CreateStandingRuleOptions,
): StandingRule {
  if (!isValidTriggerType(opts.triggerType)) {
    throw new Error(`invalid trigger type: ${opts.triggerType}`);
  }
  const triggerValue = opts.triggerValue.trim();
  if (!triggerValue) {
    throw new Error("triggerValue is required");
  }
  const action = opts.action ?? "auto_confirm";
  if (!isValidAction(action)) {
    throw new Error(`invalid action: ${action}`);
  }

  const db = getDb();
  const now = Date.now();

  const existing = findEquivalentStandingRule({
    triggerType: opts.triggerType,
    triggerValue,
    action,
  });
  if (existing) {
    // Refresh provenance to the latest one-off, but keep the same row/id.
    db.update(standingRules)
      .set({
        sourceWorkItemId: opts.sourceWorkItemId ?? existing.sourceWorkItemId,
        sourceTaskId: opts.sourceTaskId ?? existing.sourceTaskId,
        updatedAt: now,
      })
      .where(eq(standingRules.id, existing.id))
      .run();
    invalidateStandingRuleCache();
    log.info(
      { ruleId: existing.id, triggerType: opts.triggerType, triggerValue },
      "standing rule already exists — returning existing (idempotent)",
    );
    return getStandingRule(existing.id) ?? existing;
  }

  const rule: StandingRule = {
    id: randomUUID(),
    triggerType: opts.triggerType,
    triggerValue,
    action,
    label: opts.label?.trim() || defaultRuleLabel(opts.triggerType, triggerValue),
    enabled: 1,
    sourceWorkItemId: opts.sourceWorkItemId ?? null,
    sourceTaskId: opts.sourceTaskId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(standingRules).values(rule).run();
  invalidateStandingRuleCache();
  log.info(
    { ruleId: rule.id, triggerType: rule.triggerType, triggerValue },
    "standing rule created",
  );
  return rule;
}

/** Toggle a rule on/off (the Trust console's only edit today). */
export function updateStandingRule(
  id: string,
  updates: Partial<Pick<StandingRule, "enabled" | "label">>,
): StandingRule | undefined {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (updates.enabled !== undefined) set.enabled = updates.enabled ? 1 : 0;
  if (updates.label !== undefined) set.label = updates.label;
  db.update(standingRules).set(set).where(eq(standingRules.id, id)).run();
  invalidateStandingRuleCache();
  return getStandingRule(id);
}

/** Hard-delete a rule. */
export function deleteStandingRule(id: string): void {
  getDb().delete(standingRules).where(eq(standingRules.id, id)).run();
  invalidateStandingRuleCache();
}

/** Default plain-English label when the caller doesn't supply one. */
export function defaultRuleLabel(
  triggerType: StandingRuleTriggerType,
  triggerValue: string,
): string {
  switch (triggerType) {
    case "sender":
      return `Auto-confirm anything from ${triggerValue}`;
    case "channel":
      return `Auto-confirm anything from ${titleCase(triggerValue)}`;
    case "category":
      return `Auto-confirm ${triggerValue} actions`;
    case "tool":
      return `Auto-confirm ${triggerValue}`;
  }
}

function titleCase(value: string): string {
  return value.length === 0
    ? value
    : value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Matching (the auto-run gate consult) ─────────────────────────────

/**
 * The facts about a captured work item the auto-run gate extracts to test it
 * against standing rules. Kept as a flat, pre-extracted shape so the matcher
 * is pure and unit-testable without a DB row.
 */
export interface AutoRunItemFacts {
  /** The capturing channel (WorkItem.sourceType), e.g. 'slack' / 'email'; null when unknown. */
  channel: string | null;
  /** Optional explicit source id (WorkItem.sourceId). */
  sourceId: string | null;
  /**
   * Free text that may carry sender/channel provenance — the item's notes and
   * source-context snippet. Channel-tagged producers write a
   * "From: <name> via <channel>" line here.
   */
  provenanceText: string;
  /** The autonomy classes the item touches (classifyWorkItemAutonomy). */
  classes: AutonomyClass[];
  /** The item's required-tools snapshot. */
  tools: string[];
  /**
   * The policy-blocked subset of `classes` — the categories whose autonomy mode
   * is not "auto", i.e. the reason the item would park. A rule authorizes
   * auto-run only against THIS set (never broadening beyond it).
   */
  blockedClasses: AutonomyClass[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the provenance text names `sender` on a "From: <sender>" line. */
function provenanceNamesSender(provenanceText: string, sender: string): boolean {
  if (!provenanceText || !sender) return false;
  // Match "From: <sender>" up to the next " via"/newline/end, tolerant of
  // surrounding whitespace and case. The sender is matched as a whole-token
  // prefix of the name so "Rachel" matches "From: Rachel Kim via slack".
  const re = new RegExp(
    `from:\\s*${escapeRegExp(sender.trim())}\\b`,
    "i",
  );
  return re.test(provenanceText);
}

/** Whether the provenance text names `channel` on a "via <channel>" segment. */
function provenanceNamesChannel(
  provenanceText: string,
  channel: string,
): boolean {
  if (!provenanceText || !channel) return false;
  const re = new RegExp(`via\\s+${escapeRegExp(channel.trim())}\\b`, "i");
  return re.test(provenanceText);
}

/**
 * Whether a single rule's trigger MATCHES the item at all (ignoring the
 * literal-scope authorization check). Exposed for tests + the frontend's
 * honest match preview.
 */
export function ruleMatchesItem(
  rule: Pick<StandingRule, "triggerType" | "triggerValue">,
  facts: AutoRunItemFacts,
): boolean {
  const value = rule.triggerValue.trim();
  const valueLc = value.toLowerCase();
  switch (rule.triggerType) {
    case "sender":
      return (
        (facts.sourceId != null &&
          facts.sourceId.trim().toLowerCase() === valueLc) ||
        provenanceNamesSender(facts.provenanceText, value)
      );
    case "channel":
      return (
        (facts.channel != null &&
          facts.channel.trim().toLowerCase() === valueLc) ||
        provenanceNamesChannel(facts.provenanceText, value)
      );
    case "category":
      return facts.classes.some((c) => c === valueLc);
    case "tool":
      return facts.tools.some((t) => t.toLowerCase() === valueLc);
  }
}

/**
 * Whether a rule AUTHORIZES clearing the `policy_ask` deferral for this item —
 * i.e. it matches AND does not broaden autonomy beyond what it literally says.
 *
 *   - sender / channel: "auto-confirm anything from X" — once the item is from
 *     X, every policy-blocked class is cleared (the hard-deny floor, checked
 *     upstream, is the only remaining gate).
 *   - category: "auto-confirm <class> actions" — clears the block ONLY when
 *     every blocked class is exactly that class. A "draft" rule can never
 *     clear a "delete" block.
 *   - tool: "auto-confirm <tool>" — clears the block ONLY when every blocked
 *     class is covered by that tool's own autonomy classification.
 *
 * Never returns true when there is nothing blocked (the caller only consults
 * rules on the `policy_ask` branch, but this stays honest in isolation).
 */
export function ruleAuthorizesAutoRun(
  rule: Pick<StandingRule, "triggerType" | "triggerValue" | "action">,
  facts: AutoRunItemFacts,
): boolean {
  if (rule.action !== "auto_confirm") return false;
  if (facts.blockedClasses.length === 0) return false;
  if (!ruleMatchesItem(rule, facts)) return false;

  switch (rule.triggerType) {
    case "sender":
    case "channel":
      // Scoped to the origin — clears whatever the policy would have asked.
      return true;
    case "category": {
      const cls = rule.triggerValue.trim().toLowerCase();
      return facts.blockedClasses.every((c) => c === cls);
    }
    case "tool": {
      const covered = classifyAutonomy(rule.triggerValue.trim());
      return facts.blockedClasses.every((c) => c === covered);
    }
  }
}

/**
 * Consult the enabled standing rules against an item's facts. Returns the FIRST
 * rule that authorizes auto-run, or null when none do. Reads the short-TTL
 * cache — cheap enough for the per-capture gate.
 */
export function findAuthorizingStandingRule(
  facts: AutoRunItemFacts,
): StandingRule | null {
  for (const rule of listEnabledStandingRulesCached()) {
    if (ruleAuthorizesAutoRun(rule, facts)) return rule;
  }
  return null;
}
