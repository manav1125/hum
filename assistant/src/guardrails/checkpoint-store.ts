/**
 * Guardrail checkpoint registry — the "Cue always asks before…" rules behind
 * the Guardrails surface. A checkpoint is a named, plain-English rule compiled
 * from a template into an enforcement `pattern`:
 *
 *   - `autonomy:<class>` patterns (send / money / delete / draft / research /
 *     other) are ENFORCED: the permission checker consults enabled checkpoints
 *     on every tool call and tightens that autonomy category from "auto" to
 *     "ask" when one is in scope (see checkpoint-enforcement.ts). Enforcement
 *     only tightens — disabling a checkpoint never loosens the gateway's own
 *     per-category autonomy policy or trust rules.
 *   - Any other pattern form ("tool:publish_*", "contact:*", custom strings)
 *     is DECLARATIVE today: persisted and exposed with `enforced: false` so
 *     the UI can honestly show the rule as "coming online".
 *
 * Default template → pattern compilation:
 *   send_message → autonomy:send   (enforced)
 *   spend_over   → autonomy:money  (enforced; threshold_cents is advisory —
 *                  per-action $ cost is unknowable pre-execution, so an
 *                  enabled spend_over checkpoint asks on ANY money action)
 *   delete       → autonomy:delete (enforced)
 *   publish      → tool:publish_*  (declarative)
 *   contact      → contact:*       (declarative)
 *   custom       → caller-supplied (enforced only if it's an autonomy:<class>)
 *
 * Scope is 'everywhere', 'agent:<agentId>', or 'mission:<missionId>'.
 * Referential integrity is by convention (no FKs), matching the sibling HQ
 * stores (agent-store, mission-store).
 */

import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { guardrailCheckpoints } from "../memory/schema/tasks.js";
import type { AutonomyClass } from "../permissions/autonomy-class.js";

// ── Types ────────────────────────────────────────────────────────────

export const CHECKPOINT_TEMPLATES = [
  "send_message",
  "spend_over",
  "publish",
  "delete",
  "contact",
  "custom",
] as const;

export type GuardrailCheckpointTemplate = (typeof CHECKPOINT_TEMPLATES)[number];

export interface GuardrailCheckpoint {
  id: string;
  template: GuardrailCheckpointTemplate;
  /** Plain-English rule name ("Sending any email or message"). */
  label: string;
  /** Compiled enforcement pattern (see module doc). */
  pattern: string;
  /** 'everywhere' | 'agent:<agentId>' | 'mission:<missionId>'. */
  scope: string;
  /** spend_over dollar line in cents; advisory (see module doc). */
  thresholdCents: number | null;
  /** 0/1 — the rule is active. */
  enabled: number;
  /** 0/1 — seeded starter rule (the UI labels these "default"). */
  isDefault: number;
  createdAt: number;
  updatedAt: number;
}

/** Template → default compiled pattern. `custom` has none (caller-supplied). */
const TEMPLATE_PATTERNS: Record<
  Exclude<GuardrailCheckpointTemplate, "custom">,
  string
> = {
  send_message: "autonomy:send",
  spend_over: "autonomy:money",
  publish: "tool:publish_*",
  delete: "autonomy:delete",
  contact: "contact:*",
};

const AUTONOMY_CLASSES: ReadonlySet<string> = new Set([
  "research",
  "draft",
  "send",
  "money",
  "delete",
  "other",
]);

/**
 * The autonomy category an `autonomy:<class>` pattern enforces, or null when
 * the pattern is declarative-only. This is the single source of truth both
 * the enforcement hook and the API's `enforced` flag read.
 */
export function enforcedAutonomyClass(pattern: string): AutonomyClass | null {
  if (!pattern.startsWith("autonomy:")) return null;
  const cls = pattern.slice("autonomy:".length).trim();
  return AUTONOMY_CLASSES.has(cls) ? (cls as AutonomyClass) : null;
}

/** Whether an enabled checkpoint with this pattern is actually enforced. */
export function isCheckpointEnforced(checkpoint: { pattern: string }): boolean {
  return enforcedAutonomyClass(checkpoint.pattern) != null;
}

/**
 * Human-readable enforcement mechanism for the API payload; null when the
 * checkpoint is declarative-only.
 */
export function checkpointEnforcementVia(checkpoint: {
  pattern: string;
}): string | null {
  const cls = enforcedAutonomyClass(checkpoint.pattern);
  if (cls == null) return null;
  return `permission checker: autonomy category '${cls}' tightened to ask`;
}

// ── Scope validation ─────────────────────────────────────────────────

const SCOPE_RE = /^(everywhere|agent:.+|mission:.+)$/;

/** Whether a scope string is well-formed (existence is not checked — by-convention refs). */
export function isValidCheckpointScope(scope: string): boolean {
  return SCOPE_RE.test(scope);
}

// ── Cached enabled-checkpoint read (enforcement hot path) ────────────

// The permission checker consults checkpoints on every tool call; a short
// TTL avoids a DB read per call in a burst while mutations invalidate
// immediately so a toggle takes effect on the next call.
let enabledCache: GuardrailCheckpoint[] | null = null;
let enabledCacheAt = 0;
const ENABLED_CACHE_TTL_MS = 5_000;

/** Invalidate the enforcement read cache (called by every mutation; exported for tests). */
export function invalidateCheckpointCache(): void {
  enabledCache = null;
  enabledCacheAt = 0;
}

/**
 * Enabled checkpoints, cached for {@link ENABLED_CACHE_TTL_MS}. The
 * enforcement hook's read path — must stay cheap and never throw (callers
 * wrap it, but the cache itself only touches SQLite).
 */
export function listEnabledCheckpointsCached(): GuardrailCheckpoint[] {
  const now = Date.now();
  if (enabledCache && now - enabledCacheAt < ENABLED_CACHE_TTL_MS) {
    return enabledCache;
  }
  const db = getDb();
  const rows = db
    .select()
    .from(guardrailCheckpoints)
    .where(eq(guardrailCheckpoints.enabled, 1))
    .all() as GuardrailCheckpoint[];
  enabledCache = rows;
  enabledCacheAt = now;
  return rows;
}

// ── CRUD ─────────────────────────────────────────────────────────────

/** List all checkpoints, oldest-first (stable rule list). */
export function listCheckpoints(): GuardrailCheckpoint[] {
  const db = getDb();
  return db
    .select()
    .from(guardrailCheckpoints)
    .orderBy(asc(guardrailCheckpoints.createdAt), asc(guardrailCheckpoints.id))
    .all() as GuardrailCheckpoint[];
}

/** Fetch a single checkpoint by id. */
export function getCheckpoint(id: string): GuardrailCheckpoint | undefined {
  const db = getDb();
  return db
    .select()
    .from(guardrailCheckpoints)
    .where(eq(guardrailCheckpoints.id, id))
    .get() as GuardrailCheckpoint | undefined;
}

/**
 * Create a checkpoint from a template. `pattern` is compiled from the
 * template unless the caller supplies one; `custom` requires an explicit
 * pattern. Throws on an unknown template, a malformed scope, or a custom
 * checkpoint without a pattern — route handlers translate to BadRequest.
 */
export function createCheckpoint(opts: {
  template: GuardrailCheckpointTemplate;
  label: string;
  pattern?: string;
  scope?: string;
  thresholdCents?: number | null;
  enabled?: boolean;
}): GuardrailCheckpoint {
  if (!CHECKPOINT_TEMPLATES.includes(opts.template)) {
    throw new Error(`unknown checkpoint template: ${opts.template}`);
  }
  const scope = opts.scope ?? "everywhere";
  if (!isValidCheckpointScope(scope)) {
    throw new Error(
      `invalid scope "${scope}" — expected 'everywhere', 'agent:<id>', or 'mission:<id>'`,
    );
  }
  const suppliedPattern = opts.pattern?.trim();
  const pattern =
    suppliedPattern && suppliedPattern.length > 0
      ? suppliedPattern
      : opts.template === "custom"
        ? undefined
        : TEMPLATE_PATTERNS[opts.template];
  if (!pattern) {
    throw new Error("custom checkpoints require an explicit pattern");
  }

  const db = getDb();
  const now = Date.now();
  const checkpoint: GuardrailCheckpoint = {
    id: randomUUID(),
    template: opts.template,
    label: opts.label,
    pattern,
    scope,
    thresholdCents: opts.thresholdCents ?? null,
    enabled: opts.enabled === false ? 0 : 1,
    isDefault: 0,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(guardrailCheckpoints).values(checkpoint).run();
  invalidateCheckpointCache();
  return checkpoint;
}

/**
 * Patch one checkpoint (rename / toggle / re-scope / re-pattern / threshold).
 * Only provided fields are written. Throws on a malformed scope.
 */
export function updateCheckpoint(
  id: string,
  updates: Partial<
    Pick<
      GuardrailCheckpoint,
      "label" | "pattern" | "scope" | "thresholdCents" | "enabled"
    >
  >,
): GuardrailCheckpoint | undefined {
  if (updates.scope !== undefined && !isValidCheckpointScope(updates.scope)) {
    throw new Error(
      `invalid scope "${updates.scope}" — expected 'everywhere', 'agent:<id>', or 'mission:<id>'`,
    );
  }
  const db = getDb();
  db.update(guardrailCheckpoints)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(guardrailCheckpoints.id, id))
    .run();
  invalidateCheckpointCache();
  return getCheckpoint(id);
}

/** Delete a checkpoint. Hard delete; defaults are not resurrected (seed is empty-table-only). */
export function deleteCheckpoint(id: string): void {
  const db = getDb();
  db.delete(guardrailCheckpoints).where(eq(guardrailCheckpoints.id, id)).run();
  invalidateCheckpointCache();
}

/** How many checkpoints exist right now (seed/idempotency checks in tests). */
export function countCheckpoints(): number {
  const db = getDb();
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(guardrailCheckpoints)
    .get();
  return Number(row?.n ?? 0);
}
