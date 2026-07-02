/**
 * document_export_pdf — render an existing document to a PDF attachment.
 *
 * The shareable/printable half of the document editor: the same render path
 * as the documents route (markdown → print template → headless Chromium),
 * but delivered as an in-chat attachment the user can download or send.
 */

import { getDocumentById } from "../../../../documents/document-store.js";
import { renderMarkdownToPDF } from "../../../../documents/pdf-render.js";
import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import { canAccessDocument } from "../../../../tools/document/document-tool.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "document"
  );
}

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

  const doc = getDocumentById(surfaceId);
  if (!doc || !canAccessDocument(surfaceId, context)) {
    return {
      content: `Document not found or not accessible: ${surfaceId}`,
      isError: true,
    };
  }

  try {
    const pdf = await renderMarkdownToPDF(doc.title, doc.content);
    const filename = `${sanitizeFilename(doc.title)}.pdf`;
    const attachment = uploadAttachmentFromBytes(
      filename,
      "application/pdf",
      new Uint8Array(pdf),
    );
    return {
      content: JSON.stringify({
        message: "Document exported as PDF.",
        attachmentId: attachment.id,
        filename,
        sizeBytes: pdf.length,
        pageFormat: "A4",
      }),
      isError: false,
    };
  } catch (err) {
    return {
      content: `PDF export failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
