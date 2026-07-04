import { describe, expect, test } from "bun:test";

import type { FeedItem, FeedItemUrgency } from "@vellumai/assistant-api";

import { selectNextMove, selectNoticed } from "./utils";

let seq = 0;
function item(overrides: Partial<FeedItem> = {}): FeedItem {
  seq += 1;
  return {
    id: `item-${seq}`,
    type: "notification",
    priority: 50,
    summary: `summary ${seq}`,
    timestamp: "2026-06-13T09:00:00.000Z",
    status: "new",
    createdAt: "2026-06-13T09:00:00.000Z",
    ...overrides,
  };
}

const urgent = (u: FeedItemUrgency, rest: Partial<FeedItem> = {}) =>
  item({ urgency: u, ...rest });

describe("selectNextMove", () => {
  test("returns null when nothing is high/critical urgency", () => {
    expect(
      selectNextMove([urgent("low"), urgent("medium"), item()]),
    ).toBeNull();
  });

  test("picks the high/critical item over low/medium ones", () => {
    const target = urgent("high", { id: "urgent-1" });
    const next = selectNextMove([urgent("low"), target, item()]);
    expect(next?.id).toBe("urgent-1");
  });

  test("among urgent items, highest priority wins; createdAt breaks ties", () => {
    const winner = urgent("critical", { id: "win", priority: 90 });
    const byPriority = selectNextMove([
      urgent("high", { id: "lo", priority: 40 }),
      winner,
    ]);
    expect(byPriority?.id).toBe("win");

    const newer = urgent("high", {
      id: "newer",
      priority: 70,
      createdAt: "2026-06-13T10:00:00.000Z",
    });
    const older = urgent("high", {
      id: "older",
      priority: 70,
      createdAt: "2026-06-13T08:00:00.000Z",
    });
    expect(selectNextMove([older, newer])?.id).toBe("newer");
  });

  test("ignores dismissed and acted-on urgent items", () => {
    expect(
      selectNextMove([
        urgent("high", { status: "dismissed" }),
        urgent("critical", { status: "acted_on" }),
      ]),
    ).toBeNull();
  });
});

describe("selectNoticed", () => {
  test("returns the remaining urgent items, excluding the next move", () => {
    const top = urgent("critical", { id: "top", priority: 90 });
    const second = urgent("high", { id: "second", priority: 60 });
    const third = urgent("high", { id: "third", priority: 40 });
    const noticed = selectNoticed([third, top, second, item()], "top");
    expect(noticed.map((i) => i.id)).toEqual(["second", "third"]);
  });

  test("honors the limit and skips dismissed/acted-on", () => {
    const items = [
      urgent("high", { id: "a", priority: 80 }),
      urgent("high", { id: "b", priority: 70 }),
      urgent("high", { id: "c", priority: 60 }),
      urgent("high", { id: "gone", status: "dismissed" }),
    ];
    expect(selectNoticed(items, "a", 1).map((i) => i.id)).toEqual(["b"]);
    expect(selectNoticed(items, "a").map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("is empty when nothing else is urgent", () => {
    expect(
      selectNoticed([urgent("high", { id: "only" }), item()], "only"),
    ).toEqual([]);
  });
});
