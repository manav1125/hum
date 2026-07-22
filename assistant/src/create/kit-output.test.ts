/**
 * Tests for kit output capture (kit-output.ts).
 *
 * Regression guard for the fan-out kit's silent-empty bug: doc-mode formats
 * (one-pager / email / landing) produce a DOCUMENT surface and never an
 * attachment, so an attachment-only capture marked them `done` with
 * `outputRef = null` and the kit view had nothing to show or download for the
 * majority of its formats.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { initializeDb } from "../memory/db-init.js";
import { rawRun } from "../memory/raw-query.js";
import { saveDocument } from "../documents/document-store.js";
import {
  firstRunProducedOutputRef,
  parseKitOutputRef,
} from "./kit-output.js";

initializeDb();

const CONV = "kit-output-test-conversation";

function seedConversation(id: string): void {
  const now = Date.now();
  rawRun(
    "INSERT OR REPLACE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    id,
    "Kit asset: one_pager",
    now,
    now,
  );
}

function seedProducedAttachment(conversationId: string, id: string): void {
  const now = Date.now();
  rawRun(
    "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', '[]', ?)",
    `msg-${id}`,
    conversationId,
    now,
  );
  rawRun(
    "INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at) VALUES (?, 'social.png', 'image/png', 10, 'image', '', ?)",
    id,
    now,
  );
  rawRun(
    "INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at) VALUES (?, ?, ?, 0, ?)",
    `ma-${id}`,
    `msg-${id}`,
    id,
    now,
  );
}

beforeEach(() => {
  rawRun("DELETE FROM message_attachments");
  rawRun("DELETE FROM attachments");
  rawRun("DELETE FROM messages");
  rawRun("DELETE FROM document_conversations");
  rawRun("DELETE FROM documents");
  rawRun("DELETE FROM conversations WHERE id = ?", CONV);
  seedConversation(CONV);
});

describe("parseKitOutputRef", () => {
  test("a bare id decodes as an attachment (the original encoding)", () => {
    expect(parseKitOutputRef("att-1")).toEqual({
      kind: "attachment",
      id: "att-1",
    });
  });

  test("a document: ref decodes as a document surface", () => {
    expect(parseKitOutputRef("document:doc-9")).toEqual({
      kind: "document",
      id: "doc-9",
    });
  });

  test("null and empty refs decode to nothing", () => {
    expect(parseKitOutputRef(null)).toBeNull();
    expect(parseKitOutputRef("")).toBeNull();
    expect(parseKitOutputRef("document:")).toBeNull();
  });
});

describe("firstRunProducedOutputRef", () => {
  test("captures a document when the run produced no attachment", () => {
    saveDocument({
      surfaceId: "doc-one-pager",
      conversationId: CONV,
      title: "JustCue.ai — One-Page Summary",
      content: "# Summary",
      wordCount: 521,
    });

    const ref = firstRunProducedOutputRef(CONV);

    expect(ref).toBe("document:doc-one-pager");
    expect(parseKitOutputRef(ref)).toEqual({
      kind: "document",
      id: "doc-one-pager",
    });
  });

  test("an attachment wins over a document when the run produced both", () => {
    seedProducedAttachment(CONV, "att-social");
    saveDocument({
      surfaceId: "doc-notes",
      conversationId: CONV,
      title: "Working notes",
      content: "notes",
      wordCount: 4,
    });

    expect(firstRunProducedOutputRef(CONV)).toBe("att-social");
  });

  test("a run that produced neither reports nothing", () => {
    expect(firstRunProducedOutputRef(CONV)).toBeNull();
  });
});
