/**
 * Unit tests for the waiting-state derivation. Pure function over three
 * fields plus a clock — no DB, no fixtures.
 */
import { describe, expect, test } from "bun:test";

import {
  deriveWaitingState,
  GOING_COLD_AFTER_MS,
} from "./work-item-waiting.js";

const NOW = 1_785_000_000_000;

function item(overrides: {
  status?: string;
  waitingOn?: string | null;
  lastChasedAt?: number | null;
}) {
  return {
    status: "queued",
    waitingOn: null,
    lastChasedAt: null,
    ...overrides,
  };
}

describe("deriveWaitingState", () => {
  test("an item nobody is waiting on has no waiting state", () => {
    // The overwhelmingly common case: null must not be read as a wait of any
    // kind, or every ordinary queued item would claim to be blocked.
    expect(deriveWaitingState(item({}), NOW)).toBeNull();
    expect(
      deriveWaitingState(item({ lastChasedAt: NOW - 1000 }), NOW),
    ).toBeNull();
  });

  test('waiting but never chased reads "on time"', () => {
    expect(deriveWaitingState(item({ waitingOn: "contact-rachel" }), NOW)).toBe(
      "on_time",
    );
  });

  test("age alone never turns an unchased item cold", () => {
    // There is no waiting-since clock in these columns, so an item you only
    // started waiting on this morning must not render amber on first paint.
    // Silence is only measured from a chase that actually went out.
    expect(
      deriveWaitingState(
        item({ waitingOn: "contact-rachel" }),
        NOW + 365 * 86_400_000,
      ),
    ).toBe("on_time");
  });

  test('a recent chase reads "already chased", not another nudge', () => {
    expect(
      deriveWaitingState(
        item({
          waitingOn: "contact-rachel",
          lastChasedAt: NOW - GOING_COLD_AFTER_MS + 1,
        }),
        NOW,
      ),
    ).toBe("already_chased");
  });

  test("silence past the chase window reads going cold", () => {
    expect(
      deriveWaitingState(
        item({
          waitingOn: "contact-rachel",
          lastChasedAt: NOW - GOING_COLD_AFTER_MS,
        }),
        NOW,
      ),
    ).toBe("going_cold");
    expect(
      deriveWaitingState(
        item({
          waitingOn: "contact-rachel",
          lastChasedAt: NOW - 10 * 86_400_000,
        }),
        NOW,
      ),
    ).toBe("going_cold");
  });

  test("a finished item is never waiting, however cold the last chase", () => {
    for (const status of ["done", "cancelled", "archived", "failed"]) {
      expect(
        deriveWaitingState(
          item({
            status,
            waitingOn: "contact-rachel",
            lastChasedAt: NOW - 30 * 86_400_000,
          }),
          NOW,
        ),
      ).toBeNull();
    }
  });

  test("live statuses other than queued still derive", () => {
    for (const status of ["running", "awaiting_review"]) {
      expect(
        deriveWaitingState(item({ status, waitingOn: "contact-rachel" }), NOW),
      ).toBe("on_time");
    }
  });

  test("the chase window is five days", () => {
    // The handoff's own worked example of the standing rule this becomes
    // ("always chase after 5 days"). Pinned so a client cannot silently drift
    // to a different boundary than the one the copy promises.
    expect(GOING_COLD_AFTER_MS).toBe(5 * 24 * 60 * 60 * 1000);
  });
});
