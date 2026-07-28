/**
 * Artifact → conversation provenance for Library listings.
 *
 * Every document and app is produced inside a thread, and the daemon already
 * records which one (`documents.conversation_id`, `AppDefinition.conversationIds`).
 * That link was never carried out to the Library, so opening an artifact there
 * was a dead end — no way back to the thread that made it, no way to ask a
 * follow-up.
 *
 * These helpers resolve a stored conversation id against the `conversations`
 * table and return it **only when the row still exists**. A thread the user has
 * since deleted resolves to `undefined`, so a caller can render a link that is
 * guaranteed to land somewhere real instead of a plausible-looking one that
 * opens an empty screen. Never infer provenance we cannot prove.
 */

import { z } from "zod";

import { rawAll } from "../../memory/raw-query.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("artifact-provenance");

/** A conversation that produced an artifact and still exists. */
export interface SourceConversation {
  id: string;
  /** The thread's title, or `null` when it was never titled. */
  title: string | null;
}

/** Wire schema for {@link SourceConversation}. */
export const sourceConversationSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
});

/**
 * SQLite's default parameter ceiling is 999; stay well under it so a large
 * library resolves in a handful of queries rather than throwing.
 */
const LOOKUP_CHUNK_SIZE = 400;

/**
 * Resolve conversation ids to the rows that still exist.
 *
 * Ids with no surviving row are simply absent from the returned map — that
 * absence is the signal callers use to omit a provenance link. On a query
 * failure the map is empty (no provenance claimed) rather than partial.
 */
export function resolveExistingConversations(
  ids: readonly string[],
): Map<string, SourceConversation> {
  const resolved = new Map<string, SourceConversation>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (unique.length === 0) return resolved;

  try {
    for (let i = 0; i < unique.length; i += LOOKUP_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + LOOKUP_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = rawAll<{ id: string; title: string | null }>(
        /*sql*/ `SELECT id, title FROM conversations WHERE id IN (${placeholders})`,
        ...chunk,
      );
      for (const row of rows) {
        resolved.set(row.id, { id: row.id, title: row.title ?? null });
      }
    }
  } catch (error) {
    log.error({ err: error }, "Conversation provenance lookup failed");
    return new Map();
  }

  return resolved;
}

/**
 * Resolve a single artifact's originating conversation. Returns `undefined`
 * when the id is missing or the thread no longer exists.
 */
export function resolveSourceConversation(
  conversationId: string | null | undefined,
): SourceConversation | undefined {
  if (!conversationId) return undefined;
  return resolveExistingConversations([conversationId]).get(conversationId);
}
