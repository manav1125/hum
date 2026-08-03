/**
 * The arrival clock: what a stored timestamp is allowed to claim.
 *
 * `arrivals` carries two times and they answer different questions.
 * `createdAt` is when Cue wrote the row — a fact about the poll. `occurredAt`
 * is when the message was sent — the only one of the two that is a fact about
 * the correspondent.
 *
 * These tests exist because the tempting shortcut (default `occurredAt` to
 * `now` so the column is never null) reintroduces the exact bug the column was
 * added to fix, and does so invisibly: every row would carry a plausible,
 * well-typed, non-null event time that is really a reading of daemon uptime.
 * On the owner's instance that shortcut had already produced 344 of 425
 * arrivals sharing one calendar day. So the assertions below are written to
 * FAIL if anyone reinstates the fallback.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb, getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createWatcher,
  getPendingEvents,
  insertWatcherEvent,
} from "../watcher/watcher-store.js";
import { recordArrival } from "./arrival-store.js";

initializeDb();

/** A real send time, well clear of "now" so a fallback cannot masquerade. */
const SENT_AT = 1_785_000_000_000;

let watcherId = "";
let seq = 0;

beforeEach(() => {
  getDb().run("DELETE FROM arrivals");
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
  watcherId = createWatcher({
    name: "Gmail",
    providerId: "gmail",
    actionPrompt: "",
    credentialService: "gmail",
  }).id;
});

function arrival(occurredAt: number | null | undefined) {
  return recordArrival({
    channel: "watcher:gmail",
    externalId: `ext-${++seq}`,
    title: "A subject line",
    senderAddress: "person@example.com",
    disposition: "surfaced",
    decidedBy: "rule",
    ...(occurredAt === undefined ? {} : { occurredAt }),
  });
}

describe("arrivals record when the message was sent, not when Cue looked", () => {
  test("keeps the provider's send time exactly", () => {
    expect(arrival(SENT_AT).occurredAt).toBe(SENT_AT);
  });

  test("the send time survives the round trip through SQLite", () => {
    const id = arrival(SENT_AT).id;
    const stored = getSqliteFrom(getDb())
      .query(`SELECT occurred_at FROM arrivals WHERE id = ?`)
      .get(id) as { occurred_at: number | null };
    expect(stored.occurred_at).toBe(SENT_AT);
  });

  /**
   * THE MUTATION CHECK. Change `recordArrival` to `input.occurredAt ?? now`
   * and this test is what goes red.
   *
   * Note it asserts on the gap rather than just `toBeNull()`: a fallback to
   * `now` would still be a number, and a bare null check would pass the moment
   * somebody "helpfully" made the column non-null. The claim under test is not
   * "the field is empty" — it is "Cue never asserts a send time it was not
   * told", which is the property that keeps an outage from reading as news
   * about a person.
   */
  test("never substitutes the current time when the provider gave none", () => {
    const before = Date.now();
    const row = arrival(undefined);
    const after = Date.now();

    expect(row.occurredAt).toBeNull();
    // `createdAt` is the observation clock and is allowed to be now.
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBeLessThanOrEqual(after);
    // `occurredAt` is not, and must not have quietly become a copy of it.
    expect(row.occurredAt).not.toBe(row.createdAt);
  });

  test("an explicit null is honoured, not treated as absent", () => {
    expect(arrival(null).occurredAt).toBeNull();
  });

  /**
   * The two clocks must stay independently observable. A mail sent last month
   * and polled today is a month-old message noticed today — collapsing that to
   * one number is what made 344 messages look simultaneous.
   */
  test("send time and observation time are recorded separately", () => {
    const row = arrival(SENT_AT);
    expect(row.occurredAt).toBe(SENT_AT);
    expect(row.createdAt).toBeGreaterThan(SENT_AT);
    expect(row.createdAt).not.toBe(row.occurredAt);
  });
});

describe("watcher events carry the source clock to the arrival boundary", () => {
  function insert(occurredAt: number | null | undefined): void {
    insertWatcherEvent({
      watcherId,
      externalId: `we-${++seq}`,
      eventType: "new_email",
      summary: "Email from a person",
      payloadJson: "{}",
      ...(occurredAt === undefined ? {} : { occurredAt }),
    });
  }

  function onlyEvent() {
    const events = getPendingEvents(watcherId);
    expect(events).toHaveLength(1);
    return events[0]!;
  }

  test("stores the provider's event time", () => {
    insert(SENT_AT);
    expect(onlyEvent().occurredAt).toBe(SENT_AT);
  });

  test("stores null when the provider had no time", () => {
    insert(undefined);
    const event = onlyEvent();
    expect(event.occurredAt).toBeNull();
    expect(event.occurredAt).not.toBe(event.createdAt);
  });

  /**
   * Providers reach this value through `new Date(header).getTime()` and
   * `parseInt`, both of which yield NaN for input they cannot parse. NaN must
   * degrade to "unknown" rather than land in the column as a number-shaped
   * value that every later comparison silently answers false to.
   */
  test.each([
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["epoch zero", 0],
    ["a negative time", -1],
  ])("rejects %s as an event time", (_label, value) => {
    insert(value);
    expect(onlyEvent().occurredAt).toBeNull();
  });
});
