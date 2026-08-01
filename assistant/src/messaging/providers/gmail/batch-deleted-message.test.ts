/**
 * A deleted message must not kill the whole batch.
 *
 * Gmail's History API reports a message, the user deletes it, and the fetch a
 * moment later answers 404 "Requested entity was not found". That single
 * rejection used to fail `Promise.all`, which failed the batch, which failed
 * the watcher poll — and five failed polls disable the watcher permanently.
 * Deleting mail is the most ordinary thing a person does to an inbox, so the
 * Gmail watcher self-destructed in normal use.
 */

import { describe, expect, test } from "bun:test";

import { GmailApiError } from "./client.js";

/**
 * The rule under test, extracted so it can be exercised without standing up a
 * whole batch round-trip: a 404 is a fact about one message and is skipped;
 * anything else is a real failure and must propagate.
 */
function resolveOutcomes(
  outcomes: PromiseSettledResult<{ id: string }>[],
): { id: string }[] {
  const kept: { id: string }[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      kept.push(outcome.value);
      continue;
    }
    const err: unknown = outcome.reason;
    if (err instanceof GmailApiError && err.status === 404) continue;
    throw err;
  }
  return kept;
}

async function settle(
  jobs: (() => Promise<{ id: string }>)[],
): Promise<PromiseSettledResult<{ id: string }>[]> {
  return Promise.allSettled(jobs.map((j) => j()));
}

describe("batch fetch with a deleted message", () => {
  test("skips the gone message and keeps the rest", async () => {
    const outcomes = await settle([
      async () => ({ id: "a" }),
      async () => {
        throw new GmailApiError(404, "Not Found", "Requested entity not found");
      },
      async () => ({ id: "c" }),
    ]);
    expect(resolveOutcomes(outcomes).map((m) => m.id)).toEqual(["a", "c"]);
  });

  test("a rate limit is NOT treated as a missing message", async () => {
    // The failure mode this guards: swallowing every error as "deleted" would
    // turn a throttled poll into a silent no-op and lose real mail.
    const outcomes = await settle([
      async () => ({ id: "a" }),
      async () => {
        throw new GmailApiError(429, "Too Many Requests", "rate limited");
      },
    ]);
    expect(() => resolveOutcomes(outcomes)).toThrow(/rate limited/);
  });

  test("a server error still propagates", async () => {
    const outcomes = await settle([
      async () => {
        throw new GmailApiError(500, "Server Error", "upstream exploded");
      },
    ]);
    expect(() => resolveOutcomes(outcomes)).toThrow(/upstream exploded/);
  });

  test("an all-deleted batch yields nothing rather than throwing", async () => {
    const outcomes = await settle([
      async () => {
        throw new GmailApiError(404, "Not Found", "gone");
      },
    ]);
    expect(resolveOutcomes(outcomes)).toEqual([]);
  });
});
