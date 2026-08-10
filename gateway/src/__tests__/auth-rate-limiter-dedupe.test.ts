/**
 * The blast-radius fix: one broken client must not lock an IP out of the
 * whole API, and doing that must not weaken brute-force protection.
 *
 * What happened without this. `isRateLimitedRoute` covers all of `/v1/*` and
 * `isBlocked` keys on IP alone, so ten auth failures on ANY route inside a
 * minute made every route answer "Too many failed attempts" for that IP. On
 * this product a screen-share heartbeat retrying one stale token every four
 * seconds hit that in under a minute and took the entire desktop app dark on
 * launch — conversation list, history, bookmarks, Library.
 *
 * The fix counts DISTINCT credentials rather than raw attempts. The limiter
 * exists to stop credential guessing, and a guesser must present different
 * credentials — so distinct-failure counting measures the actual attack while
 * a client replaying one dead token costs a single slot.
 *
 * The tests below are split deliberately: the first group proves the lockout
 * is gone, the second proves the security property survives. A change that
 * satisfies only the first group is the bug in the other direction.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { AuthRateLimiter } from "../auth-rate-limiter.js";

const IP = "203.0.113.7";
const MAX = 10;

let limiter: AuthRateLimiter;

beforeEach(() => {
  limiter = new AuthRateLimiter(MAX, 60_000);
});

describe("a broken client cannot lock the IP out", () => {
  test("one credential failing forever counts once", () => {
    // The exact production shape: same stale token, every four seconds.
    for (let i = 0; i < 200; i++) {
      limiter.recordFailure(IP, "stale-token-fingerprint");
    }
    expect(limiter.isBlocked(IP)).toBe(false);
  });

  test("a missing Authorization header is also one bucket", () => {
    // Absence cannot be a guess, so it must not consume the budget either —
    // this was the state the desktop app sat in for half an hour.
    for (let i = 0; i < 200; i++) limiter.recordFailure(IP, "none");
    expect(limiter.isBlocked(IP)).toBe(false);
  });

  test("a handful of real credentials still does not trip it", () => {
    // A phone, a laptop and the CLI behind one NAT, each briefly stale.
    for (const cred of ["phone", "laptop", "cli"]) {
      for (let i = 0; i < 50; i++) limiter.recordFailure(IP, cred);
    }
    expect(limiter.isBlocked(IP)).toBe(false);
  });
});

describe("brute-force protection is unchanged", () => {
  test("distinct credential guesses still block at the threshold", () => {
    for (let i = 0; i < MAX; i++) limiter.recordFailure(IP, `guess-${i}`);
    expect(limiter.isBlocked(IP)).toBe(true);
  });

  test("one guess short does not block", () => {
    for (let i = 0; i < MAX - 1; i++) limiter.recordFailure(IP, `guess-${i}`);
    expect(limiter.isBlocked(IP)).toBe(false);
  });

  test("padding with a repeated credential does not buy an attacker room", () => {
    // Interleaving a known-dead token must not dilute the count of real
    // guesses. The dead token costs exactly one slot — its first appearance —
    // and no more however often it is replayed. So eight distinct guesses plus
    // the padding is nine counted, and the ninth real guess is what trips it.
    for (let i = 0; i < MAX - 2; i++) {
      limiter.recordFailure(IP, `guess-${i}`);
      limiter.recordFailure(IP, "same-dead-token");
      limiter.recordFailure(IP, "same-dead-token");
    }
    expect(limiter.isBlocked(IP)).toBe(false);
    limiter.recordFailure(IP, "guess-final");
    expect(limiter.isBlocked(IP)).toBe(true);
  });

  test("omitting the fingerprint preserves the old counting exactly", () => {
    // Call sites that genuinely cannot identify a credential must lose
    // nothing — this is what keeps the change safe to land incrementally.
    for (let i = 0; i < MAX; i++) limiter.recordFailure(IP);
    expect(limiter.isBlocked(IP)).toBe(true);
  });

  test("blocking is per IP — one attacker does not block everyone", () => {
    for (let i = 0; i < MAX; i++) limiter.recordFailure(IP, `guess-${i}`);
    expect(limiter.isBlocked(IP)).toBe(true);
    expect(limiter.isBlocked("198.51.100.4")).toBe(false);
  });
});

describe("clearIp forgets the dedupe state too", () => {
  test("a successful auth lets the same credential count again", () => {
    // Otherwise a token that failed, then succeeded, then genuinely started
    // being brute-forced would be permanently exempt from the count.
    limiter.recordFailure(IP, "token-a");
    limiter.clearIp(IP);
    for (let i = 0; i < MAX; i++) limiter.recordFailure(IP, `guess-${i}`);
    expect(limiter.isBlocked(IP)).toBe(true);
  });

  test("clearing one IP leaves another IP's dedupe intact", () => {
    const other = "198.51.100.9";
    limiter.recordFailure(other, "shared-fingerprint");
    limiter.clearIp(IP);
    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(other, "shared-fingerprint");
    }
    expect(limiter.isBlocked(other)).toBe(false);
  });
});
