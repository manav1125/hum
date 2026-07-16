import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../memory/db-connection.js";
import { getDb } from "../memory/db-connection.js";
import { rawChanges } from "../memory/raw-query.js";
import { a2aTasks } from "../memory/schema.js";
import { TERMINAL_TASK_STATES } from "./protocol-constants.js";
import type {
  A2AMessage,
  A2ATask,
  Artifact,
  TaskState,
} from "./protocol-types.js";

// ── Internal types ──────────────────────────────────────────────────

/** Raw database row shape for a2a_tasks. */
type A2ATaskRow = typeof a2aTasks.$inferSelect;

// ── Helpers ─────────────────────────────────────────────────────────

/** Throw if the task doesn't exist or is in a terminal state. */
function assertNonTerminal(
  db: DrizzleDb,
  taskId: string,
  targetState: TaskState,
): void {
  const current = db
    .select({ state: a2aTasks.state })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId))
    .get();

  if (!current) {
    throw new Error(`A2A task not found: ${taskId}`);
  }

  if (TERMINAL_TASK_STATES.has(current.state as TaskState)) {
    throw new Error(
      `Cannot transition task ${taskId} from terminal state "${current.state}" to "${targetState}"`,
    );
  }
}

function rowToTask(row: A2ATaskRow): A2ATask {
  return {
    id: row.id,
    context_id: row.contextId ?? undefined,
    status: {
      state: row.state as TaskState,
      message: row.statusMessage
        ? {
            message_id: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: row.statusMessage }],
          }
        : undefined,
      timestamp: new Date(row.updatedAt).toISOString(),
    },
    artifacts: row.artifactsJson
      ? (JSON.parse(row.artifactsJson) as Artifact[])
      : undefined,
  };
}

// ── Store functions ─────────────────────────────────────────────────

export function createTask(params: {
  contextId?: string;
  senderAssistantId: string;
  requestMessage: A2AMessage;
  pushUrl?: string;
}): A2ATask {
  const db = getDb();
  const now = Date.now();

  const row: A2ATaskRow = {
    id: crypto.randomUUID(),
    contextId: params.contextId ?? null,
    conversationId: null,
    state: "submitted",
    statusMessage: null,
    requestMessageJson: JSON.stringify(params.requestMessage),
    artifactsJson: null,
    pushUrl: params.pushUrl ?? null,
    senderAssistantId: params.senderAssistantId,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(a2aTasks).values(row).run();

  return rowToTask(row);
}

export function getTask(taskId: string): A2ATask | null {
  const db = getDb();
  const row = db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get();
  return row ? rowToTask(row) : null;
}

export function updateState(
  taskId: string,
  state: TaskState,
  statusMessage?: string,
): A2ATask {
  const db = getDb();
  assertNonTerminal(db, taskId, state);

  db.update(a2aTasks)
    .set({
      state,
      statusMessage: statusMessage ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(a2aTasks.id, taskId))
    .run();

  return rowToTask(
    db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get()!,
  );
}

export function completeWithArtifacts(
  taskId: string,
  artifacts: Artifact[],
): A2ATask {
  const db = getDb();
  assertNonTerminal(db, taskId, "completed");

  db.update(a2aTasks)
    .set({
      state: "completed",
      statusMessage: null,
      artifactsJson: JSON.stringify(artifacts),
      updatedAt: Date.now(),
    })
    .where(eq(a2aTasks.id, taskId))
    .run();

  return rowToTask(
    db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get()!,
  );
}

export function linkConversation(taskId: string, conversationId: string): void {
  const db = getDb();
  const now = Date.now();

  db.update(a2aTasks)
    .set({ conversationId, updatedAt: now })
    .where(eq(a2aTasks.id, taskId))
    .run();

  if (rawChanges() === 0) {
    throw new Error(`A2A task not found: ${taskId}`);
  }
}

export function getPushUrl(taskId: string): string | null {
  const db = getDb();
  const row = db
    .select({ pushUrl: a2aTasks.pushUrl })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId))
    .get();
  return row?.pushUrl ?? null;
}

/**
 * Resolve the push URL and the peer (`senderAssistantId`) a task belongs to.
 * The sender id lets the delivery adapter attach the correct per-peer bearer
 * token to the push notification.
 */
export function getPushTarget(
  taskId: string,
): { pushUrl: string | null; senderAssistantId: string | null } | null {
  const db = getDb();
  const row = db
    .select({
      pushUrl: a2aTasks.pushUrl,
      senderAssistantId: a2aTasks.senderAssistantId,
    })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId))
    .get();
  if (!row) return null;
  return {
    pushUrl: row.pushUrl ?? null,
    senderAssistantId: row.senderAssistantId ?? null,
  };
}

/** Raised when a task cannot be canceled because it is already terminal. */
export class TaskNotCancelableError extends Error {
  constructor(taskId: string, state: string) {
    super(
      `Task ${taskId} is in terminal state "${state}" and cannot be canceled`,
    );
    this.name = "TaskNotCancelableError";
  }
}

/** Raised when a referenced task does not exist. */
export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`A2A task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

/**
 * Transition a task to `canceled`. Throws `TaskNotFoundError` when the task
 * does not exist and `TaskNotCancelableError` when it is already terminal.
 */
export function cancelTask(taskId: string): A2ATask {
  const db = getDb();
  const current = db
    .select({ state: a2aTasks.state })
    .from(a2aTasks)
    .where(eq(a2aTasks.id, taskId))
    .get();

  if (!current) {
    throw new TaskNotFoundError(taskId);
  }
  if (TERMINAL_TASK_STATES.has(current.state as TaskState)) {
    throw new TaskNotCancelableError(taskId, current.state);
  }

  db.update(a2aTasks)
    .set({ state: "canceled", statusMessage: null, updatedAt: Date.now() })
    .where(eq(a2aTasks.id, taskId))
    .run();

  return rowToTask(
    db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).get()!,
  );
}
