/**
 * Google Docs destination — a real, editable document, not a file in a folder.
 *
 * Composio's `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN` takes Markdown and converts
 * it into native Docs structure (headings, lists, tables, emphasis), which is
 * exactly what Cue's editor stores. That makes Markdown the *only* input worth
 * accepting here: a PDF or DOCX would arrive as an opaque attachment in Drive,
 * not as something the recipient can edit, so those are refused with a pointer
 * at the format that works rather than silently downgraded.
 *
 * Verified against the live Composio API on 2026-08-15.
 */

import { executeComposioAction } from "./composio-transport.js";
import type {
  Destination,
  DestinationOutcome,
  DestinationSendContext,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { notSent, payloadText, sent } from "./types.js";

const CREATE_ACTION = "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN";

/** Docs has no separate size limit worth enforcing beyond the API's own. */
const DOCS_MAX_BYTES = 10 * 1024 * 1024;

export function googleDocUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export const googleDocsDestination: Destination = {
  id: "google_docs",
  label: "Google Docs",
  toolkit: "googledocs",
  accepts: { binary: false, text: true },
  maxBytes: DOCS_MAX_BYTES,
  targetHelp:
    "No target needed — the document is created in the account's Drive. Use `message` to override the title.",

  async send(
    payload: ExportPayload,
    target: DestinationTarget,
    context: DestinationSendContext,
  ): Promise<DestinationOutcome> {
    const markdown = payloadText(payload);
    if (markdown === null) {
      return notSent(
        "unsupported_payload",
        "Google Docs needs the document as `markdown` — export it in that format to get an editable Doc.",
      );
    }

    const title =
      target.message?.trim() ||
      payload.title?.trim() ||
      payload.filename.replace(/\.[^.]+$/, "");

    const result = await executeComposioAction(
      CREATE_ACTION,
      { title, markdown_text: markdown },
      context.signal,
    );
    if (!result.ok) {
      return notSent(
        result.notConnected ? "not_connected" : "destination_error",
        result.notConnected
          ? "Google Docs is not connected — connect it in Connectors, then try again."
          : `Google Docs refused the document: ${result.error}`,
      );
    }

    const documentId = String(result.data.document_id ?? "");
    if (!documentId) {
      return notSent(
        "destination_error",
        "Google Docs did not return a document ID, so the write could not be confirmed.",
      );
    }

    return sent(`Created the Google Doc "${title}".`, {
      documentId,
      url: googleDocUrl(documentId),
      title,
    });
  },
};
