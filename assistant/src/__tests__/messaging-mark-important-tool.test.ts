/**
 * messaging_mark_important bundled tool — input validation, provider
 * capability gating, and result phrasing over a mocked provider.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MessagingProvider } from "../messaging/provider.js";
import type { MarkImportantResult } from "../messaging/provider-types.js";
import type { OAuthConnection } from "../oauth/connection.js";
import type { ToolContext } from "../tools/types.js";

const markImportantMock = mock(
  async (
    _connection: OAuthConnection | undefined,
    _query: string,
    _options?: { star?: boolean },
  ): Promise<MarkImportantResult> => ({ marked: 3, truncated: false }),
);

const provider: MessagingProvider = {
  id: "gmail",
  displayName: "Gmail",
  credentialService: "google",
  capabilities: new Set(["labels"]),
  testConnection: async () => ({
    connected: true,
    user: "x",
    platform: "gmail",
  }),
  listConversations: async () => [],
  getHistory: async () => [],
  search: async () => ({ total: 0, messages: [], hasMore: false }),
  sendMessage: async () => ({
    id: "m",
    timestamp: 0,
    conversationId: "c",
  }),
  markImportantByQuery: (conn, query, options) =>
    markImportantMock(conn, query, options),
};

/** A provider without the capability, for the gating test. */
const bareProvider: MessagingProvider = {
  ...provider,
  displayName: "Bare",
  markImportantByQuery: undefined,
};

let activeProvider: MessagingProvider = provider;

const actualShared = await import(
  "../config/bundled-skills/messaging/tools/shared.js"
);
mock.module("../config/bundled-skills/messaging/tools/shared.js", () => ({
  ...actualShared,
  resolveProvider: async () => activeProvider,
  getProviderConnection: async () => undefined,
}));

const { run } = await import(
  "../config/bundled-skills/messaging/tools/messaging-mark-important.js"
);

const ctx = {} as ToolContext;

beforeEach(() => {
  activeProvider = provider;
  markImportantMock.mockClear();
  markImportantMock.mockResolvedValue({ marked: 3, truncated: false });
});

describe("messaging_mark_important", () => {
  test("requires a query", async () => {
    const result = await run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
    expect(markImportantMock).not.toHaveBeenCalled();
  });

  test("errors when the provider lacks markImportantByQuery", async () => {
    activeProvider = bareProvider;
    const result = await run({ query: "in:inbox" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Bare does not support marking messages as important",
    );
  });

  test("marks matches and reports the count", async () => {
    const result = await run(
      { query: "from:board@example.com in:inbox" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Marked 3 message(s) as important");
    expect(result.content).not.toContain("starred");
    const [, query, options] = markImportantMock.mock.calls[0];
    expect(query).toBe("from:board@example.com in:inbox");
    expect(options).toEqual({ star: false });
  });

  test("star: true is forwarded and reflected in the summary", async () => {
    const result = await run({ query: "from:vip@x.com", star: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("starred");
    expect(markImportantMock.mock.calls[0][2]).toEqual({ star: true });
  });

  test("zero matches reads as a no-op, not an error", async () => {
    markImportantMock.mockResolvedValue({ marked: 0 });
    const result = await run({ query: "from:nobody@x.com" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Nothing marked");
  });

  test("truncation is surfaced so the model can re-run", async () => {
    markImportantMock.mockResolvedValue({ marked: 5000, truncated: true });
    const result = await run({ query: "in:inbox" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("capped at 5000");
  });

  test("provider errors surface as tool errors", async () => {
    markImportantMock.mockRejectedValue(new Error("Gmail 429"));
    const result = await run({ query: "in:inbox" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Gmail 429");
  });
});
