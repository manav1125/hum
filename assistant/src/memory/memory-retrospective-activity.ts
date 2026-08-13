// ---------------------------------------------------------------------------
// Memory retrospective — user-activity probes.
// ---------------------------------------------------------------------------
//
// Port of upstream ff10e008e1: a retrospective fires only when the
// unprocessed tail contains at least one user message carrying
// non-tool_result content. Tool results ride on user-role rows, so a bare
// role check would count any tool-using assistant stretch as user activity.
// Assistant-only stretches (proactive sends, broadcast recaps) carry no user
// turn — their window anchor is undecidable and their content is a recap of
// work captured at its source — so they are deferred, not run: the cursor
// stays put and the first retrospective after real user activity reviews the
// whole deferred stretch.
//
// The knob is `memory.retrospective.requireUserActivity` (default true).
// This fork's config schema does not declare the key yet (the schema lives
// outside the memory module's ownership), so both readers access it
// defensively and default to ON; declaring it in
// `config/schemas/memory-retrospective.ts` later needs no change here.

import { and, eq, gt, or } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { messages } from "./schema/conversations.js";

/**
 * Defensive read of `memory.retrospective.requireUserActivity` (default
 * true) — see the module comment for why the key is not on the typed config.
 */
export function retrospectiveRequiresUserActivity(retrospectiveConfig: {
  timeThresholdMs: number;
}): boolean {
  return (
    (retrospectiveConfig as { requireUserActivity?: boolean })
      .requireUserActivity ?? true
  );
}

/**
 * True when any block in a parsed content array is something other than a
 * tool_result. Bare tool-result carriers are transport rows for tool output,
 * not user-authored activity; an empty array carries nothing.
 */
function blocksCarryNonToolResult(
  blocks: ReadonlyArray<{ type?: unknown }>,
): boolean {
  return blocks.some((block) => block.type !== "tool_result");
}

/**
 * Raw-content twin of the block check: rows that do not parse to a block
 * array (legacy plain strings, file-backed refs) count as user-authored, so
 * the gate fails toward running the retrospective.
 */
function rawUserContentCarriesActivity(raw: string | null): boolean {
  if (raw === null || raw === "") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return true;
    }
    return blocksCarryNonToolResult(parsed as Array<{ type?: unknown }>);
  } catch {
    return true;
  }
}

/**
 * True when the loaded slice contains at least one user-authored message: a
 * user-role row whose content carries a non-tool_result block. The job's
 * execution-time twin of {@link hasQualifyingUserMessageAfter}, applied to
 * queued rows that predate the enqueue gate (or lost their user activity to
 * a cursor race).
 */
export function messagesHaveUserActivity(
  rows: ReadonlyArray<{ role: string; content: string }>,
): boolean {
  return rows.some(
    (row) => row.role === "user" && rawUserContentCarriesActivity(row.content),
  );
}

/**
 * Existence probe for user-authored activity strictly after the
 * `(createdAt, id)` cursor: at least one user-role row whose content carries
 * a non-tool_result block. Powers the enqueue gate, so only user rows are
 * loaded. Cursor semantics mirror `countMessagesAfter`: a null/`""`
 * reference scans the whole conversation, and a vanished reference means no
 * new work.
 */
export function hasQualifyingUserMessageAfter(
  conversationId: string,
  afterMessageId: string | null,
): boolean {
  const cursorId =
    afterMessageId === null || afterMessageId === "" ? null : afterMessageId;
  const db = getDb();

  let ref: { createdAt: number } | undefined;
  if (cursorId !== null) {
    ref = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, cursorId))
      .get();
    if (!ref) {
      return false;
    }
  }

  const afterCursor =
    cursorId !== null && ref
      ? [
          or(
            gt(messages.createdAt, ref.createdAt),
            and(
              eq(messages.createdAt, ref.createdAt),
              gt(messages.id, cursorId),
            ),
          ),
        ]
      : [];
  const rows = db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
        ...afterCursor,
      ),
    )
    .all();

  return rows.some((row) => rawUserContentCarriesActivity(row.content));
}
