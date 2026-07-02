import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

// Real modules captured before mock.module replaces them, so every mock below
// can spread the full export set. mock.module leaks process-wide in bun —
// a PARTIAL mock breaks any module loaded later in the same test process that
// imports an export the mock omitted (SyntaxError: Export named ... not found).
//
// The namespace objects are LIVE views (they reflect the mock once
// mock.module runs), so each is snapshotted into a plain object first —
// spreading the namespace later would spread the mock, not the real module.
import * as actualVideoThumbnail from "../daemon/video-thumbnail.js";
import * as actualChecker from "../permissions/checker.js";
import * as actualPermissionTypes from "../permissions/types.js";

const realChecker = { ...actualChecker };
const realPermissionTypes = { ...actualPermissionTypes };
const realVideoThumbnail = { ...actualVideoThumbnail };

// Stub out video thumbnail generation (requires ffmpeg)
mock.module("../daemon/video-thumbnail.js", () => ({
  ...realVideoThumbnail,
  generateVideoThumbnail: () => Promise.resolve(null),
  generateVideoThumbnailFromPath: () => Promise.resolve(null),
}));

// Stub out permission checker / trust store
const checkSpy = mock(() => Promise.resolve({ decision: "allow" }));
const addRuleSpy = mock(() => {});

mock.module("../permissions/checker.js", () => ({
  ...realChecker,
  check: checkSpy,
  classifyRisk: () => Promise.resolve({ level: "low" }),
  generateAllowlistOptions: () => Promise.resolve([]),
  generateScopeOptions: () => [],
}));

// Virtual module: no ../permissions/trust-store.ts exists on disk, so there
// is no real export set to spread — this registration only satisfies legacy
// specifier lookups.
mock.module("../permissions/trust-store.js", () => ({
  addRule: addRuleSpy,
}));

mock.module("../permissions/types.js", () => ({
  ...realPermissionTypes,
  isAllowDecision: () => true,
}));

import type { AssistantAttachmentDraft } from "../daemon/assistant-attachments.js";
// Snapshotted BEFORE any per-test mock.module of this specifier, so the
// partial mocks below can spread the real exports (see the note above on
// live namespace views). A partial mock would break later first-time imports
// of unrelated exports (e.g. daemon/handlers/shared.ts importing
// estimateBase64Bytes).
import * as actualAssistantAttachments from "../daemon/assistant-attachments.js";

const realAssistantAttachments = { ...actualAssistantAttachments };
import {
  getAttachmentMetadataForMessage,
  getFilePathForAttachment,
  uploadAttachmentFromBytes,
} from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Create a base64 string of approximately `bytes` decoded size.
 */
function makeBase64(bytes: number): string {
  const buf = Buffer.alloc(bytes, 0x41); // fill with 'A'
  return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// resolveAssistantAttachments — all attachments are now file-backed
// ---------------------------------------------------------------------------

describe("resolveAssistantAttachments", () => {
  beforeEach(() => {
    resetTables();
    checkSpy.mockClear();
    addRuleSpy.mockClear();
  });

  // Individual tests below replace assistant-attachments with a partial mock.
  // mock.module leaks process-wide in bun, so re-register the real module
  // after each test — otherwise files that run later in the same process
  // (e.g. assistant-attachments.test.ts) would silently exercise the mock.
  afterEach(() => {
    mock.module("../daemon/assistant-attachments.js", () => ({
      ...realAssistantAttachments,
    }));
  });

  test("small attachments are stored on disk via uploadAttachment", async () => {
    const conv = createConversation("test-conv");
    const msg = await addMessage(conv.id, "assistant", "hello");

    const smallSize = 2 * 1024 * 1024; // 2 MB
    const dataBase64 = makeBase64(smallSize);

    const draft: AssistantAttachmentDraft = {
      sourceType: "sandbox_file",
      filename: "small-image.png",
      mimeType: "image/png",
      dataBase64,
      sizeBytes: smallSize,
      kind: "image",
    };

    mock.module("../daemon/assistant-attachments.js", () => ({
      ...realAssistantAttachments,
      resolveDirectives: () =>
        Promise.resolve({ drafts: [draft], warnings: [] }),
      contentBlocksToDrafts: () => [],
      deduplicateDrafts: (d: AssistantAttachmentDraft[]) => d,
      validateDrafts: (d: AssistantAttachmentDraft[]) => ({
        accepted: d,
        warnings: [],
      }),
    }));

    // Re-import to pick up mocks
    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");

    const result = await resolve(
      [
        {
          source: "sandbox" as const,
          path: "/fake",
          filename: "small-image.png",
          mimeType: "image/png",
        },
      ],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
    );

    expect(result.emittedAttachments.length).toBe(1);
    const emitted = result.emittedAttachments[0];
    expect(emitted.id).toBeDefined();

    // All attachments are file-backed and have a file on disk
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).not.toBeNull();
    expect(existsSync(filePath!)).toBe(true);

    // fileBacked flag is always true now
    expect(emitted.fileBacked).toBe(true);
  });

  test("large attachments are stored on disk with file path", async () => {
    const conv = createConversation("test-conv-large");
    const msg = await addMessage(conv.id, "assistant", "hello");

    const largeSize = 10 * 1024 * 1024; // 10 MB
    const dataBase64 = makeBase64(largeSize);

    const draft: AssistantAttachmentDraft = {
      sourceType: "sandbox_file",
      filename: "big-video.mov",
      mimeType: "video/quicktime",
      dataBase64,
      sizeBytes: largeSize,
      kind: "video",
    };

    mock.module("../daemon/assistant-attachments.js", () => ({
      ...realAssistantAttachments,
      resolveDirectives: () =>
        Promise.resolve({ drafts: [draft], warnings: [] }),
      contentBlocksToDrafts: () => [],
      deduplicateDrafts: (d: AssistantAttachmentDraft[]) => d,
      validateDrafts: (d: AssistantAttachmentDraft[]) => ({
        accepted: d,
        warnings: [],
      }),
    }));

    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");

    const result = await resolve(
      [
        {
          source: "sandbox" as const,
          path: "/fake",
          filename: "big-video.mov",
          mimeType: "video/quicktime",
        },
      ],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
    );

    expect(result.emittedAttachments.length).toBe(1);
    const emitted = result.emittedAttachments[0];
    expect(emitted.id).toBeDefined();

    // Verify the file exists on disk at the expected path
    const filePath = getFilePathForAttachment(emitted.id!);
    expect(filePath).not.toBeNull();
    expect(filePath!).toContain("attachments");
    expect(filePath!).toContain("big-video.mov");
    expect(existsSync(filePath!)).toBe(true);

    // fileBacked flag is always true now
    expect(emitted.fileBacked).toBe(true);
  });

  test("tool-produced attachment ids are linked to the assistant message", async () => {
    const conv = createConversation("test-conv-tool-attachment");
    const msg = await addMessage(conv.id, "assistant", "spreadsheet ready");

    // Simulate an asset tool (spreadsheet_create / pdf_create): the tool
    // uploads the bytes to the attachments store itself and returns the id
    // via ToolExecutionResult.attachmentIds — no directive, no content block.
    const stored = uploadAttachmentFromBytes(
      "model.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      new Uint8Array(Buffer.from("fake xlsx bytes")),
    );

    // Before the fix nothing linked the row: GET messages hydrates from the
    // message_attachments table, which stayed empty.
    expect(getAttachmentMetadataForMessage(msg.id)).toHaveLength(0);

    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");
    const result = await resolve(
      [],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
      undefined,
      [stored.id],
    );

    // The stored attachment is now linked to the assistant message row.
    const linked = getAttachmentMetadataForMessage(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].originalFilename).toBe("model.xlsx");
    expect(linked[0].mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    // And it is emitted for live clients (metadata-only, lazily hydrated).
    expect(result.emittedAttachments).toHaveLength(1);
    const emitted = result.emittedAttachments[0];
    expect(emitted.id).toBe(linked[0].id);
    expect(emitted.filename).toBe("model.xlsx");
    expect(emitted.fileBacked).toBe(true);
    expect(emitted.data).toBe("");
    expect(emitted.sizeBytes).toBe(linked[0].sizeBytes);
  });

  test("duplicate and unknown tool attachment ids are handled gracefully", async () => {
    const conv = createConversation("test-conv-tool-attachment-dupes");
    const msg = await addMessage(conv.id, "assistant", "done");

    const stored = uploadAttachmentFromBytes(
      "report.pdf",
      "application/pdf",
      new Uint8Array(Buffer.from("%PDF-1.4 fake")),
    );

    const { resolveAssistantAttachments: resolve } =
      await import("../daemon/conversation-attachments.js");
    const result = await resolve(
      [],
      [],
      [],
      "/tmp",
      async () => true,
      msg.id,
      undefined,
      // A missing id must not abort linking of the valid one, and a repeated
      // id must link (and emit) only once.
      ["does-not-exist", stored.id, stored.id],
    );

    const linked = getAttachmentMetadataForMessage(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].originalFilename).toBe("report.pdf");
    expect(result.emittedAttachments).toHaveLength(1);
  });
});

describe("approveHostAttachmentRead", () => {
  beforeEach(() => {
    resetTables();
    checkSpy.mockClear();
    addRuleSpy.mockClear();
  });

  test("prompts and allows on allow decision", async () => {
    const conversation = createConversation("attachment-host-gate");
    const promptSpy = mock(() =>
      Promise.resolve({ decision: "allow" as const }),
    );

    const { approveHostAttachmentRead } =
      await import("../daemon/conversation-attachments.js");

    const allowed = await approveHostAttachmentRead(
      "/tmp/example.txt",
      "/tmp",
      { prompt: promptSpy } as never,
      conversation.id,
      false,
    );

    expect(allowed).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
    expect(addRuleSpy).not.toHaveBeenCalled();
    const call = promptSpy.mock.calls[0] as unknown as unknown[];
    expect(call[3]).toEqual([]);
    expect(call[4]).toEqual([]);
    expect(call[8]).toBe(false); // persistentDecisionsAllowed
  });

  test("denies when hasNoClient is true without prompting", async () => {
    const conversation = createConversation("attachment-no-client");
    const promptSpy = mock(() =>
      Promise.resolve({ decision: "allow" as const }),
    );

    const { approveHostAttachmentRead } =
      await import("../daemon/conversation-attachments.js");

    const allowed = await approveHostAttachmentRead(
      "/tmp/example.txt",
      "/tmp",
      { prompt: promptSpy } as never,
      conversation.id,
      true,
    );

    expect(allowed).toBe(false);
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
