/**
 * M8's default, pinned.
 *
 * This is not a layout test. A background run on this instance emailed a
 * partner with nobody's approval; the fix closed four bypass ranks and this is
 * the fifth — the default itself. So the assertions here are deliberately
 * blunt and deliberately redundant: the constant, the derived policy map, and
 * the read-back all say `send` is off, because each of those is a separate way
 * for it to come back on.
 *
 * MUTATION CHECK (run by hand, and it does go red):
 *   flip `send_spend: false` → `true` in DEFAULT_CONSENT_SCOPES and
 *   "send and spend is OFF by default" fails, as does "…and the policy map
 *   says so to the daemon".
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  autonomyPoliciesForScopes,
  clearPendingPolicies,
  CONSENT_SCOPE_IDS,
  DEFAULT_CONSENT_SCOPES,
  persistConsentScopes,
  readConsentScopes,
  readPendingPolicies,
  type ConsentScopes,
} from "./consent-scopes";

beforeEach(() => {
  localStorage.clear();
  clearPendingPolicies();
});

describe("the three cards, and only three", () => {
  test("exactly the three design named", () => {
    expect([...CONSENT_SCOPE_IDS]).toEqual([
      "read_organise",
      "draft_prepare",
      "send_spend",
    ]);
    expect(Object.keys(DEFAULT_CONSENT_SCOPES).sort()).toEqual([
      "draft_prepare",
      "read_organise",
      "send_spend",
    ]);
  });

  test("read-and-organise and draft-and-prepare are on", () => {
    expect(DEFAULT_CONSENT_SCOPES.read_organise).toBe(true);
    expect(DEFAULT_CONSENT_SCOPES.draft_prepare).toBe(true);
  });

  test("send and spend is OFF by default", () => {
    expect(DEFAULT_CONSENT_SCOPES.send_spend).toBe(false);
  });

  test("the defaults cannot be mutated in place by a caller", () => {
    const copy = DEFAULT_CONSENT_SCOPES as ConsentScopes;
    try {
      copy.send_spend = true;
    } catch {
      /* frozen objects throw in strict mode — either way it must not change */
    }
    expect(DEFAULT_CONSENT_SCOPES.send_spend).toBe(false);
  });
});

describe("…and the policy map says so to the daemon", () => {
  test("off writes send: ask EXPLICITLY — the gateway's own default is auto", () => {
    const policies = autonomyPoliciesForScopes(DEFAULT_CONSENT_SCOPES);
    expect(policies.send).toBe("ask");
    expect(policies.money).toBe("ask");
  });

  test("every category is named, so nothing inherits a stale value", () => {
    const policies = autonomyPoliciesForScopes(DEFAULT_CONSENT_SCOPES);
    expect(Object.keys(policies).sort()).toEqual([
      "delete",
      "draft",
      "money",
      "other",
      "research",
      "send",
    ]);
  });

  test("off means ASK, never NEVER — the card promises Cue stops and asks", () => {
    // A silent refusal is a different behaviour from the one on the card, and
    // the user was not told about it.
    expect(autonomyPoliciesForScopes(DEFAULT_CONSENT_SCOPES).send).not.toBe(
      "never",
    );
  });

  test("turning it on is the only way it becomes auto", () => {
    const on = autonomyPoliciesForScopes({
      ...DEFAULT_CONSENT_SCOPES,
      send_spend: true,
    });
    expect(on.send).toBe("auto");
    // Money still asks even when send-and-spend is on: spending is the half of
    // that card with no undo, and design's copy scopes the switch to "leaves
    // or costs money … stop and ask".
    expect(on.money).toBe("ask");
  });

  test("deletion is never granted by any of the three cards", () => {
    for (const send of [false, true]) {
      for (const draft of [false, true]) {
        expect(
          autonomyPoliciesForScopes({
            read_organise: true,
            draft_prepare: draft,
            send_spend: send,
          }).delete,
        ).toBe("ask");
      }
    }
  });
});

describe("persistence errs closed", () => {
  test("a round trip preserves all three answers", () => {
    persistConsentScopes("u1", {
      read_organise: true,
      draft_prepare: false,
      send_spend: true,
    });
    expect(readConsentScopes("u1")).toEqual({
      read_organise: true,
      draft_prepare: false,
      send_spend: true,
    });
  });

  test("a device that has never answered reads the safe defaults", () => {
    expect(readConsentScopes("nobody").send_spend).toBe(false);
  });

  test("answers are per user — one user's yes is not another's", () => {
    persistConsentScopes("u1", { ...DEFAULT_CONSENT_SCOPES, send_spend: true });
    expect(readConsentScopes("u1").send_spend).toBe(true);
    expect(readConsentScopes("u2").send_spend).toBe(false);
  });

  test("no user id writes nothing and reads the defaults", () => {
    persistConsentScopes(null, { ...DEFAULT_CONSENT_SCOPES, send_spend: true });
    expect(readConsentScopes(null).send_spend).toBe(false);
  });
});

describe("an unreachable daemon parks the answer rather than losing it", () => {
  test("no assistant id parks the map", async () => {
    const { applyConsentScopes } = await import("./consent-scopes");
    const applied = await applyConsentScopes(null, DEFAULT_CONSENT_SCOPES);
    expect(applied).toBe(false);
    // The parked map is the one holding send: "ask". Dropping it would restore
    // the gateway default silently.
    expect(readPendingPolicies()?.send).toBe("ask");
  });
});
