/**
 * gmailMessagingProvider.markImportantByQuery — the adapter method behind the
 * `messaging_mark_important` bundled tool.
 *
 * Mirrors archiveByQuery's shape: paginate list, batchModify in bounded
 * chunks. These drive the REAL client `request` path via a fake connection
 * (the same technique as batch-deleted-message.test.ts) so the pagination,
 * chunking, and label payloads are the ones production sends.
 */

import { describe, expect, test } from "bun:test";

import type { OAuthConnection } from "../../../oauth/connection.js";
import { gmailMessagingProvider } from "./adapter.js";

interface RecordedCall {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
}

/**
 * A connection serving `total` message ids in list pages of `pageSize`, and
 * accepting batchModify calls. Records every request for assertions.
 */
function connectionWith(opts: { total: number; pageSize?: number }): {
  conn: OAuthConnection;
  calls: RecordedCall[];
} {
  const pageSize = opts.pageSize ?? 500;
  const ids = Array.from({ length: opts.total }, (_, i) => `m${i}`);
  const calls: RecordedCall[] = [];
  const conn = {
    id: "conn",
    provider: "google",
    async request(req: {
      method: string;
      path: string;
      query?: Record<string, string | string[]>;
      body?: unknown;
    }) {
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      calls.push({
        method: req.method,
        path: req.path,
        query: req.query,
        body,
      });
      if (req.path === "/messages") {
        const start = Number(
          (req.query?.pageToken as string | undefined) ?? "0",
        );
        const max = Number(req.query?.maxResults ?? pageSize);
        const page = ids.slice(start, start + Math.min(max, pageSize));
        const next = start + page.length;
        return {
          status: 200,
          headers: {},
          body: {
            messages: page.map((id) => ({ id })),
            ...(next < ids.length ? { nextPageToken: String(next) } : {}),
          },
        };
      }
      if (req.path === "/messages/batchModify") {
        return { status: 200, headers: {}, body: {} };
      }
      throw new Error(`unexpected path ${req.path}`);
    },
  } as unknown as OAuthConnection;
  return { conn, calls };
}

describe("gmail markImportantByQuery", () => {
  test("marks all matches with IMPORTANT across list pages, chunked at 1000", async () => {
    const { conn, calls } = connectionWith({ total: 1200 });
    const result = await gmailMessagingProvider.markImportantByQuery!(
      conn,
      "from:board@example.com in:inbox",
    );
    expect(result).toEqual({ marked: 1200, truncated: false });

    const modifies = calls.filter((c) => c.path === "/messages/batchModify");
    expect(modifies).toHaveLength(2); // 1000 + 200
    const bodies = modifies.map(
      (c) => c.body as { ids: string[]; addLabelIds: string[] },
    );
    expect(bodies[0].ids).toHaveLength(1000);
    expect(bodies[1].ids).toHaveLength(200);
    for (const b of bodies) {
      expect(b.addLabelIds).toEqual(["IMPORTANT"]);
    }
    // Every listed id is modified exactly once.
    expect(new Set(bodies.flatMap((b) => b.ids)).size).toBe(1200);
    // The list calls carried the caller's query.
    const lists = calls.filter((c) => c.path === "/messages");
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) {
      expect(l.query?.q).toBe("from:board@example.com in:inbox");
    }
  });

  test("star: true adds STARRED alongside IMPORTANT", async () => {
    const { conn, calls } = connectionWith({ total: 3 });
    const result = await gmailMessagingProvider.markImportantByQuery!(
      conn,
      "from:vip@example.com",
      { star: true },
    );
    expect(result.marked).toBe(3);
    const modify = calls.find((c) => c.path === "/messages/batchModify");
    expect(
      (modify?.body as { addLabelIds: string[] }).addLabelIds,
    ).toEqual(["IMPORTANT", "STARRED"]);
  });

  test("no matches: marks nothing and never calls batchModify", async () => {
    const { conn, calls } = connectionWith({ total: 0 });
    const result = await gmailMessagingProvider.markImportantByQuery!(
      conn,
      "from:nobody@example.com",
    );
    expect(result).toEqual({ marked: 0 });
    expect(calls.some((c) => c.path === "/messages/batchModify")).toBe(false);
  });

  test("caps at 5000 and reports truncation when more pages remain", async () => {
    const { conn, calls } = connectionWith({ total: 5100 });
    const result = await gmailMessagingProvider.markImportantByQuery!(
      conn,
      "in:inbox",
    );
    expect(result).toEqual({ marked: 5000, truncated: true });
    const modifies = calls.filter((c) => c.path === "/messages/batchModify");
    expect(
      modifies.reduce(
        (n, c) => n + (c.body as { ids: string[] }).ids.length,
        0,
      ),
    ).toBe(5000);
  });
});
