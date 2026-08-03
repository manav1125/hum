/**
 * The Library composer, tested against the shape of the bug it exists to fix.
 *
 * The production failure this guards: the phone's Library read
 * `work_outputs` — the registry the work-item runner writes at run completion
 * — and rendered TWO cards for an owner holding 66 apps, 13 documents and 35
 * generated files. Nothing filtered those out; the query never asked for them.
 * So the assertions here are deliberately about REACH, not about formatting:
 * a document, an app and a plain generated file must each be able to appear in
 * a library that contains no work outputs at all.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { createApp, deleteApp, listApps } from "../memory/app-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { ROUTES } from "../runtime/routes/library-routes.js";
import { createTask } from "../tasks/task-store.js";
import { createWorkItem } from "../work-items/work-item-store.js";
import {
  createWorkOutput,
  listRecentOutputs,
} from "../work-items/work-output-store.js";
import { type LibraryItem, listLibraryItems } from "./library-store.js";

initializeDb();

const NOW = 1_770_000_000_000;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM work_outputs");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM documents");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  // Apps live on disk, not in the DB — a DELETE-only reset leaks them into
  // every later test in the file.
  for (const app of listApps()) deleteApp(app.id);
});

/** A conversation with one assistant turn and one user turn to hang files on. */
function seedConversation(id: string): {
  assistantMsg: string;
  userMsg: string;
} {
  const db = getDb();
  db.run(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${id}', 'T', ${NOW}, ${NOW})`,
  );
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES ('${id}-a', '${id}', 'assistant', 'here you go', ${NOW})`,
  );
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES ('${id}-u', '${id}', 'user', 'here, look at this', ${NOW})`,
  );
  return { assistantMsg: `${id}-a`, userMsg: `${id}-u` };
}

function seedAttachment(opts: {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  messageId: string;
  createdAt?: number;
}): void {
  const db = getDb();
  db.run(
    `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
     VALUES ('${opts.id}', '${opts.filename}', '${opts.mimeType}', 10, '${opts.kind}', '', ${opts.createdAt ?? NOW})`,
  );
  db.run(
    `INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
     VALUES ('ma-${opts.id}', '${opts.messageId}', '${opts.id}', 0, ${opts.createdAt ?? NOW})`,
  );
}

function seedDocument(
  surfaceId: string,
  title: string,
  conversationId: string,
) {
  getDb().run(
    `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
     VALUES ('${surfaceId}', '${conversationId}', '${title}', 'body', 120, ${NOW}, ${NOW})`,
  );
}

describe("the Library reaches past work_outputs", () => {
  test("a generated file with no work-run behind it is still in the library", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-sheet",
      filename: "Q3-model.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      kind: "document",
      messageId: assistantMsg,
    });

    const items = listLibraryItems();

    // This is the whole bug in one assertion: zero work_outputs, one library
    // item. Under the old `GET /outputs` query this list was empty.
    expect(listRecentOutputs()).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Q3-model.xlsx");
    expect(items[0]!.source).toBe("file");
    expect(items[0]!.kind).toBe("spreadsheet");
  });

  test("PDFs and spreadsheets are in it — the media-kinds default hid them", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-pdf",
      filename: "Board-Presentation.pdf",
      mimeType: "application/pdf",
      // Stored with kind 'document', which is exactly why a
      // kinds=audio,video,image read returned neither of these.
      kind: "document",
      messageId: assistantMsg,
    });
    seedAttachment({
      id: "att-img",
      filename: "chart.png",
      mimeType: "image/png",
      kind: "image",
      messageId: assistantMsg,
    });

    const kinds = listLibraryItems().map((i) => i.kind);
    expect(kinds).toContain("pdf");
    expect(kinds).toContain("image");
  });

  test("documents and apps are in it, opened by their own ids", () => {
    seedConversation("c1");
    seedDocument("doc-1", "Competitor Scan", "c1");
    const app = createApp({
      name: "Cue Success Dashboard",
      description: "the numbers",
      schemaJson: "{}",
      htmlDefinition: "<p>hi</p>",
    });

    const items = listLibraryItems();
    const doc = items.find((i) => i.source === "document");
    const built = items.find((i) => i.source === "app");

    expect(doc?.title).toBe("Competitor Scan");
    expect(doc?.documentId).toBe("doc-1");
    expect(built?.title).toBe("Cue Success Dashboard");
    expect(built?.appId).toBe(app.id);
    expect(built?.kind).toBe("app");
  });
});

describe("the Library states only what it can read", () => {
  test("a file nobody queued for review has NO review state", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-1",
      filename: "notes.md",
      mimeType: "text/markdown",
      kind: "document",
      messageId: assistantMsg,
    });
    seedDocument("doc-1", "Memo", "c1");

    // null, not "pending". A REVIEW badge on an artefact no run registered is
    // a status the daemon never reported.
    for (const item of listLibraryItems()) {
      expect(item.reviewState).toBeNull();
    }
  });

  test("a run-registered deliverable keeps its real review state and provenance", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-deck",
      filename: "Pitch.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      kind: "document",
      messageId: assistantMsg,
    });
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Build a deck" });
    createWorkOutput({
      workItemId: workItem.id,
      attachmentId: "att-deck",
      kind: "deck",
      title: "Pitch.pptx",
      why: "Deliverable from “Build a deck”",
      agent: "builder",
    });

    const items = listLibraryItems();
    // Merged ONTO the file, not listed beside it.
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("output");
    expect(items[0]!.reviewState).toBe("pending");
    expect(items[0]!.agent).toBe("builder");
    expect(items[0]!.workItemId).toBe(workItem.id);
    expect(items[0]!.attachment?.filename).toBe("Pitch.pptx");
  });
});

describe("what the Library deliberately leaves out", () => {
  test("a file the OWNER uploaded is not in it — inputs live in their thread", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-upload",
      filename: "photo-i-sent.jpg",
      mimeType: "image/jpeg",
      kind: "image",
      messageId: userMsg,
    });

    expect(listLibraryItems()).toHaveLength(0);
  });

  test("a tool-internal capture is not a deliverable, even registered as one", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-shot",
      filename: "browser-screenshot.jpeg",
      mimeType: "image/jpeg",
      kind: "image",
      messageId: assistantMsg,
    });
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Go look" });
    // The run-completion capture path registers EVERY attachment a run
    // produced, screenshots included. This is the exact row that shipped to
    // the owner's phone as one of his two "things Cue made".
    createWorkOutput({
      workItemId: workItem.id,
      attachmentId: "att-shot",
      kind: "image",
      title: "browser-screenshot.jpeg",
      agent: "cue",
    });

    expect(listLibraryItems()).toHaveLength(0);
  });

  test("a link-backed output survives having no attachment at all", () => {
    const task = createTask({ title: "T", template: "Do it" });
    const workItem = createWorkItem({ taskId: task.id, title: "Ship it" });
    createWorkOutput({
      workItemId: workItem.id,
      externalUrl: "https://justcue.ai",
      kind: "other",
      title: "justcue.ai",
      agent: "cue",
    });

    const items = listLibraryItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.externalUrl).toBe("https://justcue.ai");
  });
});

describe("ordering and the cap", () => {
  test("newest first across every source, and the cap applies after merging", () => {
    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-old",
      filename: "old.pdf",
      mimeType: "application/pdf",
      kind: "document",
      messageId: assistantMsg,
      createdAt: NOW - 90 * 86_400_000,
    });
    seedAttachment({
      id: "att-new",
      filename: "new.pdf",
      mimeType: "application/pdf",
      kind: "document",
      messageId: assistantMsg,
      createdAt: NOW,
    });
    seedDocument("doc-1", "Middle", "c1");
    getDb().run(
      `UPDATE documents SET created_at = ${NOW - 45 * 86_400_000} WHERE surface_id = 'doc-1'`,
    );

    expect(listLibraryItems().map((i) => i.title)).toEqual([
      "new.pdf",
      "Middle",
      "old.pdf",
    ]);
    // The cap must not silently favour whichever source was read first.
    expect(listLibraryItems({ limit: 1 }).map((i) => i.title)).toEqual([
      "new.pdf",
    ]);
  });
});

describe("GET library", () => {
  test("the route is registered, scoped to what it reads, and returns items", () => {
    const route = ROUTES.find(
      (r) => r.endpoint === "library" && r.method === "GET",
    )!;
    expect(route).toBeDefined();
    // It composes settings-scoped registries WITH attachment metadata, and
    // asks for both rather than borrowing one.
    expect(route.policy?.requiredScopes).toEqual([
      "settings.read",
      "attachments.read",
    ]);

    const { assistantMsg } = seedConversation("c1");
    seedAttachment({
      id: "att-1",
      filename: "One-pager.pdf",
      mimeType: "application/pdf",
      kind: "document",
      messageId: assistantMsg,
    });
    seedDocument("doc-1", "Concept Memo", "c1");

    const result = route.handler({ queryParams: {}, headers: {} }) as {
      items: LibraryItem[];
    };
    expect(result.items.map((i) => i.title).sort()).toEqual([
      "Concept Memo",
      "One-pager.pdf",
    ]);
  });
});
