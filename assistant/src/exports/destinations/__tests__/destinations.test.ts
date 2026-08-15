/**
 * Per-destination wiring.
 *
 * Every argument name asserted here was read off the live Composio action
 * schema on 2026-08-15, and several are not guessable — HubSpot's association
 * target is `to__id` (two underscores, Composio's flattening of `to.id`), and
 * Drive uses two entirely different actions depending on whether the payload
 * is text or binary. A typo in any of them fails only against the real API, so
 * these tests are the local stand-in for a live send.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const actualProvision =
  await import("../../../capabilities/composio-mcp-provision.js");
mock.module("../../../capabilities/composio-mcp-provision.js", () => ({
  ...actualProvision,
  readOwnComposioIdentity: () => ({
    apiKey: "test-key",
    userId: "test-user",
    catalog: [],
  }),
}));

const { googleDocsDestination } = await import("../google-docs.js");
const { googleDriveDestination } = await import("../google-drive.js");
const { hubspotDestination } = await import("../hubspot.js");
const { notionDestination } = await import("../notion.js");
const { sendExportToDestination } = await import("../send-export.js");

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: any }> = [];

function stubComposio(responder: (slug: string, body: any) => unknown): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    // The presigned PUT carries raw bytes, not JSON — recording it must not
    // throw, or the transport reads as a network failure.
    let body: unknown;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body });
    if (url.includes("/files/upload/request")) {
      return new Response(
        JSON.stringify({
          key: "s3/key",
          new_presigned_url: "https://storage.example/put",
          type: "new",
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://storage.example")) {
      return new Response(null, { status: 200 });
    }
    const slug = url.split("/tools/execute/")[1] ?? "";
    return new Response(JSON.stringify(responder(slug, body)), { status: 200 });
  }) as typeof fetch;
}

const markdown = {
  bytes: Buffer.from("# Report\n\nBody.\n"),
  filename: "report.md",
  mimeType: "text/markdown",
  title: "Report",
};
const pdf = {
  bytes: Buffer.from("%PDF-1.4 fake"),
  filename: "report.pdf",
  mimeType: "application/pdf",
  title: "Report",
};

const executedSlugs = () =>
  calls
    .map((c) => c.url.split("/tools/execute/")[1])
    .filter((s): s is string => Boolean(s));

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Google Drive", () => {
  it("sends text inline, without touching object storage", async () => {
    stubComposio(() => ({ data: { id: "file_1" }, successful: true }));
    const outcome = await googleDriveDestination.send(
      markdown,
      { id: "folder_9" },
      {},
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.confirmation.fileId).toBe("file_1");
      expect(outcome.confirmation.url).toContain("file_1");
    }
    expect(executedSlugs()).toEqual(["GOOGLEDRIVE_CREATE_FILE_FROM_TEXT"]);
    const args = calls[0].body.arguments;
    expect(args.file_name).toBe("report.md");
    expect(args.text_content).toContain("# Report");
    expect(args.parent_id).toBe("folder_9");
    expect(calls.some((c) => c.url.includes("/files/upload/request"))).toBe(
      false,
    );
  });

  it("routes binary through presign, PUT, then the upload action", async () => {
    stubComposio(() => ({ data: { id: "file_2" }, successful: true }));
    const outcome = await googleDriveDestination.send(pdf, {}, {});
    expect(outcome.ok).toBe(true);
    expect(calls[0].url).toContain("/files/upload/request");
    expect(calls[1].url).toBe("https://storage.example/put");
    expect(executedSlugs()).toEqual(["GOOGLEDRIVE_UPLOAD_FILE"]);
    expect(calls[2].body.arguments.file_to_upload).toEqual({
      name: "report.pdf",
      mimetype: "application/pdf",
      s3key: "s3/key",
    });
  });

  it("refuses binary over Composio's 5 MB ceiling", async () => {
    stubComposio(() => ({ data: {}, successful: true }));
    const outcome = await googleDriveDestination.send(
      { ...pdf, bytes: Buffer.alloc(6 * 1024 * 1024) },
      {},
      {},
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("too_large");
    expect(calls).toHaveLength(0);
  });

  it("fails when Drive returns no file id to confirm with", async () => {
    stubComposio(() => ({ data: { kind: "drive#file" }, successful: true }));
    const outcome = await googleDriveDestination.send(markdown, {}, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("destination_error");
  });
});

describe("Google Docs", () => {
  it("creates a document from markdown and returns an editable URL", async () => {
    stubComposio(() => ({ data: { document_id: "doc_1" }, successful: true }));
    const outcome = await googleDocsDestination.send(markdown, {}, {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.confirmation.documentId).toBe("doc_1");
      expect(outcome.confirmation.url).toBe(
        "https://docs.google.com/document/d/doc_1/edit",
      );
    }
    expect(executedSlugs()).toEqual(["GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN"]);
    expect(calls[0].body.arguments.markdown_text).toContain("# Report");
    expect(calls[0].body.arguments.title).toBe("Report");
  });

  it("lets the caller override the title", async () => {
    stubComposio(() => ({ data: { document_id: "doc_2" }, successful: true }));
    await googleDocsDestination.send(markdown, { message: "Q3 Plan" }, {});
    expect(calls[0].body.arguments.title).toBe("Q3 Plan");
  });

  it("refuses a PDF, pointing at the format that works", async () => {
    stubComposio(() => ({}));
    const outcome = await googleDocsDestination.send(pdf, {}, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("unsupported_payload");
      expect(outcome.summary).toContain("markdown");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Notion", () => {
  it("appends converted blocks to the named page", async () => {
    stubComposio(() => ({ data: { object: "list" }, successful: true }));
    const outcome = await notionDestination.send(
      markdown,
      { id: "page_1" },
      {},
    );
    expect(outcome.ok).toBe(true);
    expect(executedSlugs()).toEqual(["NOTION_APPEND_BLOCK_CHILDREN"]);
    const args = calls[0].body.arguments;
    expect(args.block_id).toBe("page_1");
    expect(args.children[0].type).toBe("heading_1");
  });

  it("batches a long document and reports the total appended", async () => {
    stubComposio(() => ({ data: { object: "list" }, successful: true }));
    const long = Array.from({ length: 150 }, (_, i) => `Para ${i}.`).join(
      "\n\n",
    );
    const outcome = await notionDestination.send(
      { ...markdown, bytes: Buffer.from(long) },
      { id: "page_1" },
      {},
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.confirmation.blocksAppended).toBe(150);
    expect(executedSlugs()).toHaveLength(2);
  });

  it("says so when a batch fails partway, instead of claiming success", async () => {
    let n = 0;
    stubComposio(() => {
      n += 1;
      return n === 1
        ? { data: { object: "list" }, successful: true }
        : { successful: false, error: "rate limited" };
    });
    const long = Array.from({ length: 150 }, (_, i) => `Para ${i}.`).join(
      "\n\n",
    );
    const outcome = await notionDestination.send(
      { ...markdown, bytes: Buffer.from(long) },
      { id: "page_1" },
      {},
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.summary).toContain("partially updated");
  });

  it("needs a page id", async () => {
    stubComposio(() => ({}));
    const outcome = await notionDestination.send(markdown, {}, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("bad_target");
  });
});

describe("HubSpot", () => {
  it("creates a note associated to the record with the right association type", async () => {
    stubComposio(() => ({ data: { id: "note_1" }, successful: true }));
    const outcome = await hubspotDestination.send(
      markdown,
      { id: "deal_7", objectType: "deals" },
      {},
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.confirmation.noteId).toBe("note_1");
    const args = calls[0].body.arguments;
    expect(args.objectType).toBe("notes");
    expect(args.properties.hs_note_body).toContain("Body.");
    // Composio flattens `to.id` to `to__id`; `to_id` is silently ignored.
    expect(args.associations[0].to__id).toBe("deal_7");
    expect(args.associations[0].types[0]).toEqual({
      associationCategory: "HUBSPOT_DEFINED",
      associationTypeId: 214,
    });
  });

  it("uses the contact association id when the target is a contact", async () => {
    stubComposio(() => ({ data: { id: "note_2" }, successful: true }));
    await hubspotDestination.send(
      markdown,
      { id: "c_1", objectType: "contacts" },
      {},
    );
    expect(
      calls[0].body.arguments.associations[0].types[0].associationTypeId,
    ).toBe(202);
  });

  it("rejects an object type a note cannot attach to", async () => {
    stubComposio(() => ({}));
    const outcome = await hubspotDestination.send(
      markdown,
      { id: "x", objectType: "invoices" },
      {},
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("bad_target");
    expect(calls).toHaveLength(0);
  });

  it("explains that a PDF cannot be attached rather than sending something else", async () => {
    stubComposio(() => ({}));
    const outcome = await hubspotDestination.send(pdf, { id: "deal_7" }, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unsupported_payload");
  });
});

describe("through the primitive", () => {
  it("a Composio-reported failure surfaces as a failed send, not a success", async () => {
    stubComposio(() => ({
      successful: false,
      error: "insufficient permissions",
    }));
    const outcome = await sendExportToDestination({
      payload: markdown,
      destinationId: "google_docs",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("destination_error");
      expect(outcome.summary).toContain("insufficient permissions");
    }
  });

  it("a dead connector surfaces as `not_connected`", async () => {
    stubComposio(() => ({
      successful: false,
      error: "No connected account found for this user",
    }));
    const outcome = await sendExportToDestination({
      payload: markdown,
      destinationId: "notion",
      target: { id: "page_1" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("not_connected");
  });
});
