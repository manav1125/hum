/**
 * Guardrail checkpoint enforcement — the daemon-side hook that makes enabled
 * `autonomy:<class>` checkpoints real.
 *
 * The permission checker (permissions/checker.ts) classifies every tool call
 * into an autonomy category (send / money / delete / …) and reads the
 * gateway-owned per-category policy (auto / ask / never). This module layers
 * enabled checkpoints ON TOP of that mode, and only ever TIGHTENS:
 *
 *   - policy "auto" + an in-scope enabled checkpoint for the class → "ask"
 *   - policy "ask" / "never" → unchanged (already at least as strict)
 *   - no in-scope checkpoint, or the store read fails → unchanged
 *
 * Disabling a checkpoint therefore never loosens the gateway policy or trust
 * rules — it just removes this extra tightening layer.
 *
 * Scope resolution: 'everywhere' applies to every tool call. 'agent:<id>' and
 * 'mission:<id>' apply only to background work-item runs — the run
 * conversation is mapped back to its work item via
 * work_items.last_run_conversation_id (stamped by the runner before the first
 * turn), the assignee is matched to the agents registry case-insensitively,
 * and the mission comes from the item's project. Interactive chat has no
 * agent/mission identity, so scoped checkpoints never fire there.
 *
 * Fail-open BY DESIGN toward the base mode: this layer must never turn a
 * store hiccup into a global deny — the gateway policy's own fail-closed
 * defaults (send/money/delete → ask) remain the safety net underneath.
 */

import { getDb } from "../memory/db-connection.js";
import { rawAll } from "../memory/raw-query.js";
import type { AutonomyClass } from "../permissions/autonomy-class.js";
import type { AutonomyMode } from "../permissions/autonomy-policy-reader.js";
import { getLogger } from "../util/logger.js";
import { getAgentByAssignee } from "../work-items/agent-store.js";
import {
  enforcedAutonomyClass,
  type GuardrailCheckpoint,
  listEnabledCheckpointsCached,
} from "./checkpoint-store.js";

const log = getLogger("guardrail-enforcement");

// ── Conversation → run identity (agent / mission) cache ─────────────

interface RunIdentity {
  agentId: string | null;
  missionId: string | null;
}

const runIdentityCache = new Map<
  string,
  { identity: RunIdentity; at: number }
>();
const RUN_IDENTITY_TTL_MS = 15_000;
const RUN_IDENTITY_CACHE_MAX = 200;

/** Test-only: clear the conversation→identity cache. */
export function _clearRunIdentityCacheForTesting(): void {
  runIdentityCache.clear();
}

/**
 * Resolve the agent/mission identity of a conversation, when it is a
 * background work-item run conversation. Interactive conversations resolve
 * to `{agentId: null, missionId: null}`. Cached briefly — the mapping is
 * stable for the lifetime of a run.
 */
function resolveRunIdentity(conversationId: string): RunIdentity {
  const cached = runIdentityCache.get(conversationId);
  if (cached && Date.now() - cached.at < RUN_IDENTITY_TTL_MS) {
    return cached.identity;
  }

  let identity: RunIdentity = { agentId: null, missionId: null };
  // Touch the connection first so a workspace without a DB fails fast into
  // the identity default rather than throwing from rawAll's lazy init.
  getDb();
  const rows = rawAll<{ assignee: string | null; mission_id: string | null }>(
    /*sql*/ `
    SELECT wi.assignee AS assignee, p.mission_id AS mission_id
    FROM work_items wi
    LEFT JOIN projects p ON p.id = wi.project_id
    WHERE wi.last_run_conversation_id = ?1
    ORDER BY wi.updated_at DESC
    LIMIT 1
    `,
    conversationId,
  );
  if (rows.length > 0) {
    const agent = getAgentByAssignee(rows[0].assignee);
    identity = {
      agentId: agent?.id ?? null,
      missionId: rows[0].mission_id ?? null,
    };
  }

  if (runIdentityCache.size >= RUN_IDENTITY_CACHE_MAX) {
    const oldest = runIdentityCache.keys().next().value;
    if (oldest !== undefined) runIdentityCache.delete(oldest);
  }
  runIdentityCache.set(conversationId, { identity, at: Date.now() });
  return identity;
}

// ── The override ─────────────────────────────────────────────────────

export interface CheckpointOverrideResult {
  /** The effective autonomy mode after checkpoint tightening. */
  mode: AutonomyMode;
  /** The checkpoint that fired, when the mode was tightened. */
  firedCheckpoint?: Pick<GuardrailCheckpoint, "id" | "label">;
}

/** Whether one checkpoint's scope covers this tool call. */
function scopeApplies(
  checkpoint: GuardrailCheckpoint,
  conversationId: string | undefined,
  resolveIdentity: () => RunIdentity,
): boolean {
  if (checkpoint.scope === "everywhere") return true;
  if (!conversationId) return false;
  if (checkpoint.scope.startsWith("agent:")) {
    const agentId = checkpoint.scope.slice("agent:".length);
    return resolveIdentity().agentId === agentId;
  }
  if (checkpoint.scope.startsWith("mission:")) {
    const missionId = checkpoint.scope.slice("mission:".length);
    return resolveIdentity().missionId === missionId;
  }
  return false;
}

/**
 * Tighten an autonomy mode with the enabled guardrail checkpoints for this
 * tool call's autonomy class + scope. Never throws; a failed read returns
 * the base mode unchanged (see module doc for why fail-open is correct here).
 */
export function applyCheckpointAutonomyOverride(opts: {
  autonomyClass: AutonomyClass;
  mode: AutonomyMode;
  conversationId?: string;
}): CheckpointOverrideResult {
  // Only "auto" can be tightened; "ask"/"never" are already ≥ as strict.
  if (opts.mode !== "auto") return { mode: opts.mode };

  try {
    const checkpoints = listEnabledCheckpointsCached();
    if (checkpoints.length === 0) return { mode: opts.mode };

    // Resolve the run identity lazily and at most once per call — the common
    // case (everywhere-scoped checkpoint, or no class match) never queries.
    let identity: RunIdentity | null = null;
    const resolveIdentity = (): RunIdentity => {
      identity ??= resolveRunIdentity(opts.conversationId!);
      return identity;
    };

    for (const checkpoint of checkpoints) {
      if (enforcedAutonomyClass(checkpoint.pattern) !== opts.autonomyClass) {
        continue;
      }
      if (!scopeApplies(checkpoint, opts.conversationId, resolveIdentity)) {
        continue;
      }
      return {
        mode: "ask",
        firedCheckpoint: { id: checkpoint.id, label: checkpoint.label },
      };
    }
    return { mode: opts.mode };
  } catch (err) {
    // Fail toward the base mode: the gateway policy's fail-closed defaults
    // (send/money/delete → ask) remain the underlying safety net.
    log.warn(
      { err: String(err), autonomyClass: opts.autonomyClass },
      "guardrail checkpoint override failed (base autonomy mode kept)",
    );
    return { mode: opts.mode };
  }
}
