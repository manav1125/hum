/**
 * Bind a conversation to the agent that runs in it.
 *
 * A work-item run resolves its agent — charter, model pin, tool scopes — and
 * attaches the consequences to the in-memory conversation object. None of it
 * was written down, so the binding lasted exactly as long as that object did.
 *
 * Two ordinary things end it. The conversation evictor sweeps idle
 * conversations out of the pool, and a daemon restart drops all of them. After
 * either, the conversation rehydrates as a plain one: no model pin, no
 * charter, and — the part that matters — no tool scopes. An agent deliberately
 * restricted to a narrow set of tools then answers the owner's next message
 * with the full unrestricted set, and nothing anywhere reports that the
 * restriction stopped applying. A guardrail that lapses on a timer is worse
 * than one that was never offered, because the owner believes it is on.
 *
 * It is also why handing work to an agent and then talking to it did not feel
 * like talking to that agent. The reply came back from generic Cue.
 *
 * Nullable, because most conversations have no agent. NULL means the house
 * assistant, which is what a null work-item assignee has always meant.
 */

import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_conversation_agent_binding_v1";

export function migrateConversationAgentBinding(database: DrizzleDb): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const columns = raw
      .query<{ name: string }, []>(`PRAGMA table_info(conversations)`)
      .all();
    if (!columns.some((c) => c.name === "agent_id")) {
      raw.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT`);
    }

    // Two reads want this. "Which agent owns this conversation" is a primary-key
    // lookup and needs nothing; "every conversation belonging to this agent" is
    // what the agent's own thread list asks, and is what the index is for.
    raw.exec(
      `CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id)`,
    );
  });
}
