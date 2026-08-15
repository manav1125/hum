/**
 * document_send — deliver a document export to an external destination.
 *
 * The name matters and is not cosmetic. `classifyAutonomy` reads the "send"
 * segment out of `document_send` and puts every call in the `send` autonomy
 * class, which is what routes it through the human-approval checkpoint, keeps
 * it out of unattended auto-run, and excludes it from timed approval grants.
 * Renaming this tool to something without a send verb (`document_deliver`,
 * `document_push`) would silently drop it to the `other` class and lose that
 * guarantee. See `src/exports/destinations/__tests__/autonomy-class.test.ts`.
 *
 * The tool itself is deliberately thin: resolve bytes (either a fresh render
 * of a document, or an export already sitting in the attachment store), then
 * hand them to the one destination primitive.
 */

import { getDocumentById } from "../../../../documents/document-store.js";
import {
  EXPORT_FORMATS,
  extensionFor,
  isExportFormat,
  mimeFor,
  renderMarkdownAs,
  sanitizeFilename,
} from "../../../../documents/export-delivery.js";
import { destinationIds } from "../../../../exports/destinations/registry.js";
import { sendExportToDestination } from "../../../../exports/destinations/send-export.js";
import type {
  DestinationTarget,
  ExportPayload,
} from "../../../../exports/destinations/types.js";
import {
  getAttachmentById,
  getAttachmentContent,
} from "../../../../memory/attachments-store.js";
import { canAccessDocument } from "../../../../tools/document/document-tool.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function fail(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

/** Bytes from an export that already exists as an in-chat attachment. */
function payloadFromAttachment(
  attachmentId: string,
): { ok: true; payload: ExportPayload } | { ok: false; message: string } {
  const meta = getAttachmentById(attachmentId);
  if (!meta) {
    return {
      ok: false,
      message: `No attachment found with id ${attachmentId}.`,
    };
  }
  const content = getAttachmentContent(attachmentId);
  if (!content) {
    return {
      ok: false,
      message: `Attachment ${attachmentId} has no stored content to send.`,
    };
  }
  return {
    ok: true,
    payload: {
      bytes: Buffer.from(new Uint8Array(content)),
      filename: meta.originalFilename,
      mimeType: meta.mimeType,
      title: meta.originalFilename.replace(/\.[^.]+$/, ""),
    },
  };
}

/** Bytes from a fresh render of a document Cue is holding. */
async function payloadFromDocument(
  surfaceId: string,
  format: string,
  context: ToolContext,
): Promise<
  { ok: true; payload: ExportPayload } | { ok: false; message: string }
> {
  if (!isExportFormat(format)) {
    return {
      ok: false,
      message: `Provide a \`format\`: one of ${EXPORT_FORMATS.join(", ")}.`,
    };
  }
  const doc = getDocumentById(surfaceId);
  if (!doc || !canAccessDocument(surfaceId, context)) {
    return {
      ok: false,
      message: `Document not found or not accessible: ${surfaceId}`,
    };
  }
  const { bytes } = await renderMarkdownAs(format, doc.content, {
    title: doc.title,
  });
  return {
    ok: true,
    payload: {
      bytes,
      filename: `${sanitizeFilename(doc.title)}.${extensionFor(format)}`,
      mimeType: mimeFor(format),
      title: doc.title,
    },
  };
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const destination = input.destination;
  if (typeof destination !== "string" || !destination.trim()) {
    return fail(
      `Provide a \`destination\`: one of ${destinationIds().join(", ")}.`,
    );
  }

  const surfaceId =
    typeof input.surface_id === "string" && input.surface_id.trim()
      ? input.surface_id.trim()
      : undefined;
  const attachmentId =
    typeof input.attachment_id === "string" && input.attachment_id.trim()
      ? input.attachment_id.trim()
      : undefined;

  if (!surfaceId && !attachmentId) {
    return fail(
      "Name what to send: either `surface_id` (a document Cue will render for you) or `attachment_id` (an export that already exists).",
    );
  }
  if (surfaceId && attachmentId) {
    return fail(
      "Provide either `surface_id` or `attachment_id`, not both — they name two different files.",
    );
  }

  let resolved:
    | { ok: true; payload: ExportPayload }
    | { ok: false; message: string };
  try {
    resolved = attachmentId
      ? payloadFromAttachment(attachmentId)
      : await payloadFromDocument(
          surfaceId as string,
          typeof input.format === "string" ? input.format : "markdown",
          context,
        );
  } catch (err) {
    return fail(
      `Could not prepare the file to send: ${(err as Error).message}`,
    );
  }
  if (!resolved.ok) return fail(resolved.message);

  const target: DestinationTarget = {
    id: typeof input.target_id === "string" ? input.target_id : undefined,
    message: typeof input.message === "string" ? input.message : undefined,
    threadTs: typeof input.thread_ts === "string" ? input.thread_ts : undefined,
    objectType:
      typeof input.object_type === "string" ? input.object_type : undefined,
  };

  const outcome = await sendExportToDestination({
    payload: resolved.payload,
    destinationId: destination,
    target,
    signal: context.signal,
  });

  if (!outcome.ok) {
    // The failure reason travels with the message so the model relays "not
    // connected" as a connect prompt rather than as a generic error.
    return {
      content: JSON.stringify({
        sent: false,
        destination,
        reason: outcome.reason,
        message: outcome.summary,
      }),
      isError: true,
    };
  }

  return {
    content: JSON.stringify({
      sent: true,
      destination,
      filename: resolved.payload.filename,
      sizeBytes: resolved.payload.bytes.length,
      message: outcome.summary,
      confirmation: outcome.confirmation,
    }),
    isError: false,
  };
}
