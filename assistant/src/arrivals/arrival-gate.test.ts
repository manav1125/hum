/**
 * Unit tests for the relevance gate's pure layers: the deterministic header
 * rules, the safety floor, the judge's prompt/response handling, and the
 * single choke point where the floor overrides a file decision.
 *
 * The end-to-end behaviour (real intake, real database rows) is covered in
 * `watcher/__tests__/watcher-intake-relevance.test.ts` — a previous fix in
 * this repo passed its tests while being completely broken because the test
 * exercised a helper rather than the code production runs, so these unit
 * tests are deliberately the *supplement*, not the proof.
 */
import { describe, expect, test } from "bun:test";

import {
  applyBulkRules,
  applySafetyFloor,
  type ArrivalDecision,
  buildJudgePrompt,
  decideOne,
  type FloorContext,
  mentionsName,
  parseJudgeResponse,
  senderLabel,
} from "./arrival-gate.js";
import {
  type ArrivalPayload,
  type ArrivalSignals,
  buildArrivalSignals,
  parseAddress,
  parseAddressList,
  parseDisplayName,
} from "./arrival-signals.js";

function signals(payload: ArrivalPayload, title = "A subject"): ArrivalSignals {
  return buildArrivalSignals({
    channel: "watcher:gmail",
    externalId: "msg-1",
    title,
    summary: "summary text",
    payloadJson: JSON.stringify(payload),
  });
}

const emptyFloor: FloorContext = {
  lookupContact: () => null,
  namedWork: [],
};

describe("address parsing", () => {
  test("pulls the address out of a display-name form", () => {
    expect(parseAddress('"Jane Doe" <Jane@Example.com>')).toBe(
      "jane@example.com",
    );
    expect(parseDisplayName('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
  });

  test("accepts a bare address and rejects non-addresses", () => {
    expect(parseAddress("jane@example.com")).toBe("jane@example.com");
    expect(parseAddress("Jane Doe")).toBeNull();
    expect(parseAddress("")).toBeNull();
    expect(parseAddress(undefined)).toBeNull();
    expect(parseDisplayName("jane@example.com")).toBeNull();
  });

  test("splits an address list", () => {
    expect(
      parseAddressList("user@example.com, 'Bob' <bob@example.org>, garbage"),
    ).toEqual(["user@example.com", "bob@example.org"]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("signal normalisation", () => {
  test("an unreadable payload yields no signals rather than throwing", () => {
    const s = buildArrivalSignals({
      channel: "watcher:gmail",
      externalId: "x",
      title: "t",
      summary: "s",
      payloadJson: "{not json",
    });
    expect(s.isMessageShaped).toBe(false);
    expect(s.senderAddress).toBeNull();
    expect(s.hasListHeaders).toBe(false);
  });

  test("'Auto-Submitted: no' is a human marker, not a machine one", () => {
    expect(
      signals({ from: "a@example.com", autoSubmitted: "no" }).autoSubmitted,
    ).toBe(null);
    expect(
      signals({ from: "a@example.com", autoSubmitted: "auto-generated" })
        .autoSubmitted,
    ).toBe("auto-generated");
  });

  test("unknown thread participation stays undefined, never false", () => {
    expect(
      signals({ from: "a@example.com" }).userParticipatedInThread,
    ).toBeUndefined();
    expect(
      signals({ from: "a@example.com", userParticipatedInThread: false })
        .userParticipatedInThread,
    ).toBe(false);
  });
});

describe("deterministic bulk rules", () => {
  test("List-Unsubscribe files as a newsletter, named by the sender", () => {
    const hit = applyBulkRules(
      signals({
        from: "Stripe <receipts@example.org>",
        listUnsubscribe: "<https://stripe.com/unsub>",
      }),
    );
    expect(hit).toEqual({
      ruleId: "list_mail",
      reason: "newsletter from Stripe",
    });
  });

  test("List-Id alone is enough", () => {
    expect(
      applyBulkRules(
        signals({ from: "x@example.com", listId: "<eng.lists.y.com>" }),
      )?.ruleId,
    ).toBe("list_mail");
  });

  test("Precedence: bulk / list / junk all file", () => {
    for (const value of ["bulk", "list", "junk", "BULK"]) {
      expect(
        applyBulkRules(signals({ from: "x@example.com", precedence: value }))
          ?.ruleId,
      ).toBe("precedence_bulk");
    }
  });

  test("Auto-Submitted marks machine mail", () => {
    expect(
      applyBulkRules(
        signals({ from: "ci@example.net", autoSubmitted: "auto-generated" }),
      ),
    ).toEqual({
      ruleId: "auto_submitted",
      reason: "automated notification from example.net",
    });
  });

  test("ordinary mail matches no rule — the middle belongs to the model", () => {
    expect(applyBulkRules(signals({ from: "jane@example.com" }))).toBeNull();
  });

  test("a non-message arrival is never rule-filed", () => {
    expect(applyBulkRules(signals({ precedence: "bulk" }))).toBeNull();
  });

  test("the sender label falls back to domain, then to a placeholder", () => {
    expect(senderLabel(signals({ from: "a@example.org" }))).toBe("example.org");
    expect(senderLabel(signals({}))).toBe("an unknown sender");
  });
});

describe("name mention matching", () => {
  test("matches on word boundaries only", () => {
    expect(mentionsName("Re: the Orbit launch plan", "Orbit")).toBe(true);
    expect(mentionsName("reorbiting the satellite", "Orbit")).toBe(false);
    expect(mentionsName("ORBIT is live", "orbit")).toBe(true);
  });

  test("ignores names too short to be meaningful", () => {
    expect(mentionsName("we shipped Q3", "Q3")).toBe(false);
  });

  test("treats a name with regex metacharacters as literal text", () => {
    expect(mentionsName("moving to C++ (v2) next week", "C++ (v2)")).toBe(true);
    expect(mentionsName("nothing here", "C++ (v2)")).toBe(false);
  });
});

describe("the safety floor", () => {
  test("a known contact surfaces, named in the reason", () => {
    const hit = applySafetyFloor(signals({ from: "jane@example.com" }), {
      ...emptyFloor,
      lookupContact: (a) => (a === "jane@example.com" ? "Jane Doe" : null),
    });
    expect(hit).toEqual({
      ruleId: "known_contact",
      reason: "from Jane Doe, who is in your contacts",
    });
  });

  test("a known contact surfaces even when the mail looks like bulk", () => {
    // The floor is a floor: it outranks the header rules too, because a false
    // "filed" on a real person is the failure this exists to prevent.
    const hit = applySafetyFloor(
      signals({
        from: "jane@example.com",
        listUnsubscribe: "<https://x/unsub>",
      }),
      { ...emptyFloor, lookupContact: () => "Jane Doe" },
    );
    expect(hit?.ruleId).toBe("known_contact");
  });

  test("a reply in a thread the owner is part of surfaces", () => {
    const hit = applySafetyFloor(
      signals({
        from: "someone@example.net",
        inReplyTo: "<abc@x>",
        userParticipatedInThread: true,
      }),
      emptyFloor,
    );
    expect(hit).toEqual({
      ruleId: "thread_participant",
      reason: "a reply in a thread you're part of",
    });
  });

  test("unknown thread participation does NOT fire the floor", () => {
    const hit = applySafetyFloor(
      signals({ from: "someone@example.net", inReplyTo: "<abc@x>" }),
      emptyFloor,
    );
    expect(hit).toBeNull();
  });

  test("a named mission or project surfaces", () => {
    const hit = applySafetyFloor(
      signals({ from: "x@example.com" }, "Notes on the Orbit launch"),
      { ...emptyFloor, namedWork: [{ kind: "mission", name: "Orbit launch" }] },
    );
    expect(hit).toEqual({
      ruleId: "named_work",
      reason: 'mentions your mission "Orbit launch"',
    });
  });

  test("a direct To: from a human surfaces", () => {
    const hit = applySafetyFloor(
      signals({ from: "x@example.com", toMe: true }),
      emptyFloor,
    );
    expect(hit?.ruleId).toBe("direct_human");
  });

  test("being on the To: line of a mailing list is not a direct human", () => {
    // Lists and machine mail routinely address the owner directly, so the
    // direct-recipient rule only counts once bulk headers are ruled out.
    for (const payload of [
      { from: "x@example.com", toMe: true, listId: "<l.y.com>" },
      { from: "x@example.com", toMe: true, precedence: "bulk" },
      { from: "x@example.com", toMe: true, autoSubmitted: "auto-generated" },
    ]) {
      expect(applySafetyFloor(signals(payload), emptyFloor)).toBeNull();
    }
  });

  test("being merely cc'd is not enough", () => {
    expect(
      applySafetyFloor(
        signals({ from: "x@example.com", ccMe: true }),
        emptyFloor,
      ),
    ).toBeNull();
  });
});

describe("the choke point", () => {
  const filed: ArrivalDecision = {
    disposition: "filed",
    reason: "newsletter from Stripe",
    decidedBy: "model",
    ruleId: null,
    confidence: 0.95,
  };

  test("a floor hit overrides a file decision and says why", () => {
    const out = decideOne(filed, {
      ruleId: "known_contact",
      reason: "from Jane Doe, who is in your contacts",
    });
    expect(out).toEqual({
      disposition: "surfaced",
      reason: "from Jane Doe, who is in your contacts",
      decidedBy: "floor",
      ruleId: "known_contact",
      confidence: null,
    });
  });

  test("with no floor hit the proposal stands untouched", () => {
    expect(decideOne(filed, null)).toEqual(filed);
  });

  test("a floor hit never disturbs an already-surfaced decision", () => {
    const kept: ArrivalDecision = {
      disposition: "surfaced",
      reason: "Jane asking about the contract",
      decidedBy: "model",
      ruleId: null,
      confidence: 0.4,
    };
    expect(
      decideOne(kept, { ruleId: "direct_human", reason: "whatever" }),
    ).toEqual(kept);
  });
});

describe("the judge's wire format", () => {
  test("the prompt names every id and tells the model to keep when unsure", () => {
    const prompt = buildJudgePrompt([
      signals(
        { from: "Jane <jane@example.com>", toMe: true },
        "Contract question",
      ),
    ]);
    expect(prompt).toContain("id: msg-1");
    expect(prompt).toContain("Contract question");
    expect(prompt).toContain("direct to you");
    expect(prompt).toMatch(/not sure, KEEP it/);
  });

  test("parses verdicts, clamps confidence, drops unknown ids", () => {
    const out = parseJudgeResponse(
      `noise [{"id":"a","keep":false,"reason":"newsletter from Stripe","confidence":2},
        {"id":"ghost","keep":false,"reason":"x","confidence":1},
        {"id":"a","keep":true,"reason":"dupe","confidence":1}]`,
      new Set(["a"]),
    );
    expect(out).toEqual([
      {
        externalId: "a",
        keep: false,
        reason: "newsletter from Stripe",
        confidence: 1,
      },
    ]);
  });

  test("anything that is not literally false reads as keep", () => {
    const out = parseJudgeResponse(
      '[{"id":"a","reason":"unclear","confidence":0.1}]',
      new Set(["a"]),
    );
    expect(out?.[0].keep).toBe(true);
  });

  test("unparseable output returns null so the caller fails open", () => {
    expect(parseJudgeResponse("I refuse", new Set(["a"]))).toBeNull();
    expect(parseJudgeResponse("[oops", new Set(["a"]))).toBeNull();
    expect(parseJudgeResponse('{"id":"a"}', new Set(["a"]))).toBeNull();
  });

  test("a verdict with no reason still carries a sentence, never a bare score", () => {
    const out = parseJudgeResponse(
      '[{"id":"a","keep":false,"confidence":0.9}]',
      new Set(["a"]),
    );
    expect(out?.[0].reason).toBeTruthy();
    expect(typeof out?.[0].reason).toBe("string");
  });
});
