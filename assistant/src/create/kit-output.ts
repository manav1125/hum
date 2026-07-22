/**
 * Kit output capture — the query that pulls a kit asset's produced deliverable
 * out of its background generation conversation.
 *
 * Two kinds of deliverable exist, because the fan-out formats route to two
 * different surfaces:
 *
 *  - **Attachments** (social / image, and anything a tool emits as a file):
 *    mirrors work-output-store's `listRunProducedAttachments` — an attachment
 *    the run's tools produced is one linked to an ASSISTANT message of the run
 *    conversation (user-uploaded inputs are linked to user messages, so they
 *    are naturally excluded).
 *  - **Documents** (one-pager / email, i.e. every `docs`-mode format): the
 *    document-editor writes a `documents` row + a `document_conversations`
 *    link and never creates an attachment. Capturing attachments only left
 *    every doc-mode asset marked `done` with `outputRef = null`, so the kit
 *    view had nothing to show or download for the majority of its formats.
 *
 * `outputRef` therefore carries a small tagged encoding: a bare id is an
 * attachment (the original format, kept so existing rows keep resolving), and
 * a `document:<surfaceId>` ref is a document surface. Use `parseKitOutputRef`
 * rather than reading the column directly.
 */

import { and, asc, eq } from "drizzle-orm";

import { getDocumentsForConversation } from "../documents/document-store.js";
import { getDb } from "../memory/db-connection.js";
import {
  attachments,
  messageAttachments,
  messages,
} from "../memory/schema/index.js";

/** The prefix marking an `outputRef` that points at a document surface. */
export const DOCUMENT_OUTPUT_PREFIX = "document:";

/** A decoded `outputRef`. */
export type KitOutputRef =
  | { kind: "attachment"; id: string }
  | { kind: "document"; id: string };

/**
 * Decode a stored `outputRef`. Bare ids are attachments (the original
 * encoding); `document:<surfaceId>` refs are document surfaces.
 */
export function parseKitOutputRef(ref: string | null): KitOutputRef | null {
  if (!ref) return null;
  if (ref.startsWith(DOCUMENT_OUTPUT_PREFIX)) {
    const id = ref.slice(DOCUMENT_OUTPUT_PREFIX.length);
    return id ? { kind: "document", id } : null;
  }
  return { kind: "attachment", id: ref };
}

/**
 * The id of the first attachment the run's tools produced in this conversation
 * (oldest assistant-linked attachment), or null when the run produced none.
 */
export function firstRunProducedAttachmentId(
  conversationId: string,
): string | null {
  const db = getDb();
  const row = db
    .selectDistinct({
      id: attachments.id,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .innerJoin(
      messageAttachments,
      eq(messageAttachments.attachmentId, attachments.id),
    )
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
      ),
    )
    .orderBy(asc(attachments.createdAt))
    .limit(1)
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The surface id of the first document the run produced in this conversation,
 * or null when it produced none. Documents are ordered newest-first by the
 * store, so the LAST entry is the one the run created first.
 */
export function firstRunProducedDocumentId(
  conversationId: string,
): string | null {
  const docs = getDocumentsForConversation(conversationId);
  return docs.at(-1)?.surfaceId ?? null;
}

/**
 * The kit asset's produced deliverable, as a storable `outputRef`. Attachments
 * win when both exist (an image asset that also left notes in a doc is still an
 * image asset); documents are the fallback so doc-mode formats stop completing
 * with nothing attached. Null when the run produced neither — the caller marks
 * the asset done-with-no-output and the UI says so rather than showing an empty
 * tile.
 */
export function firstRunProducedOutputRef(
  conversationId: string,
): string | null {
  const attachmentId = firstRunProducedAttachmentId(conversationId);
  if (attachmentId) return attachmentId;
  const documentId = firstRunProducedDocumentId(conversationId);
  return documentId ? `${DOCUMENT_OUTPUT_PREFIX}${documentId}` : null;
}
