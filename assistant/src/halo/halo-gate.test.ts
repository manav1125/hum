/**
 * The gate's promises.
 *
 * Two of these are the whole reason the module exists, and both are rules Cue
 * has already been burned by getting wrong elsewhere: the human floor always
 * wins, and every failure resolves toward surfacing rather than swallowing.
 */
import { describe, expect, test } from "bun:test";

import {
  gateEpisode,
  type HaloEpisodeForGate,
  screenEpisode,
} from "./halo-gate.js";

const COMMITMENT =
  "So I'll send Dana the one-pager before Thursday and we agreed the floor " +
  "holds at forty seven dollars a seat for twenty four months, which gives " +
  "her side enough to sign this week without going back to legal again.";

const CHATTER =
  "Yeah the weather has been strange lately, really warm for this time of " +
  "year, and the coffee here is much better than the place on the corner " +
  "which always seems to burn the beans a bit too much for my taste.";

function episode(over: Partial<HaloEpisodeForGate> = {}): HaloEpisodeForGate {
  return { heardSeconds: 600, transcript: COMMITMENT, ...over };
}

describe("the human floor", () => {
  test("a marked episode always proposes, whatever else is true", () => {
    // Short, wordless, unjudgeable — and still through, because a person
    // pressed the button. Nothing below the floor may overturn it.
    const decision = screenEpisode({
      heardSeconds: 5,
      transcript: "",
      markIds: ["m1"],
    });
    expect(decision).toEqual({
      verdict: "propose",
      reason: "marked",
      confidenceTier: "confident",
    });
  });

  test("the floor runs before the model is ever consulted", async () => {
    let asked = false;
    const decision = await gateEpisode(
      episode({ heardSeconds: 5, transcript: "", markIds: ["m1"] }),
      async () => {
        asked = true;
        return { propose: false, confident: true };
      },
    );
    expect(asked).toBe(false);
    expect(decision.verdict).toBe("propose");
  });
});

describe("the deterministic layer", () => {
  test("a corridor exchange is quiet", () => {
    expect(
      screenEpisode({ heardSeconds: 20, transcript: "See you later." }),
    ).toMatchObject({ verdict: "quiet", reason: "too_short" });
  });

  test("plenty of words with nothing owed is quiet", () => {
    expect(
      screenEpisode({ heardSeconds: 600, transcript: CHATTER }),
    ).toMatchObject({ verdict: "quiet", reason: "no_commitment" });
  });

  test("a commitment is handed to the model, not decided here", () => {
    // Returning null is the signal "ambiguous middle — go ask".
    expect(screenEpisode(episode())).toBeNull();
  });

  test("a deadline alone is enough to escalate", () => {
    const text =
      "The Airtel deck needs another look and honestly the numbers on page " +
      "four do not hold up by Friday at the latest, otherwise Tom will ask.";
    expect(screenEpisode({ heardSeconds: 300, transcript: text })).toBeNull();
  });
});

describe("fail open", () => {
  test("no judge configured still proposes, marked unsure", async () => {
    const decision = await gateEpisode(episode(), null);
    expect(decision).toEqual({
      verdict: "propose",
      reason: "unjudged",
      confidenceTier: "unsure",
    });
  });

  test("a judge that throws still proposes", async () => {
    const decision = await gateEpisode(episode(), async () => {
      throw new Error("provider down");
    });
    expect(decision.verdict).toBe("propose");
    expect(decision.reason).toBe("unjudged");
  });

  test("a judge that returns nothing parseable still proposes", async () => {
    const decision = await gateEpisode(episode(), async () => null);
    expect(decision.verdict).toBe("propose");
  });

  test("but a judge that says no is obeyed", async () => {
    // Failing open is about outages, not about overruling a working judge.
    const decision = await gateEpisode(episode(), async () => ({
      propose: false,
      confident: true,
    }));
    expect(decision.verdict).toBe("quiet");
    expect(decision.reason).toBe("judged");
  });

  test("an unconfident yes proposes behind the fold", async () => {
    const decision = await gateEpisode(episode(), async () => ({
      propose: true,
      confident: false,
    }));
    expect(decision).toEqual({
      verdict: "propose",
      reason: "judged",
      confidenceTier: "unsure",
    });
  });
});
