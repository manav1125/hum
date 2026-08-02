/**
 * The account line's honesty rules.
 *
 * `👤 Manav · Autonomous · $4.10` is three separate reads and the interesting
 * question about each is what it does when it fails. The name must never be
 * invented; the tier and the spend must never be defaulted.
 *
 * Pure functions only — the hook itself needs a query client and is exercised
 * through `preferences-menu.test.tsx`.
 */

import { describe, expect, test } from "bun:test";

import {
  formatSpend,
  ownerLineText,
  resolveOwnerName,
  WORKSPACE_MODE_LABEL,
} from "./use-owner-line";

describe("the name comes from real state, or admits it does not", () => {
  test("a first name wins", () => {
    expect(
      resolveOwnerName({
        firstName: "Manav",
        username: "mg",
        email: "manav@example.com",
      }),
    ).toBe("Manav");
  });

  test("an EMPTY first name is not a name — the platform sends '' not null", () => {
    // `toAuthUser` maps a missing `first_name` to `""`, so `firstName ?? …`
    // never fires. This is the exact shape that would have shipped a blank row.
    expect(
      resolveOwnerName({ firstName: "", username: "mg", email: null }),
    ).toBe("mg");
    expect(
      resolveOwnerName({ firstName: "   ", username: "mg", email: null }),
    ).toBe("mg");
  });

  test("the email's local part, not the whole address", () => {
    // The row is an identity, not a mailto — but it is still the user's own
    // string rather than something plausible-sounding.
    expect(
      resolveOwnerName({
        firstName: "",
        username: null,
        email: "manav@example.com",
      }),
    ).toBe("manav");
  });

  test("with nothing readable it says 'You' — never a made-up name", () => {
    expect(resolveOwnerName(null)).toBe("You");
    expect(
      resolveOwnerName({ firstName: "", username: null, email: null }),
    ).toBe("You");
  });
});

describe("a segment that cannot be read is dropped, not defaulted", () => {
  test("all three read", () => {
    expect(
      ownerLineText({ name: "Manav", tier: "Autonomous", spend: "$4.10" }),
    ).toBe("Manav · Autonomous · $4.10");
  });

  test("an unread tier does not become a guess", () => {
    // Defaulting to "Assist" would misreport what Cue may do unattended, which
    // is the one number on this row with a safety meaning.
    expect(ownerLineText({ name: "Manav", tier: null, spend: "$4.10" })).toBe(
      "Manav · $4.10",
    );
  });

  test("unread spend does not become $0.00", () => {
    // "Never a fake number": $0.00 and "I could not ask" look identical and
    // only one of them is safe to believe.
    expect(
      ownerLineText({ name: "Manav", tier: "Autonomous", spend: null }),
    ).toBe("Manav · Autonomous");
  });

  test("the name alone is a valid line", () => {
    expect(ownerLineText({ name: "You", tier: null, spend: null })).toBe("You");
  });
});

describe("presentation", () => {
  test("spend always carries two decimals so the row does not jitter", () => {
    expect(formatSpend(4.1)).toBe("$4.10");
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(1234.567)).toBe("$1234.57");
  });

  test("no raw enums — every workspace mode has a word", () => {
    expect(WORKSPACE_MODE_LABEL.observe).toBe("Observe");
    expect(WORKSPACE_MODE_LABEL.assist).toBe("Assist");
    expect(WORKSPACE_MODE_LABEL.autonomous).toBe("Autonomous");
  });
});
