/**
 * Kit output capture — the query that pulls a kit asset's produced deliverable
 * out of its background generation conversation.
 *
 * Mirrors work-output-store's `listRunProducedAttachments`: an attachment the
 * run's tools produced is one linked to an ASSISTANT message of the run
 * conversation (user-uploaded inputs are linked to user messages, so they are
 * naturally excluded). A fan-out asset is a single artifact, so we return the
 * FIRST such attachment as the asset's `outputRef`.
 */

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import {
  attachments,
  messageAttachments,
  messages,
} from "../memory/schema/index.js";

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
