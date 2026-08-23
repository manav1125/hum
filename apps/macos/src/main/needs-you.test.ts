/**
 * The menu-bar count — the surface that waits.
 *
 * The floating corner never appears unbidden: a panel that seizes focus over
 * your work to ask for money is the behaviour that gets an app quit. So
 * approvals reach the owner as a count they pull down instead, and this holds
 * it.
 *
 * The invariant worth guarding is that **main never counts for itself**. The
 * number is published by the renderer from the one hook HQ's badge already
 * reads; a menu bar that computed its own would become a second, louder count
 * that disagrees with the app, and two disagreeing counts mean neither gets
 * believed. So this module stores and truncates, and does nothing else.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const handlers = new Map<string, (args: unknown[]) => void>();

mock.module("./ipc", () => ({
  handle: mock(() => undefined),
  handleSync: mock(() => undefined),
  on: mock(
    (channel: string, _schema: unknown, fn: (args: unknown[]) => void) => {
      handlers.set(channel, fn);
    },
  ),
}));

const {
  __resetForTesting,
  getNeedsYou,
  hiddenNeedsYouCount,
  installNeedsYou,
  listedNeedsYou,
  onNeedsYouChange,
} = await import("./needs-you");

const publish = (count: number, items: { id: string; title: string }[]) => {
  handlers.get("vellum:needsYou:set")?.([{ count, items }]);
};

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: `Thing ${i}` }));

beforeEach(() => {
  __resetForTesting();
  handlers.clear();
  installNeedsYou();
});

describe("it stores what it is told", () => {
  test("starts at nothing, so a fresh launch renders no count", () => {
    expect(getNeedsYou()).toEqual({ count: 0, items: [] });
  });

  test("takes the renderer's number verbatim", () => {
    publish(2, many(2));
    expect(getNeedsYou().count).toBe(2);
  });

  test("MUTATION CHECK: it does not recount the items it was given", () => {
    // The count is HQ's count. If main ever derived it from `items.length`,
    // truncation or a partial list would silently change the number the
    // owner sees — and it would drift from the sidebar.
    publish(11, many(3));
    expect(getNeedsYou().count).toBe(11);
  });

  test("notifies listeners on change", () => {
    let fired = 0;
    onNeedsYouChange(() => fired++);
    publish(1, many(1));
    expect(fired).toBe(1);
  });
});

describe("what the pull-down shows", () => {
  test("lists a few, not everything — a glance, not a list to manage", () => {
    publish(9, many(9));
    expect(listedNeedsYou()).toHaveLength(5);
  });

  test("says how many it did not show rather than truncating silently", () => {
    // A count that quietly disagrees with its own list is the small
    // dishonesty this whole surface exists to avoid.
    publish(9, many(9));
    expect(hiddenNeedsYouCount()).toBe(4);
  });

  test("nothing hidden when everything fits", () => {
    publish(2, many(2));
    expect(hiddenNeedsYouCount()).toBe(0);
  });

  test("never reports a negative remainder when the count lags the list", () => {
    publish(1, many(3));
    expect(hiddenNeedsYouCount()).toBe(0);
  });
});
