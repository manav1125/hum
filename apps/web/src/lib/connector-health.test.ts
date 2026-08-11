/**
 * Connector health presentation: the states F4 prepared, now wired to the
 * daemon's verified `health` object. The honesty invariants live here —
 * "working ✓" never renders without a real success signal, a missing health
 * object (older daemon) degrades to the plain "Linked" fallback, and the
 * meta line only mentions attention when something actually needs it.
 */

import { describe, expect, it } from "bun:test";

import {
  attentionCount,
  connectionStatusLine,
  connectionsMeta,
  hasUnknownConnections,
  healthStatus,
  relativeAge,
  unknownStatusNote,
} from "./connector-health";

const NOW = Date.parse("2026-07-21T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("healthStatus", () => {
  it("falls back to unknown when the daemon sends no health (old daemon)", () => {
    expect(healthStatus(undefined)).toBe("unknown");
  });
  it("passes the daemon verdict through", () => {
    expect(healthStatus({ status: "attention" })).toBe("attention");
    expect(healthStatus({ status: "ok" })).toBe("ok");
  });
});

describe("unknownStatusNote", () => {
  it("says 'not actively checked' when no liveness probe exists", () => {
    // The daemon schema's instruction for activelyChecked=false: render the
    // honesty copy, never a blank cell.
    expect(
      unknownStatusNote({ status: "unknown", activelyChecked: false }),
    ).toBe("not actively checked");
  });
  it("says 'not verified recently' when a check exists but told nothing", () => {
    expect(
      unknownStatusNote({ status: "unknown", activelyChecked: true }),
    ).toBe("not verified recently");
    expect(unknownStatusNote(undefined)).toBe("not verified recently");
  });
});

describe("connectionStatusLine", () => {
  it("a missing health object (old daemon) renders the plain Linked", () => {
    expect(connectionStatusLine(undefined, NOW)).toBe("Linked");
  });

  it("unknown says why there is no verdict instead of rendering nothing", () => {
    expect(
      connectionStatusLine({ status: "unknown", activelyChecked: false }, NOW),
    ).toBe("Linked · not actively checked");
    expect(
      connectionStatusLine({ status: "unknown", activelyChecked: true }, NOW),
    ).toBe("Linked · not verified recently");
    // A daemon that predates activelyChecked still gets an honest reason.
    expect(connectionStatusLine({ status: "unknown" }, NOW)).toBe(
      "Linked · not verified recently",
    );
  });

  it("attention renders Needs attention", () => {
    expect(
      connectionStatusLine(
        { status: "attention", lastError: "token_revoked" },
        NOW,
      ),
    ).toBe("Needs attention");
  });

  it("ok renders working ✓ with the real success age", () => {
    expect(
      connectionStatusLine({ status: "ok", lastSuccessAt: hoursAgo(2) }, NOW),
    ).toBe("Linked · working ✓ 2h ago");
  });

  it("NEVER claims working without a success timestamp", () => {
    expect(connectionStatusLine({ status: "ok" }, NOW)).toBe("Linked");
  });
});

describe("relativeAge", () => {
  it("formats minute/hour/day/week ages", () => {
    expect(relativeAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe(
      "just now",
    );
    expect(relativeAge(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe(
      "12m ago",
    );
    expect(relativeAge(hoursAgo(5), NOW)).toBe("5h ago");
    expect(relativeAge(hoursAgo(3 * 24), NOW)).toBe("3d ago");
    expect(relativeAge(hoursAgo(21 * 24), NOW)).toBe("3w ago");
  });
  it("returns null on garbage", () => {
    expect(relativeAge(undefined, NOW)).toBeNull();
    expect(relativeAge("not-a-date", NOW)).toBeNull();
  });
});

describe("attentionCount / hasUnknownConnections / connectionsMeta", () => {
  const apps = [
    { connected: true, health: { status: "attention" as const } },
    { connected: true, health: { status: "ok" as const } },
    { connected: true }, // old daemon shape → unknown
    { connected: false, health: { status: "attention" as const } }, // ignored
  ];

  it("counts attention among connected apps only", () => {
    expect(attentionCount(apps)).toBe(1);
  });

  it("flags unknown connections for the honesty footnote", () => {
    expect(hasUnknownConnections(apps)).toBe(true);
    expect(
      hasUnknownConnections([
        { connected: true, health: { status: "ok" as const } },
      ]),
    ).toBe(false);
  });

  it("builds the You-root meta line", () => {
    expect(connectionsMeta(8, 2)).toBe("8 linked · 2 need attention");
    expect(connectionsMeta(8, 1)).toBe("8 linked · 1 needs attention");
    expect(connectionsMeta(8, 0)).toBe("8 linked");
  });
});
