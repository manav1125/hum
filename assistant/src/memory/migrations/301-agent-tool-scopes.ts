import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_agent_tool_scopes_v1";

/**
 * Guardrails R2 — `agents.tool_scopes`: the per-agent tool-scope allowlist
 * behind the Guardrails "AGENT SCOPES" band.
 *
 * The column holds a JSON string array of coarse skill/domain ids (the R1
 * scope chips: "email", "calendar", "research", "files", "code", "docs",
 * "design", "outreach", "social", "ads"). NULL = unrestricted — the agent's
 * background runs get the full tool surface, matching pre-R2 behavior for
 * every existing row.
 *
 * Enforcement lives in guardrails/agent-tool-scopes.ts: a scoped agent's
 * work-item run conversation filters extension-owned (skill/plugin/MCP)
 * tools whose name/owner matches a known domain outside the agent's scopes.
 * Core plumbing tools are never filtered.
 *
 * Idempotent by construction: the ALTER is guarded by a PRAGMA column check,
 * so re-running on every startup is a no-op.
 */
export function migrateAgentToolScopes(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const agentColumns = raw
      .prepare(/*sql*/ `PRAGMA table_info(agents)`)
      .all() as Array<{ name: string }>;
    if (!agentColumns.some((c) => c.name === "tool_scopes")) {
      raw.exec(/*sql*/ `ALTER TABLE agents ADD COLUMN tool_scopes TEXT`);
    }
  });
}
