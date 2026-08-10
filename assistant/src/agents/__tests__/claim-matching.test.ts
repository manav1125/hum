/**
 * The matching engine's rules.
 *
 * Several are MUTATION CHECKS on decisions that would be easy to "simplify"
 * into a security or honesty bug — an empty manifest matching everything, an
 * exclusion losing to a broader claim, a trial inferring agreement. Each names
 * what it protects.
 */

import { describe, expect, test } from "bun:test";

import {
  type AgentClaim,
  claimMatches,
  domainOf,
  exclusionReason,
  type MatchableItem,
  matchIntake,
  tallyTrial,
} from "../claim-matching.js";

const item = (over: Partial<MatchableItem> = {}): MatchableItem => ({
  id: "i1",
  title: "Invoice 4471 attached",
  senderAddress: "billing@example.com",
  channel: "watcher:gmail",
  ...over,
});

describe("domainOf", () => {
  test("takes the part after the last @", () => {
    expect(domainOf("a@example.com")).toBe("example.com");
    // Quoted local parts can contain '@'; the LAST one is the separator.
    expect(domainOf('"odd@name"@example.com')).toBe("example.com");
  });

  test("no domain is null, not an empty string", () => {
    // An empty string would equal an empty configured domain and match.
    expect(domainOf("bare")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});

describe("a claim is conjunctive", () => {
  test("every stated condition must hold", () => {
    const claim: AgentClaim = {
      id: "c",
      senderDomains: ["example.com"],
      titleContains: ["invoice"],
    };
    expect(claimMatches(item(), claim)).not.toBeNull();
    // Right sender, wrong subject.
    expect(claimMatches(item({ title: "Lunch?" }), claim)).toBeNull();
    // Right subject, wrong sender.
    expect(
      claimMatches(item({ senderAddress: "a@example.org" }), claim),
    ).toBeNull();
  });

  test("unstated conditions are not asked, not wildcarded", () => {
    const claim: AgentClaim = { id: "c", titleContains: ["invoice"] };
    expect(claimMatches(item({ senderAddress: null }), claim)).not.toBeNull();
  });

  test("matching is case-insensitive on both sides", () => {
    const claim: AgentClaim = {
      id: "c",
      senderDomains: ["Example.COM"],
      titleContains: ["INVOICE"],
    };
    expect(
      // generic-examples:ignore-next-line — reason: the MIXED CASE is the subject of the assertion; a lowercase example.com cannot express it
      claimMatches(item({ senderAddress: "Billing@Example.COM" }), claim),
    ).not.toBeNull();
  });

  test("MUTATION CHECK: an empty claim matches NOTHING", () => {
    // The generous reading — "it hasn't said what it does, so it takes
    // everything" — is exactly how a specialist becomes a second generalist
    // with different branding, and how an installed agent silently acquires
    // the whole inbox.
    expect(claimMatches(item(), { id: "empty" })).toBeNull();
    expect(matchIntake([item()], [{ id: "empty" }])).toHaveLength(0);
  });
});

describe("exclusions win, always", () => {
  test("MUTATION CHECK: an exclusion vetoes a claim that otherwise matches", () => {
    // Prohibitions are the part the owner set most deliberately. They must not
    // be out-voted by a broader positive condition elsewhere in the manifest.
    const claims: AgentClaim[] = [{ id: "c", senderDomains: ["example.com"] }];
    expect(matchIntake([item()], claims)).toHaveLength(1);
    expect(
      matchIntake([item()], claims, {
        senderAddresses: ["billing@example.com"],
      }),
    ).toHaveLength(0);
  });

  test("excluding a domain excludes every address on it", () => {
    expect(
      exclusionReason(item(), { senderDomains: ["example.com"] }),
    ).toContain("excluded");
  });

  test("a title exclusion vetoes too", () => {
    expect(
      exclusionReason(item({ title: "Invoice — DRAFT" }), {
        titleContains: ["draft"],
      }),
    ).toContain("draft");
  });

  test("no exclusions configured vetoes nothing", () => {
    expect(exclusionReason(item(), undefined)).toBeNull();
    expect(exclusionReason(item(), {})).toBeNull();
  });
});

describe("the match explains itself", () => {
  test("every match carries the conditions that fired", () => {
    const [m] = matchIntake(
      [item()],
      [
        {
          id: "c",
          senderDomains: ["example.com"],
          titleContains: ["invoice"],
        },
      ],
    );
    expect(m!.because).toEqual([
      "from example.com",
      'title mentions "invoice"',
    ]);
  });

  test("first matching claim wins, so order is policy", () => {
    const matches = matchIntake(
      [item()],
      [
        { id: "specific", titleContains: ["invoice 4471"] },
        { id: "broad", titleContains: ["invoice"] },
      ],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.claimId).toBe("specific");
  });
});

describe("the trial tally claims nothing about the owner", () => {
  test("counts claimed and not-claimed, and nothing else", () => {
    const items = [item({ id: "a" }), item({ id: "b", title: "Lunch?" })];
    const matches = matchIntake(items, [
      { id: "c", titleContains: ["invoice"] },
    ]);
    expect(tallyTrial(items, matches)).toEqual({ claimed: 1, notClaimed: 1 });
  });

  test("MUTATION CHECK: there is no 'would have agreed' number", () => {
    // Design v39's correction: every trial number must be an act the owner
    // performed, never an inference, and absence of objection is never scored
    // as approval. If a field like `wouldAgree` ever appears here, the trial
    // has started scoring itself on the owner's inattention.
    const items = [item()];
    const tally = tallyTrial(
      items,
      matchIntake(items, [{ id: "c", titleContains: ["invoice"] }]),
    );
    expect(Object.keys(tally).sort()).toEqual(["claimed", "notClaimed"]);
  });

  test("an item caught by two claims is counted once", () => {
    const items = [item()];
    const matches = matchIntake(items, [
      { id: "c1", titleContains: ["invoice"] },
      { id: "c2", senderDomains: ["example.com"] },
    ]);
    expect(tallyTrial(items, matches).claimed).toBe(1);
  });
});

describe("replaying an empty window is not an error", () => {
  test("no intake yields no matches and a zero tally", () => {
    expect(matchIntake([], [{ id: "c", titleContains: ["x"] }])).toEqual([]);
    expect(tallyTrial([], [])).toEqual({ claimed: 0, notClaimed: 0 });
  });
});
