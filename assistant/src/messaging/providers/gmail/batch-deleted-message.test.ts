/**
 * A deleted message must not kill the whole fetch.
 *
 * Gmail's History API reports a message, the user deletes it, and the fetch a
 * moment later answers 404 "Requested entity was not found". Under
 * `Promise.all` that single rejection failed the wave, which failed the poll,
 * which after five polls disabled the watcher permanently. Deleting mail is the
 * most ordinary thing anyone does to an inbox, so the Gmail watcher was
 * guaranteed to self-destruct in normal use.
 *
 * These drive the REAL `batchGetMessages` rather than a copy of its logic. The
 * first attempt at this fix tested an extracted helper, passed, and shipped
 * without working — because production takes the individual-fetch path (a
 * Composio proxy connection has no `withToken`, so the batch endpoint is never
 * used) and that path had its own unguarded `Promise.all`. A test that cannot
 * tell those two paths apart cannot tell you whether the fix works.
 */

import { describe, expect, test } from "bun:test";

import { batchGetMessages } from "./client.js";

/**
 * A connection shaped like the Composio proxy: it serves requests but cannot
 * expose a raw token, so `batchGetMessages` falls back to individual fetches.
 * `deleted` ids answer 404 the way Gmail does for a message that is gone.
 */
function connectionWith(opts: {
  deleted?: Set<string>;
  failWith?: { id: string; status: number; message: string };
}) {
  return {
    id: "conn",
    provider: "google",
    accountInfo: "composio",
    // No withToken — this is what forces the individual-fetch path.
    async request(req: { path: string }) {
      const id = req.path.split("/").pop() ?? "";
      if (opts.failWith && id === opts.failWith.id) {
        return {
          status: opts.failWith.status,
          headers: {},
          body: { error: { message: opts.failWith.message } },
        };
      }
      if (opts.deleted?.has(id)) {
        return {
          status: 404,
          headers: {},
          body: { error: { message: "Requested entity was not found." } },
        };
      }
      return {
        status: 200,
        headers: {},
        body: { id, labelIds: ["INBOX"] },
      };
    },
  } as unknown as Parameters<typeof batchGetMessages>[0];
}

describe("batchGetMessages with deleted messages", () => {
  test("drops the gone message and keeps the rest", async () => {
    const conn = connectionWith({ deleted: new Set(["b"]) });
    const msgs = await batchGetMessages(conn, ["a", "b", "c"], "metadata");
    expect(msgs.map((m) => m.id)).toEqual(["a", "c"]);
  });

  test("a lone deleted message yields nothing rather than throwing", async () => {
    // History often reports exactly one new message, so the single-id shortcut
    // is the likeliest place to meet a deletion.
    const conn = connectionWith({ deleted: new Set(["only"]) });
    expect(await batchGetMessages(conn, ["only"], "metadata")).toEqual([]);
  });

  test("every message deleted still resolves empty", async () => {
    const conn = connectionWith({ deleted: new Set(["a", "b"]) });
    expect(await batchGetMessages(conn, ["a", "b"], "metadata")).toEqual([]);
  });

  // NOTE: 429 and 5xx are deliberately NOT used here. `getMessage` retries
  // those with backoff — correct behaviour, but it makes the assertion a
  // multi-second timing test rather than a semantic one. 400 exercises the
  // same branch (a non-404 error must propagate) without the retry ladder.
  test("a non-404 error is NOT swallowed as a missing message", async () => {
    // Treating every error as "deleted" would turn a failing poll into a
    // silent no-op and lose real mail.
    const conn = connectionWith({
      failWith: { id: "b", status: 400, message: "malformed request" },
    });
    await expect(
      batchGetMessages(conn, ["a", "b", "c"], "metadata"),
    ).rejects.toThrow(/400|malformed/);
  });

  test("an untouched set is unaffected", async () => {
    const conn = connectionWith({});
    const msgs = await batchGetMessages(conn, ["a", "b", "c"], "metadata");
    expect(msgs.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
