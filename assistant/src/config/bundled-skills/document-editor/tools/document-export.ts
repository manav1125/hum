/**
 * document_export — render an existing document to any supported format and
 * deliver it as an in-chat attachment.
 *
 * The multi-format sibling of `document_export_pdf`. The document's stored
 * Markdown is the source for every format, so what the user sees in the editor
 * is what lands in the file.
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
import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import { canAccessDocument } from "../../../../tools/document/document-tool.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const surfaceId = input.surface_id;
  if (typeof surfaceId !== "string" || !surfaceId.trim()) {
    return {
      content:
        "Provide the document's `surface_id` (from document_create or <active_documents>).",
      isError: true,
    };
  }

  const format = input.format;
  if (!isExportFormat(format)) {
    return {
      content: `Provide a \`format\`: one of ${EXPORT_FORMATS.join(", ")}.`,
      isError: true,
    };
  }

  const doc = getDocumentById(surfaceId);
  if (!doc || !canAccessDocument(surfaceId, context)) {
    return {
      content: `Document not found or not accessible: ${surfaceId}`,
      isError: true,
    };
  }

  try {
    const { bytes, detail } = await renderMarkdownAs(format, doc.content, {
      title: doc.title,
      selector: typeof input.selector === "string" ? input.selector : undefined,
      scale: typeof input.scale === "number" ? input.scale : undefined,
      widthPx: typeof input.width_px === "number" ? input.width_px : undefined,
    });

    const filename = `${sanitizeFilename(doc.title)}.${extensionFor(format)}`;
    const attachment = uploadAttachmentFromBytes(
      filename,
      mimeFor(format),
      new Uint8Array(bytes),
    );
    return {
      content: JSON.stringify({
        message: `Document exported as ${format.toUpperCase()}.`,
        attachmentId: attachment.id,
        filename,
        format,
        sizeBytes: bytes.length,
        ...detail,
      }),
      isError: false,
      // Typed side channel: lets the daemon link the stored attachment onto
      // the assistant message row so history reloads return it.
      attachmentIds: [attachment.id],
    };
  } catch (err) {
    return {
      content: `${format.toUpperCase()} export failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
