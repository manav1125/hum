import { describe, expect, test } from "bun:test";

import type { FeedItem, FeedItemUrgency } from "@vellumai/assistant-api";

import { selectNextMove } from "./utils";

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
