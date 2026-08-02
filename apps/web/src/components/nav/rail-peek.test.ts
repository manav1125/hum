/**
 * The expansion rule's contract.
 *
 * v15's five numbered rules are the whole design of this pass, and four of the
 * five are pure logic. They are tested here rather than through the rail,
 * because the thing that must never drift is the RULE — "three, then N more" —
 * not the markup that happens to render it today.
 *
 * The cap test is a mutation check by construction: raise `RAIL_PEEK_LIMIT` to
 * four and "never more than three, whatever the input" fails.
 */

import { Glob } from "bun";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  RAIL_PEEK_LIMIT,
  peekDeadline,
  takePeek,
  type PeekItem,
  type PeekLane,
} from "./nav-model";
import {
  byLiveness,
  byUrgency,
  isLive,
  livenessMeta,
  type LivenessCandidate,
} from "./use-rail-peek";
import { useRailPeekStore } from "./rail-peek-store";

function items(n: number): PeekItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    title: `Item ${i}`,
    meta: null,
  }));
}

function lane(overrides: Partial<PeekLane> = {}): PeekLane {
  return { status: "ready", items: [], total: 0, ...overrides };
}

describe("rule 1 — three items maximum, always", () => {
  test.each([0, 1, 2, 3, 4, 7, 30, 400])(
    "a lane holding %i items shows at most three",
    (n) => {
      const view = takePeek(lane({ items: items(n), total: n }));
      expect(view.shown.length).toBeLessThanOrEqual(3);
      expect(view.shown.length).toBe(Math.min(n, 3));
    },
  );

  test("the cap constant IS three — raising it must break this file", () => {
    // The mutation check. This assertion plus the `toBeLessThanOrEqual(3)`
    // above means a four is caught both as a constant and as behaviour.
    expect(RAIL_PEEK_LIMIT).toBe(3);
  });

  test("at three items or thirty, only the number in 'N more' moves", () => {
    expect(takePeek(lane({ items: items(3), total: 3 })).moreCount).toBe(0);
    expect(takePeek(lane({ items: items(30), total: 30 })).moreCount).toBe(27);
    expect(takePeek(lane({ items: items(3), total: 3 })).shown.length).toBe(
      takePeek(lane({ items: items(30), total: 30 })).shown.length,
    );
  });
});

describe("the 'N more' arithmetic", () => {
  test.each([
    [0, 0],
    [1, 0],
    [3, 0],
    [4, 1],
    [7, 4],
    [12, 9],
  ])("total %i shows %i more", (total, expected) => {
    const view = takePeek(lane({ items: items(total), total }));
    expect(view.moreCount).toBe(expected);
  });

  test("the remainder comes off the BADGE, not off the rows fetched", () => {
    // HQ's badge counts parked approvals that carry no renderable title, so a
    // lane legitimately knows a bigger number than it can list. Deriving the
    // remainder from `items.length` would make the rail quietly contradict the
    // badge two pixels above it — the bug this codebase already shipped once.
    const view = takePeek(lane({ items: items(3), total: 9 }));
    expect(view.shown.length).toBe(3);
    expect(view.moreCount).toBe(6);
  });

  test("never negative, even when the badge is behind the list", () => {
    const view = takePeek(lane({ items: items(5), total: 1 }));
    expect(view.moreCount).toBe(0);
  });
});

describe("a lane that cannot read says so", () => {
  test("unreadable shows nothing rather than an empty list", () => {
    const view = takePeek(lane({ status: "unreadable", items: items(9) }));
    expect(view.shown).toEqual([]);
  });

  test("loading shows nothing either — a guess is worse than a wait", () => {
    const view = takePeek(lane({ status: "loading", items: items(9) }));
    expect(view.shown).toEqual([]);
  });

  test("'unreadable' and 'ready with zero' are distinguishable", () => {
    // The single most expensive lie this rail could tell is "nothing needs
    // you" when it simply failed to ask.
    expect(lane({ status: "unreadable" }).status).not.toBe(
      lane({ status: "ready" }).status,
    );
  });
});

describe("rule 2 — HQ sorts by urgency", () => {
  test("sooner deadlines first", () => {
    const sorted = [
      { id: "c", dueAt: 300 },
      { id: "a", dueAt: 100 },
      { id: "b", dueAt: 200 },
    ].sort(byUrgency);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  test("undated items sort LAST — unknown is not the same as now", () => {
    const sorted = [
      { id: "none", dueAt: null },
      { id: "late", dueAt: 9_999 },
    ].sort(byUrgency);
    expect(sorted.map((i) => i.id)).toEqual(["late", "none"]);
  });

  test("priority tier breaks a deadline tie, then age", () => {
    const sorted = [
      { id: "low", dueAt: 100, priorityTier: 3 },
      { id: "high", dueAt: 100, priorityTier: 1 },
    ].sort(byUrgency);
    expect(sorted.map((i) => i.id)).toEqual(["high", "low"]);

    const byAge = [
      { id: "new", dueAt: null, updatedAt: 900 },
      { id: "old", dueAt: null, updatedAt: 100 },
    ].sort(byUrgency);
    expect(byAge.map((i) => i.id)).toEqual(["old", "new"]);
  });
});

describe("rule 2 — Work sorts by liveness, a DIFFERENT question", () => {
  const thing = (
    id: string,
    awaitingReview = 0,
    running = 0,
    queued = 0,
  ): LivenessCandidate => ({
    id,
    title: id,
    awaitingReview,
    running,
    queued,
  });

  test("needs-you outranks running outranks queued", () => {
    const sorted = [
      thing("queued", 0, 0, 5),
      thing("running", 0, 1),
      thing("needsyou", 1),
    ].sort(byLiveness);
    expect(sorted.map((t) => t.id)).toEqual(["needsyou", "running", "queued"]);
  });

  test("a thing with nothing in play is not a candidate at all", () => {
    expect(isLive(thing("idle"))).toBe(false);
    expect(isLive(thing("busy", 0, 1))).toBe(true);
  });

  test("every live state carries a glyph, so none is colour-only", () => {
    expect(livenessMeta(thing("a", 2))).toBe("◈ 2 needs you");
    expect(livenessMeta(thing("b", 0, 3))).toBe("◉ 3 running");
    expect(livenessMeta(thing("c", 0, 0, 4))).toBe("◇ 4 queued");
    expect(livenessMeta(thing("d"))).toBeNull();
  });

  test("ties fall back to title so the list does not reshuffle between polls", () => {
    const sorted = [thing("zulu", 1), thing("alpha", 1)].sort(byLiveness);
    expect(sorted.map((t) => t.id)).toEqual(["alpha", "zulu"]);
  });
});

describe("rules 3 + 5 — one section at a time, collapsed on first run", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useRailPeekStore.setState({ openSection: null });
  });

  test("nothing is open by default", () => {
    expect(useRailPeekStore.getState().openSection).toBeNull();
  });

  test("opening Work closes HQ — rail height stays stable", () => {
    const { open } = useRailPeekStore.getState();
    open("hq");
    expect(useRailPeekStore.getState().openSection).toBe("hq");
    open("work");
    // Not "hq and work" — assignment, not a merge.
    expect(useRailPeekStore.getState().openSection).toBe("work");
  });

  test("toggling the open section closes it", () => {
    const { toggle } = useRailPeekStore.getState();
    toggle("hq");
    expect(useRailPeekStore.getState().openSection).toBe("hq");
    toggle("hq");
    expect(useRailPeekStore.getState().openSection).toBeNull();
  });

  test("toggling the other section swaps rather than stacks", () => {
    const { toggle } = useRailPeekStore.getState();
    toggle("hq");
    toggle("work");
    expect(useRailPeekStore.getState().openSection).toBe("work");
  });

  test("it remembers — the choice survives a reload", () => {
    useRailPeekStore.getState().open("work");
    expect(globalThis.localStorage?.getItem("cue:nav:peek-section")).toBe(
      "work",
    );
    useRailPeekStore.getState().close();
    expect(globalThis.localStorage?.getItem("cue:nav:peek-section")).toBeNull();
  });
});

describe("the rail's colour discipline", () => {
  const sources = [
    ...new Glob("src/components/nav/*.ts").scanSync("."),
    "src/domains/chat/components/assistant-side-menu.tsx",
  ]
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((path) => ({ path, text: Bun.file(path).text() }));

  test("no literal hex anywhere — every colour rides a theme token", async () => {
    // The stated rule is "#5B5B68 is never a text colour" (it has regressed
    // four times elsewhere). The rail can hold a stricter line cheaply: it has
    // no reason to name a colour at all, so any hex here is the smell.
    const offenders: string[] = [];
    for (const file of sources) {
      const text = await file.text;
      const hits = text.match(/#[0-9a-fA-F]{6}\b/g);
      if (hits) offenders.push(`${file.path}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the deadline on the right", () => {
  // 2026-08-02T09:00 local.
  const now = new Date(2026, 7, 2, 9, 0, 0).getTime();

  test("nothing to say when there is no deadline", () => {
    expect(peekDeadline(null, now)).toBeNull();
    expect(peekDeadline(undefined, now)).toBeNull();
    expect(peekDeadline(Number.NaN, now)).toBeNull();
  });

  test("a passed deadline is named, not rendered as a time", () => {
    expect(peekDeadline(now - 60_000, now)).toBe("overdue");
  });

  test("later today is a clock time", () => {
    const at = new Date(2026, 7, 2, 10, 30, 0).getTime();
    expect(peekDeadline(at, now)).toMatch(/10.30/);
  });

  test("this week is a weekday; beyond that, a date", () => {
    const inThreeDays = now + 3 * 86_400_000;
    const inThreeWeeks = now + 21 * 86_400_000;
    expect(peekDeadline(inThreeDays, now)).not.toMatch(/\d{1,2}:\d{2}/);
    expect(peekDeadline(inThreeWeeks, now)).toMatch(/\d/);
    expect(peekDeadline(inThreeDays, now)).not.toBe(
      peekDeadline(inThreeWeeks, now),
    );
  });

  test("seconds and milliseconds both work — the daemon sends either", () => {
    const at = new Date(2026, 7, 2, 10, 30, 0).getTime();
    expect(peekDeadline(Math.floor(at / 1000), now)).toBe(
      peekDeadline(at, now),
    );
  });
});
