/**
 * Composio reports per-action failures *inside* an HTTP 200 envelope. An
 * implementation that trusts the status code therefore reports a file as
 * delivered when Composio has just said it was not — the exact silent-success
 * failure this feature must not have. These tests pin both layers.
 *
 * The three-step upload sequence is also pinned here, because it was derived
 * from the live API rather than from documentation: a change to the order or
 * the payload shape breaks binary transport with no local symptom.
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

const { executeComposioAction, uploadBytesToComposio } =
  await import("../composio-transport.js");

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("executeComposioAction", () => {
  it("returns the payload on a confirmed success", async () => {
    stubFetch(() =>
      json({ data: { id: "file_1" }, successful: true, error: null }),
    );
    const result = await executeComposioAction("GOOGLEDRIVE_UPLOAD_FILE", {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("file_1");
  });

  it("treats `successful: false` inside an HTTP 200 as a failure", async () => {
    stubFetch(() =>
      json({ data: {}, successful: false, error: "Insufficient permissions" }),
    );
    const result = await executeComposioAction("GOOGLEDRIVE_UPLOAD_FILE", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Insufficient permissions");
  });

  it("treats a non-null `error` inside an HTTP 200 as a failure", async () => {
    stubFetch(() => json({ data: { id: "x" }, error: "quota exceeded" }));
    const result = await executeComposioAction(
      "NOTION_APPEND_BLOCK_CHILDREN",
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("refuses to call an empty success a success", async () => {
    // Composio said it worked but returned nothing to point at, so there is
    // no evidence the write happened.
    stubFetch(() => json({ successful: true, error: null }));
    const result = await executeComposioAction(
      "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN",
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("flags an auth failure as `notConnected` so the user is told to reconnect", async () => {
    stubFetch(() =>
      json({ successful: false, error: "No connected account found for user" }),
    );
    const result = await executeComposioAction(
      "HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notConnected).toBe(true);
  });

  it("distinguishes a bad request from a dead connection", async () => {
    stubFetch(() =>
      json({ successful: false, error: "invalid argument: block_id" }),
    );
    const result = await executeComposioAction(
      "NOTION_APPEND_BLOCK_CHILDREN",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notConnected).toBe(false);
  });

  it("surfaces an HTTP error rather than swallowing it", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const result = await executeComposioAction("GOOGLEDRIVE_UPLOAD_FILE", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
  });

  it("surfaces a transport failure rather than swallowing it", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const result = await executeComposioAction("GOOGLEDRIVE_UPLOAD_FILE", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("network unreachable");
  });

  it("sends the user id and arguments Composio expects", async () => {
    stubFetch(() => json({ data: { id: "1" }, successful: true }));
    await executeComposioAction("GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN", {
      title: "T",
    });
    expect(calls[0].url).toContain(
      "/tools/execute/GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN",
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.user_id).toBe("test-user");
    expect(body.arguments.title).toBe("T");
  });
});

describe("uploadBytesToComposio", () => {
  const file = {
    bytes: Buffer.from("binary-ish"),
    filename: "report.pdf",
    mimeType: "application/pdf",
  };

  it("presigns, PUTs the bytes, and returns the file reference", async () => {
    stubFetch((url) => {
      if (url.includes("/files/upload/request")) {
        return json({
          key: "k/abc",
          new_presigned_url: "https://storage.example/put",
          type: "new",
        });
      }
      return new Response(null, { status: 200 });
    });

    const result = await uploadBytesToComposio(
      "googledrive",
      "GOOGLEDRIVE_UPLOAD_FILE",
      file,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref).toEqual({
        name: "report.pdf",
        mimetype: "application/pdf",
        s3key: "k/abc",
      });
    }
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://storage.example/put");
    expect(calls[1].init.method).toBe("PUT");
  });

  it("skips the upload when Composio already holds these exact bytes", async () => {
    // The presign is content-addressed by MD5, so a repeat send of the same
    // export must not re-transfer it.
    stubFetch(() => json({ key: "k/abc", type: "existing" }));
    const result = await uploadBytesToComposio(
      "googledrive",
      "GOOGLEDRIVE_UPLOAD_FILE",
      file,
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("sends the content hash so the presign can be content-addressed", async () => {
    stubFetch(() => json({ key: "k", type: "existing" }));
    await uploadBytesToComposio("googledrive", "GOOGLEDRIVE_UPLOAD_FILE", file);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.md5).toMatch(/^[a-f0-9]{32}$/);
    expect(body.toolkit_slug).toBe("googledrive");
    expect(body.tool_slug).toBe("GOOGLEDRIVE_UPLOAD_FILE");
    expect(body.mimetype).toBe("application/pdf");
  });

  it("fails when the object store rejects the bytes", async () => {
    stubFetch((url) => {
      if (url.includes("/files/upload/request")) {
        return json({
          key: "k",
          new_presigned_url: "https://storage.example/put",
          type: "new",
        });
      }
      return new Response(null, { status: 403 });
    });
    const result = await uploadBytesToComposio(
      "googledrive",
      "GOOGLEDRIVE_UPLOAD_FILE",
      file,
    );
    expect(result.ok).toBe(false);
  });

  it("fails when the presign returns no key", async () => {
    stubFetch(() => json({ type: "new" }));
    const result = await uploadBytesToComposio(
      "googledrive",
      "GOOGLEDRIVE_UPLOAD_FILE",
      file,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a file over Composio's 5 MB ceiling without a round trip", async () => {
    stubFetch(() => json({}));
    const result = await uploadBytesToComposio(
      "googledrive",
      "GOOGLEDRIVE_UPLOAD_FILE",
      {
        ...file,
        bytes: Buffer.alloc(6 * 1024 * 1024),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("5 MB");
    expect(calls).toHaveLength(0);
  });
});
