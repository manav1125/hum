/**
 * "Things you sent" — the read behind the Library's search-only uploads section.
 *
 * The Library list is "made with Cue", and that cut was correct. The defect it
 * created was findability: a contract the owner uploaded three weeks ago was
 * reachable from no search anywhere, because every attachment listing in the
 * product filters to assistant-linked rows. This is the complement, and these
 * tests are about the boundary between the two sets rather than about matching:
 *
 *   · a file Cue made must never appear here (the Library already claims it),
 *   · a file the owner sent must appear here and nowhere else,
 *   · the two together must never double-count one file on one screen.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ROUTES } from "../../runtime/routes/attachment-routes.js";
import { BadRequestError } from "../../runtime/routes/errors.js";
import {
  listAttachments,
  MAX_UPLOAD_SEARCH,
  searchUploadedAttachments,
} from "../attachments-store.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";

initializeDb();

const uploadsRoute = () => {
  const found = ROUTES.find(
    (r) => r.operationId === "attachments_search_uploads",
  );
  expect(found).toBeDefined();
  return found!;
};

interface UploadsSearchResult {
  query: string;
  limit: number;
  truncated: boolean;
  uploads: Array<{
    id: string;
    original_filename: string;
    sourceConversation?: { id: string; title: string };
  }>;
}

const searchUploads = (queryParams: Record<string, string>) =>
  uploadsRoute().handler({ queryParams }) as UploadsSearchResult;

const NOW = 1_770_000_000_000;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
});

/** A thread with one assistant turn and one user turn to hang files on. */
function seedConversation(id: string): {
  assistantMsg: string;
  userMsg: string;
} {
  const db = getDb();
  db.run(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${id}', 'Contract review', ${NOW}, ${NOW})`,
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
  /** Every message this file is linked to. Two links = both roles. */
  messageIds: string[];
  kind?: string;
  mimeType?: string;
  createdAt?: number;
}): void {
  const db = getDb();
  db.run(
    `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
     VALUES ('${opts.id}', '${opts.filename}', '${opts.mimeType ?? "application/pdf"}', 10, '${opts.kind ?? "document"}', '', ${opts.createdAt ?? NOW})`,
  );
  opts.messageIds.forEach((messageId, i) => {
    db.run(
      `INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
       VALUES ('ma-${opts.id}-${i}', '${messageId}', '${opts.id}', ${i}, ${opts.createdAt ?? NOW})`,
    );
  });
}

const names = (rows: { originalFilename: string }[]): string[] =>
  rows.map((r) => r.originalFilename).sort();

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("the two sets are disjoint", () => {
  test("finds what the owner sent, and skips what Cue made", () => {
    const { assistantMsg, userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "acme-contract.pdf",
      messageIds: [userMsg],
    });
    seedAttachment({
      id: "g1",
      filename: "acme-contract-summary.pdf",
      messageIds: [assistantMsg],
    });

    const found = searchUploadedAttachments({ query: "acme" });
    expect(names(found)).toEqual(["acme-contract.pdf"]);
  });

  test("a file linked to BOTH roles belongs to the Library, not to uploads", () => {
    // The owner uploads a photo and Cue sends it back in an answer. It is
    // already claimed by the "made with Cue" list; returning it here too would
    // print one file twice on one screen, under two headings that contradict
    // each other.
    const { assistantMsg, userMsg } = seedConversation("c1");
    seedAttachment({
      id: "both",
      filename: "roof-photo.png",
      kind: "image",
      mimeType: "image/png",
      messageIds: [userMsg, assistantMsg],
    });

    expect(searchUploadedAttachments({ query: "roof" })).toHaveLength(0);
    // …and it IS in the list that claims it, so it has not vanished.
    expect(names(listAttachments({ kinds: ["image"] }))).toContain(
      "roof-photo.png",
    );
  });

  test("nothing an upload search returns is in the made-with-Cue list", () => {
    const { assistantMsg, userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "notes.png",
      kind: "image",
      mimeType: "image/png",
      messageIds: [userMsg],
    });
    seedAttachment({
      id: "g1",
      filename: "notes-chart.png",
      kind: "image",
      mimeType: "image/png",
      messageIds: [assistantMsg],
    });

    const uploadIds = new Set(
      searchUploadedAttachments({ query: "notes" }).map((r) => r.id),
    );
    const madeIds = new Set(
      listAttachments({ kinds: ["image"] }).map((r) => r.id),
    );
    expect(uploadIds.size).toBeGreaterThan(0);
    for (const id of uploadIds) expect(madeIds.has(id)).toBe(false);
  });

  test("voice-call audio and tool captures are not 'things you sent'", () => {
    // These ride user-role messages, so the role filter alone lets them
    // through — and a search for "screen" would otherwise return hundreds of
    // frames nobody consciously sent.
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "v1",
      filename: "live-voice-user-0001.pcm",
      messageIds: [userMsg],
    });
    seedAttachment({
      id: "t1",
      filename: "computer-use-screenshot-12.png",
      messageIds: [userMsg],
    });
    seedAttachment({
      id: "u1",
      filename: "user-research-notes.pdf",
      messageIds: [userMsg],
    });

    expect(names(searchUploadedAttachments({ query: "user" }))).toEqual([
      "user-research-notes.pdf",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The thread it lives in
// ---------------------------------------------------------------------------

describe("every row names the thread it lives in", () => {
  test("the conversation comes off the USER-role link", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "acme-contract.pdf",
      messageIds: [userMsg],
    });

    const [row] = searchUploadedAttachments({ query: "acme" });
    expect(row!.sourceConversationId).toBe("c1");
  });

  test("the route offers a link only when the thread still exists", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "acme-contract.pdf",
      messageIds: [userMsg],
    });

    const withThread = searchUploads({ q: "acme" });
    expect(withThread.uploads[0]!.sourceConversation).toEqual({
      id: "c1",
      title: "Contract review",
    });

    // Deleting the thread cascades to its messages, and the user-role link is
    // the only evidence the file was ever an upload — so the row leaves the
    // section entirely rather than lingering as an unlinkable orphan. Pinned
    // because the alternative (a row in "Things you sent · in their chats"
    // with no chat to go to) is exactly what the route's existence check is
    // there to prevent.
    getDb().run(`DELETE FROM conversations WHERE id = 'c1'`);
    expect(searchUploads({ q: "acme" }).uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The route — where the count is allowed to be printed, and where it is not
// ---------------------------------------------------------------------------

describe("GET attachments/uploads/search", () => {
  test("is registered where the client expects it", () => {
    expect(uploadsRoute().endpoint).toBe("attachments/uploads/search");
    expect(uploadsRoute().method).toBe("GET");
  });

  test("a short answer is whole, and says so", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "acme-contract.pdf",
      messageIds: [userMsg],
    });

    const out = searchUploads({ q: "acme" });
    expect(out.uploads).toHaveLength(1);
    expect(out.truncated).toBe(false);
    expect(out.query).toBe("acme");
  });

  test("a full page reports itself as a floor, not a total", () => {
    const { userMsg } = seedConversation("c1");
    for (let i = 0; i < MAX_UPLOAD_SEARCH + 7; i++) {
      seedAttachment({
        id: `u${i}`,
        filename: `report-${i}.pdf`,
        messageIds: [userMsg],
        createdAt: NOW - i,
      });
    }

    const out = searchUploads({ q: "report" });
    expect(out.uploads).toHaveLength(MAX_UPLOAD_SEARCH);
    // Without this the surface would print "50 things you sent" over a corpus
    // of 57 — the same defect as "All conversations · 151".
    expect(out.truncated).toBe(true);
  });

  test("a page that exactly fills the limit is still reported as a floor", () => {
    // The honest reading of a full page is "at least this many". It is not
    // knowable from here whether the 51st exists, so the flag stays true.
    const { userMsg } = seedConversation("c1");
    for (let i = 0; i < 3; i++) {
      seedAttachment({
        id: `u${i}`,
        filename: `report-${i}.pdf`,
        messageIds: [userMsg],
      });
    }

    expect(searchUploads({ q: "report", limit: "3" }).truncated).toBe(true);
    expect(searchUploads({ q: "report", limit: "4" }).truncated).toBe(false);
  });

  test("an empty query is rejected rather than returning the whole drawer", () => {
    expect(() => searchUploads({ q: "" })).toThrow(BadRequestError);
    expect(() => searchUploads({})).toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// Matching, and refusing to over-match
// ---------------------------------------------------------------------------

describe("matching", () => {
  test("is case-insensitive and matches inside the name", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "Q3-Board-Deck.pdf",
      messageIds: [userMsg],
    });

    expect(searchUploadedAttachments({ query: "board" })).toHaveLength(1);
    expect(searchUploadedAttachments({ query: "BOARD" })).toHaveLength(1);
    expect(searchUploadedAttachments({ query: "q3-board" })).toHaveLength(1);
  });

  test("LIKE metacharacters are searched literally, not as wildcards", () => {
    // "%" must find the file with a percent in its name, not every file.
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "u1",
      filename: "margin-50%-model.xlsx",
      messageIds: [userMsg],
    });
    seedAttachment({
      id: "u2",
      filename: "headcount.xlsx",
      messageIds: [userMsg],
    });

    expect(names(searchUploadedAttachments({ query: "50%" }))).toEqual([
      "margin-50%-model.xlsx",
    ]);
    // A bare wildcard matches the literal character, so it matches one file.
    expect(searchUploadedAttachments({ query: "%" })).toHaveLength(1);
    expect(searchUploadedAttachments({ query: "_" })).toHaveLength(0);
  });

  test("an empty query returns nothing rather than everything", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({ id: "u1", filename: "a.pdf", messageIds: [userMsg] });

    expect(searchUploadedAttachments({ query: "" })).toHaveLength(0);
    expect(searchUploadedAttachments({ query: "   " })).toHaveLength(0);
  });

  test("newest first", () => {
    const { userMsg } = seedConversation("c1");
    seedAttachment({
      id: "old",
      filename: "deck-v1.pdf",
      messageIds: [userMsg],
      createdAt: NOW - 100_000,
    });
    seedAttachment({
      id: "new",
      filename: "deck-v2.pdf",
      messageIds: [userMsg],
      createdAt: NOW,
    });

    expect(
      searchUploadedAttachments({ query: "deck" }).map((r) => r.id),
    ).toEqual(["new", "old"]);
  });
});

// ---------------------------------------------------------------------------
// The cap — so the surface can say the count is a floor
// ---------------------------------------------------------------------------

describe("the cap", () => {
  test("never returns more than the cap, however many match", () => {
    const { userMsg } = seedConversation("c1");
    for (let i = 0; i < MAX_UPLOAD_SEARCH + 12; i++) {
      seedAttachment({
        id: `u${i}`,
        filename: `report-${i}.pdf`,
        messageIds: [userMsg],
        createdAt: NOW - i,
      });
    }

    const rows = searchUploadedAttachments({ query: "report" });
    expect(rows).toHaveLength(MAX_UPLOAD_SEARCH);
    // A full page is what tells the caller the count is a floor — it must be
    // exactly the cap, not the cap minus one, or the signal is wrong.
    expect(rows.length).toBe(MAX_UPLOAD_SEARCH);
  });

  test("a caller cannot ask its way past the cap", () => {
    const { userMsg } = seedConversation("c1");
    for (let i = 0; i < MAX_UPLOAD_SEARCH + 5; i++) {
      seedAttachment({
        id: `u${i}`,
        filename: `report-${i}.pdf`,
        messageIds: [userMsg],
      });
    }

    expect(
      searchUploadedAttachments({ query: "report", limit: 10_000 }),
    ).toHaveLength(MAX_UPLOAD_SEARCH);
  });
});
