/**
 * The manifest's rules.
 *
 * The mutation checks here guard decisions that would each be a plausible
 * "simplification" and each one a way for an agent to acquire authority it was
 * never granted.
 */

import { describe, expect, test } from "bun:test";

import {
  type AgentManifest,
  autonomyRank,
  GENERALIST_ID,
  generalistManifest,
  skillsSentence,
  THIRD_PARTY_MAX_ASK,
  validateManifest,
} from "../agent-manifest.js";
import { matchIntake } from "../claim-matching.js";

const manifest = (over: Partial<AgentManifest> = {}): AgentManifest => ({
  id: "invoices",
  name: "Invoices",
  claimsSentence: "Invoices and payment chasers from suppliers.",
  claims: [{ id: "c1", titleContains: ["invoice"] }],
  prohibitions: {},
  handsBackAlways: [],
  asks: {
    scopes: ["gmail.read"],
    capability: "everyday",
    weeklyBudgetCents: 2000,
    autonomy: "acts_tells_you",
  },
  provenance: "cue",
  skills: ["a", "b"],
  ...over,
});

describe("a manifest must say what it takes", () => {
  test("a valid one has no problems", () => {
    expect(validateManifest(manifest())).toEqual([]);
  });

  test("no claims is an error", () => {
    expect(validateManifest(manifest({ claims: [] }))).toContain("no_claims");
  });

  test("MUTATION CHECK: a claim with no conditions is caught here", () => {
    // The engine treats an empty claim as matching nothing, which is the safe
    // behaviour — but silently. An owner who wrote one reasonably expects it
    // to do something, so it must surface as a problem rather than as an
    // agent that mysteriously never takes anything.
    expect(validateManifest(manifest({ claims: [{ id: "c" }] }))).toContain(
      "empty_claim",
    );
  });

  test("every problem is reported, not just the first", () => {
    const bad = manifest({
      name: "  ",
      claims: [],
      claimsSentence: "",
      asks: { ...manifest().asks, weeklyBudgetCents: -1 },
    });
    const problems = validateManifest(bad);
    expect(problems).toContain("no_name");
    expect(problems).toContain("no_claims");
    expect(problems).toContain("no_claims_sentence");
    expect(problems).toContain("negative_budget");
  });
});

describe("the generalist is the one exception, by id", () => {
  test("it validates despite having no claims", () => {
    expect(validateManifest(generalistManifest())).toEqual([]);
  });

  test("MUTATION CHECK: the exemption is by ID, not by shape", () => {
    // If the exemption keyed off "has no claims" instead, every malformed
    // agent would silently inherit the generalist's licence to own anything.
    const impostor = manifest({ id: "not-cue", claims: [] });
    expect(validateManifest(impostor)).toContain("no_claims");
  });

  test("MUTATION CHECK: the generalist is never selected BY MATCHING", () => {
    // It is the fallback when matching selects nobody, not a competitor in the
    // match. Its empty claim list must therefore match nothing — the two rules
    // have to agree or work gets double-owned.
    const g = generalistManifest();
    const matched = matchIntake(
      [{ id: "i", title: "anything at all", senderAddress: "a@example.com" }],
      g.claims,
      g.prohibitions,
    );
    expect(matched).toHaveLength(0);
    expect(g.id).toBe(GENERALIST_ID);
  });
});

describe("a third party cannot ask for full autonomy on day one", () => {
  test("asking above the ceiling is a problem", () => {
    const m = manifest({
      provenance: "third_party",
      asks: { ...manifest().asks, autonomy: "acts_in_budget" },
    });
    expect(validateManifest(m)).toContain("third_party_over_autonomy");
  });

  test("at the ceiling is fine", () => {
    const m = manifest({
      provenance: "third_party",
      asks: { ...manifest().asks, autonomy: THIRD_PARTY_MAX_ASK },
    });
    expect(validateManifest(m)).toEqual([]);
  });

  test("MUTATION CHECK: the ceiling applies to third parties only", () => {
    // Cue's own agents and the owner's own creations are not strangers.
    for (const provenance of ["cue", "owner"] as const) {
      const m = manifest({
        provenance,
        asks: { ...manifest().asks, autonomy: "acts_in_budget" },
      });
      expect(validateManifest(m)).toEqual([]);
    }
  });

  test("the ladder is ordered, so 'higher' means something", () => {
    expect(autonomyRank("suggests")).toBeLessThan(
      autonomyRank("acts_tells_you"),
    );
    expect(autonomyRank("acts_tells_you")).toBeLessThan(
      autonomyRank("acts_in_budget"),
    );
  });
});

describe("what a manifest deliberately cannot express", () => {
  test("there is no provider field", () => {
    // The owner ruled provider names out of the product. An agent declares a
    // capability tier and nothing about who serves it — otherwise agent
    // quality reads as model choice rather than harness quality.
    const keys = Object.keys(manifest().asks);
    expect(keys).not.toContain("provider");
    expect(keys).not.toContain("model");
    expect(keys).toContain("capability");
  });

  test("asks are requests — nothing here is a grant", () => {
    // What the agent GETS lives with the owner's grant. If a manifest could
    // carry granted authority, re-reading a third-party manifest would widen
    // its own permissions.
    const keys = Object.keys(manifest());
    expect(keys).not.toContain("granted");
    expect(keys).not.toContain("grantedScopes");
    expect(keys).toContain("asks");
  });
});

describe("the sentence that justifies specialists", () => {
  test('reads "N of M skills"', () => {
    expect(skillsSentence(manifest({ skills: ["a"] }), 98)).toBe(
      "1 of 98 skills",
    );
  });
});
