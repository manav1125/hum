/**
 * Two halves of the same question: what is a watcher pointed at, and what has
 * it actually produced?
 *
 * Neither was answerable before. A watcher row records HOW to poll and never
 * WHAT it polls, so the Automations card had nothing truthful to show and
 * showed `last_poll_at` under the label "Last hit". In production a GitHub
 * watcher polled cleanly ~320 times over 27 hours, recorded zero events, and
 * read as "hit 2m ago" the whole time.
 *
 * The specific claim these tests hold: a one-click GitHub watcher — created
 * with a name and a source and nothing else — IS pointed at something. The
 * Notifications API is scoped to the authenticated account, not to a repo, so
 * "no repo configured" is not evidence of an inert watcher, and nothing may
 * render it as one.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const { getDb } = await import("../../memory/db-connection.js");
const { initializeDb } = await import("../../memory/db-init.js");
const { githubProvider } = await import("../providers/github.js");
const { createWatcher, getWatcherHitStats, insertWatcherEvent } =
  await import("../watcher-store.js");

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
});

describe("githubProvider.describeScope", () => {
  test("a watcher created with no config is still watching something", () => {
    const scope = githubProvider.describeScope!({});

    // The whole answer to "can a one-click GitHub watcher ever produce?".
    // If this ever flips to false, the create path must start asking for a
    // repo — the card would correctly grey the watcher out, and one-click
    // would be minting something that cannot work.
    expect(scope.watching).toBe(true);
    expect(scope.summary.length).toBeGreaterThan(0);
  });

  test("the summary names the notification reasons the poll actually keeps", () => {
    const summary = githubProvider.describeScope!({}).summary.toLowerCase();

    // The fetch loop drops every reason outside assign / mention /
    // review_requested / team_mention. A sentence that promised more than that
    // would send the owner looking for hits that are filtered out by design.
    expect(summary).toContain("assigned");
    expect(summary).toContain("mention");
    expect(summary).toContain("review");
    // And it must say the scope is the account, not a repo — "points nowhere"
    // was the owner's read of an account-wide watcher with no repo on it.
    expect(summary).toContain("account");
    expect(summary).toContain("repo");
  });

  test("config it does not use never makes it claim a narrower scope", () => {
    // Nothing in the create path writes config for GitHub, but a stale or
    // hand-edited row must not change what the owner is told is watched.
    const withJunk = githubProvider.describeScope!({ repo: "x", org: "y" });
    expect(withJunk).toEqual(githubProvider.describeScope!({}));
  });
});

describe("githubProvider.fetchNew watermark", () => {
  test("advances to when the fetch STARTED, never to when it finished", async () => {
    const realConnection = await import("../../oauth/connection-resolver.js");
    const delayMs = 40;
    mock.module("../../oauth/connection-resolver.js", () => ({
      ...realConnection,
      resolveOAuthConnection: async () => ({
        request: async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          return { status: 200, body: [] };
        },
      }),
    }));
    const { githubProvider: provider } = await import("../providers/github.js");

    const before = Date.now();
    const result = await provider.fetchNew("github", null, {}, "w-test");
    const after = Date.now();

    // Stamping the watermark AFTER the loop silently drops every notification
    // whose `updated_at` lands inside the fetch — no error, no log, the events
    // just cease to exist. Re-reading an overlap is free (the store dedups on
    // externalId), so the watermark must never move past the fetch's start.
    const mark = new Date(result.watermark).getTime();
    expect(mark).toBeGreaterThanOrEqual(before);
    expect(mark).toBeLessThan(after - delayMs / 2);
  });
});

describe("getWatcherHitStats", () => {
  function makeWatcher(name: string, providerId: string) {
    return createWatcher({
      name,
      providerId,
      actionPrompt: `Monitor ${name}`,
      credentialService: providerId,
    });
  }

  test("a watcher that has produced nothing is not counted as having hit", () => {
    const quiet = makeWatcher("GitHub", "github");
    const busy = makeWatcher("Gmail", "gmail");

    insertWatcherEvent({
      watcherId: busy.id,
      externalId: "m1",
      eventType: "new_email",
      summary: "one",
      payloadJson: "{}",
      occurredAt: 1_700_000_000_000,
    });
    insertWatcherEvent({
      watcherId: busy.id,
      externalId: "m2",
      eventType: "new_email",
      summary: "two",
      payloadJson: "{}",
      occurredAt: 1_700_000_060_000,
    });

    const stats = getWatcherHitStats();

    // Absent, not zero-with-a-timestamp: there is no "last hit" to report, and
    // the surface must not be able to reach for one.
    expect(stats.has(quiet.id)).toBe(false);
    expect(stats.get(busy.id)?.hitCount).toBe(2);
  });

  test("the last hit is the source's time, not the time we polled", () => {
    const w = makeWatcher("Gmail", "gmail");
    const occurred = Date.now() - 7 * 24 * 3_600_000;

    insertWatcherEvent({
      watcherId: w.id,
      externalId: "m1",
      eventType: "new_email",
      summary: "a week old",
      payloadJson: "{}",
      occurredAt: occurred,
    });

    // `created_at` is now (we just wrote the row). Reading that as "last hit"
    // would render a week-old arrival as "just now" — a fresh-looking lie in
    // exactly the direction that hides a source going quiet.
    expect(getWatcherHitStats().get(w.id)?.lastHitAt).toBe(occurred);
  });

  test("an event with no source time still counts as a hit", () => {
    const w = makeWatcher("Linear", "linear");

    insertWatcherEvent({
      watcherId: w.id,
      externalId: "i1",
      eventType: "issue",
      summary: "no occurred_at",
      payloadJson: "{}",
      occurredAt: null,
    });

    const stat = getWatcherHitStats().get(w.id);
    expect(stat?.hitCount).toBe(1);
    // Falls back to when we recorded it rather than dropping the row — a hit
    // with an unknown source time is still a hit.
    expect(stat?.lastHitAt).toBeGreaterThan(0);
  });
});
