/**
 * Round-trip tests for the arrivals API: the census, the filed list with its
 * reasons, and the reversal that puts a filed arrival back in the lane.
 *
 * The handlers are called directly (auth lives in the transport layer), but
 * they read and write the real database — the assertions are about rows.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  recordArrival,
  type RecordArrivalInput,
} from "../../arrivals/arrival-store.js";
import { localDate, zonedWallClockToMs } from "../../calendar/day-rail.js";
import { getDb, getSqliteFrom } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItem,
  listWorkItems,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { ROUTES } from "./arrivals-routes.js";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";

initializeDb();

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM arrivals");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
});

function route(operationId: string) {
  const found = ROUTES.find((r) => r.operationId === operationId);
  expect(found).toBeDefined();
  return found!;
}

function seed(overrides: Partial<RecordArrivalInput> = {}) {
  return recordArrival({
    channel: "watcher:gmail",
    externalId: `msg-${Math.random().toString(36).slice(2)}`,
    title: "Your weekly digest",
    senderAddress: "news@example.org",
    senderName: "Stripe",
    disposition: "filed",
    reason: "newsletter from Stripe",
    decidedBy: "rule",
    ruleId: "list_mail",
    ...overrides,
  });
}

describe("GET arrivals/summary", () => {
  const summaryRoute = () => route("getArrivalsSummary");

  function summary(queryParams?: Record<string, string>) {
    return summaryRoute().handler({ queryParams }) as {
      arrived: number;
      filed: number;
      kept: number;
      reversed: number;
      windowHours: number | null;
      bound: "trailing_window" | "local_day" | "explicit";
      timeZone: string | null;
      since: number;
      until: number;
      topFiledReasons: Array<{ reason: string; count: number }>;
    };
  }

  test("is registered at arrivals/summary", () => {
    expect(summaryRoute().endpoint).toBe("arrivals/summary");
    expect(summaryRoute().method).toBe("GET");
  });

  test("counts arrived / filed / kept off the disposition itself", () => {
    seed();
    seed();
    seed({
      disposition: "surfaced",
      reason: "you're a direct recipient and it's from a person",
      decidedBy: "rule",
      ruleId: "direct_human",
    });

    const out = summary();
    expect(out.arrived).toBe(3);
    expect(out.filed).toBe(2);
    expect(out.kept).toBe(1);
    expect(out.arrived).toBe(out.filed + out.kept);
    expect(out.windowHours).toBe(24);
    expect(out.since).toBeLessThan(out.until);
  });

  test("an empty window reports honest zeroes rather than omitting fields", () => {
    const out = summary();
    expect(out).toMatchObject({ arrived: 0, filed: 0, kept: 0, reversed: 0 });
    expect(out.topFiledReasons).toEqual([]);
  });

  test("ranks the filing reasons the owner would ask about", () => {
    seed({ reason: "newsletter from Stripe" });
    seed({ reason: "newsletter from Stripe" });
    seed({ reason: "automated build notification" });

    expect(summary().topFiledReasons).toEqual([
      { reason: "newsletter from Stripe", count: 2 },
      { reason: "automated build notification", count: 1 },
    ]);
  });

  test("respects the window", () => {
    const old = seed();
    getSqliteFrom(getDb()).run(
      /*sql*/ `UPDATE arrivals SET created_at = ? WHERE id = ?`,
      [Date.now() - 48 * 3_600_000, old.id],
    );
    seed();

    expect(summary({ windowHours: "24" }).arrived).toBe(1);
    expect(summary({ windowHours: "72" }).arrived).toBe(2);
  });

  test("rejects a nonsense window rather than silently widening it", () => {
    expect(() => summary({ windowHours: "-3" })).toThrow(BadRequestError);
    expect(() => summary({ windowHours: "abc" })).toThrow(BadRequestError);
  });

  // -------------------------------------------------------------------------
  // `since` — the parameter that lets a label say TODAY
  // -------------------------------------------------------------------------

  describe("?since", () => {
    /** Where a client's day actually starts, by the daemon's own maths. */
    function midnightIn(timeZone: string, nowMs = Date.now()): number {
      return zonedWallClockToMs(localDate(nowMs, timeZone), 0, timeZone);
    }

    function backdate(id: string, createdAt: number): void {
      getSqliteFrom(getDb()).run(
        /*sql*/ `UPDATE arrivals SET created_at = ? WHERE id = ?`,
        [createdAt, id],
      );
    }

    test("the default answer names itself a trailing window", () => {
      const out = summary();
      expect(out.bound).toBe("trailing_window");
      expect(out.windowHours).toBe(24);
      // Null, so nothing can print a zone it never resolved.
      expect(out.timeZone).toBeNull();
    });

    test("since=today bounds at the owner's midnight and says so", () => {
      const tz = "Europe/London";
      const out = summary({ since: "today", tz });

      expect(out.bound).toBe("local_day");
      expect(out.timeZone).toBe(tz);
      expect(out.since).toBe(midnightIn(tz, out.until));
      // The window is not a window any more, so no hours are offered for a
      // surface to print.
      expect(out.windowHours).toBeNull();
    });

    test("\"today\" is the person's day, not the daemon's", () => {
      // 25 hours apart, so these two zones are essentially never on the same
      // local date at the same instant. A daemon computing UTC midnight would
      // hand both of them the same bound.
      const early = summary({ since: "today", tz: "Pacific/Kiritimati" });
      const late = summary({ since: "today", tz: "Pacific/Niue" });

      expect(early.since).not.toBe(late.since);
      expect(early.timeZone).toBe("Pacific/Kiritimati");
      expect(late.timeZone).toBe("Pacific/Niue");
    });

    test("the bound is real: yesterday's arrival is not in today's count", () => {
      const tz = "Europe/London";
      const midnight = midnightIn(tz);

      const yesterday = seed();
      backdate(yesterday.id, midnight - 1_000);
      const today = seed();
      backdate(today.id, midnight + 1_000);

      expect(summary({ since: "today", tz }).arrived).toBe(1);
      // The same two rows are both inside a 48h trailing window — proof the
      // difference above is the day boundary and not the seeding.
      expect(summary({ windowHours: "48" }).arrived).toBe(2);
    });

    test("since wins over windowHours rather than being quietly widened", () => {
      const tz = "Europe/London";
      const out = summary({ since: "today", tz, windowHours: "168" });
      expect(out.bound).toBe("local_day");
      expect(out.since).toBe(midnightIn(tz, out.until));
    });

    test("an epoch instant is honoured but refuses to be called a day", () => {
      const at = Date.now() - 3 * 3_600_000;
      const out = summary({ since: String(at) });

      expect(out.bound).toBe("explicit");
      expect(out.since).toBe(at);
      // No calendar meaning, so no zone and no window — a surface has nothing
      // to overclaim with.
      expect(out.timeZone).toBeNull();
      expect(out.windowHours).toBeNull();
    });

    test("a bound in the future clamps to now instead of a negative window", () => {
      const out = summary({ since: String(Date.now() + 60 * 3_600_000) });
      expect(out.since).toBeLessThanOrEqual(out.until);
      expect(out.arrived).toBe(0);
    });

    test("rejects a nonsense since rather than falling back to a window", () => {
      expect(() => summary({ since: "yesterday" })).toThrow(BadRequestError);
      expect(() => summary({ since: "-1" })).toThrow(BadRequestError);
    });

    test("rejects a nonsense tz rather than silently using another day", () => {
      expect(() => summary({ since: "today", tz: "Mars/Olympus" })).toThrow(
        BadRequestError,
      );
    });
  });
});

describe("GET arrivals", () => {
  function list(queryParams?: Record<string, string>) {
    return route("listArrivals").handler({ queryParams }) as {
      arrivals: Array<Record<string, unknown>>;
    };
  }

  test("?disposition=filed backs 'Where it went', reasons included", () => {
    seed();
    seed({
      disposition: "surfaced",
      reason: "from Jane Doe, who is in your contacts",
      ruleId: "known_contact",
    });

    const filed = list({ disposition: "filed" }).arrivals;
    expect(filed).toHaveLength(1);
    expect(filed[0].reason).toBe("newsletter from Stripe");
    expect(filed[0].ruleId).toBe("list_mail");
    expect(filed[0].decidedBy).toBe("rule");

    expect(list().arrivals).toHaveLength(2);
  });

  test("rejects an unknown disposition", () => {
    expect(() => list({ disposition: "banished" })).toThrow(BadRequestError);
  });

  test("caps the page size", () => {
    for (let i = 0; i < 5; i++) seed();
    expect(list({ limit: "2" }).arrivals).toHaveLength(2);
    expect(list({ limit: "9999" }).arrivals).toHaveLength(5);
  });
});

describe("GET arrivals/:id", () => {
  test("returns the row behind a work item's arrivalId", () => {
    const arrival = seed();
    const out = route("getArrival").handler({
      pathParams: { id: arrival.id },
    }) as { arrival: { id: string; reason: string } };
    expect(out.arrival.id).toBe(arrival.id);
    expect(out.arrival.reason).toBe("newsletter from Stripe");
  });

  test("404s on an unknown id", () => {
    expect(() =>
      route("getArrival").handler({ pathParams: { id: "nope" } }),
    ).toThrow(NotFoundError);
  });
});

describe("POST arrivals/:id/reverse", () => {
  async function reverse(id: string) {
    return (await route("reverseArrivalFiling").handler({
      pathParams: { id },
    })) as {
      arrival: Record<string, unknown>;
      workItem: Record<string, unknown>;
    };
  }

  test("puts the arrival in the lane and keeps the original decision on record", async () => {
    const arrival = seed({ externalId: "msg-rev" });
    expect(listWorkItems()).toEqual([]);

    const out = await reverse(arrival.id);

    expect(out.arrival.disposition).toBe("surfaced");
    expect(out.arrival.reversedBy).toBe("user");
    expect(out.arrival.reversedAt).toBeGreaterThan(0);
    // The original decision survives — it is the correction signal.
    expect(out.arrival.reason).toBe("newsletter from Stripe");
    expect(out.arrival.ruleId).toBe("list_mail");

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].arrivalId).toBe(arrival.id);
    expect(items[0].sourceId).toBe("msg-rev");
    expect(items[0].autoRunEligibility).toBe("parked");
    expect(out.workItem.id).toBe(items[0].id);
  });

  test("409s rather than minting a duplicate for an already-surfaced arrival", async () => {
    const arrival = seed({ disposition: "surfaced", reason: "kept" });
    await expect(reverse(arrival.id)).rejects.toThrow(ConflictError);
    expect(listWorkItems()).toEqual([]);
  });

  test("404s on an unknown id", async () => {
    await expect(reverse("nope")).rejects.toThrow(NotFoundError);
  });

  test("restores the owner's original item when the filing archived one", async () => {
    // The retro run over the pre-gate backlog files items that already
    // existed: it archives them and links them, rather than never minting
    // them. Reversing must give the owner that row back — same id, same
    // history — not a fresh copy alongside an archived original.
    const task = createTask({ title: "This week's reads", template: "x" });
    const original = createWorkItem({
      taskId: task.id,
      title: "This week's reads",
      sourceType: "watcher:gmail",
      sourceId: "msg-retro",
    });
    updateWorkItem(original.id, { status: "archived" }, { actor: "test" });
    const arrival = seed({ externalId: "msg-retro", workItemId: original.id });

    const out = await reverse(arrival.id);

    expect(out.workItem.id).toBe(original.id);
    const items = listWorkItems();
    // One item, not two. Nothing was duplicated and nothing was lost.
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(original.id);
    expect(items[0].status).toBe("queued");
    expect(out.arrival.disposition).toBe("surfaced");
  });
});

describe("GET arrivals/corrections", () => {
  test("ranks the senders the owner keeps correcting", async () => {
    const a = seed({ senderAddress: "news@example.org" });
    const b = seed({ senderAddress: "news@example.org" });
    const c = seed({ senderAddress: "other@example.net" });
    for (const row of [a, b, c]) {
      await route("reverseArrivalFiling").handler({
        pathParams: { id: row.id },
      });
    }

    const out = route("listArrivalCorrections").handler({}) as {
      senders: Array<{ senderAddress: string; corrections: number }>;
    };
    expect(out.senders).toEqual([
      { senderAddress: "news@example.org", corrections: 2 },
      { senderAddress: "other@example.net", corrections: 1 },
    ]);
  });
});

describe("no delete route exists", () => {
  test("arrivals can never be removed through the API", () => {
    const destructive = ROUTES.filter((r) => r.method === "DELETE");
    expect(destructive).toEqual([]);
  });
});
