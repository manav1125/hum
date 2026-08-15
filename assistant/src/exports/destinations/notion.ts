/**
 * Notion destination — blocks, not files.
 *
 * Notion's API has no file-upload surface reachable through Composio: a page
 * body is a tree of typed blocks and nothing else. So this destination takes
 * the document's Markdown and rebuilds it as native Notion blocks, which is
 * genuinely better than an attachment — the result is editable Notion content.
 *
 * The honest limitation, stated in the tool description rather than papered
 * over: a PDF, PNG, DOCX or XLSX cannot be sent to Notion at all. Notion can
 * only *link* to a binary file, and Cue has nowhere public to host one, so
 * offering it would mean shipping a link that 404s.
 *
 * Blocks are appended in batches of 100 (Notion's per-request ceiling). A
 * partial append is reported as a partial failure, never as a success.
 */

import { executeComposioAction } from "./composio-transport.js";
import {
  chunkNotionBlocks,
  markdownToNotionBlocks,
} from "./markdown-to-notion-blocks.js";
import type {
  Destination,
  DestinationOutcome,
  DestinationSendContext,
  DestinationTarget,
  ExportPayload,
} from "./types.js";
import { notSent, payloadText, sent } from "./types.js";

const APPEND_ACTION = "NOTION_APPEND_BLOCK_CHILDREN";

const NOTION_MAX_BYTES = 5 * 1024 * 1024;

export const notionDestination: Destination = {
  id: "notion",
  label: "Notion",
  toolkit: "notion",
  accepts: { binary: false, text: true },
  maxBytes: NOTION_MAX_BYTES,
  targetHelp:
    "Notion page ID (or block ID) to append the content to. Required.",

  async send(
    payload: ExportPayload,
    target: DestinationTarget,
    context: DestinationSendContext,
  ): Promise<DestinationOutcome> {
    const blockId = target.id?.trim();
    if (!blockId) {
      return notSent(
        "bad_target",
        "Name the Notion page ID to append the document to.",
      );
    }

    const markdown = payloadText(payload);
    if (markdown === null) {
      return notSent(
        "unsupported_payload",
        "Notion can only receive the document as `markdown` — it has no way to store a PDF, image or Office file.",
      );
    }

    const blocks = markdownToNotionBlocks(markdown);
    if (blocks.length === 0) {
      return notSent(
        "unsupported_payload",
        "The document produced no Notion content to append.",
      );
    }

    const batches = chunkNotionBlocks(blocks);
    let appended = 0;
    for (const batch of batches) {
      const result = await executeComposioAction(
        APPEND_ACTION,
        { block_id: blockId, children: batch },
        context.signal,
      );
      if (!result.ok) {
        // Partial writes are real and must be said out loud — the user needs
        // to know the page is now half-populated.
        const partial =
          appended > 0
            ? ` ${appended} of ${blocks.length} blocks were already added, so the page is partially updated.`
            : "";
        return notSent(
          result.notConnected ? "not_connected" : "destination_error",
          result.notConnected
            ? `Notion is not connected — connect it in Connectors, then try again.${partial}`
            : `Notion refused the content: ${result.error}${partial}`,
        );
      }
      appended += batch.length;
    }

    return sent(
      `Appended ${appended} block${appended === 1 ? "" : "s"} to the Notion page.`,
      { blockId, blocksAppended: appended },
    );
  },
};
