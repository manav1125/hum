/**
 * The two rules the valve's client side has to get right, isolated so they can
 * actually be broken and watched to fail.
 *
 * Both are "a pending read is not an answer" in different clothes:
 *
 *   · a valve that has not replied must not render as a valve holding nothing;
 *   · a ✕ with no subject to teach must not be offered, because a dismissal
 *     that teaches nothing spends the owner's attention on a filter that never
 *     hears them.
 */

import { describe, expect, test } from "bun:test";

import { feedbackSubject, valveLaneState, type ValveState } from "./use-valve";

function state(over: Partial<ValveState> = {}): ValveState {
  return {
    stop: "needs_you",
    missionOverrides: [],
    shown: 57,
    held: 37,
    unbanded: 5,
    bands: { urgent: 5, needs_you: 52, everything: 37 },
    ...over,
  } as ValveState;
}

describe("valveLaneState — a pending read is not a zero", () => {
  test("an answered valve is known, field for field", () => {
    const lane = valveLaneState({ state: state(), isError: false });
    expect(lane).toEqual({
      kind: "known",
      payload: { stop: "needs_you", held: 37, unbanded: 5 },
    });
  });

  test("a valve that has not replied is unavailable, NOT zeroes", () => {
    const lane = valveLaneState({ state: undefined, isError: false });
    expect(lane.kind).toBe("unavailable");
    // The specific defect: `?? 0` here would claim the valve is holding
    // nothing back, on every first paint, forever.
    expect(JSON.stringify(lane)).not.toContain('"held"');
  });

  test("a valve that errored says so rather than going quiet", () => {
    const lane = valveLaneState({ state: undefined, isError: true });
    expect(lane).toMatchObject({
      kind: "unavailable",
      reason: "Cue couldn't read your volume valve.",
    });
  });

  test("a genuinely empty valve IS zeroes — a measured zero is a fact", () => {
    const lane = valveLaneState({
      state: state({ held: 0, unbanded: 0 }),
      isError: false,
    });
    expect(lane).toMatchObject({ kind: "known" });
  });
});

describe("feedbackSubject — teach about the stream, never the one item", () => {
  test("prefers the sender, normalised", () => {
    expect(
      feedbackSubject({
        sourceContext: JSON.stringify({ sender: "  Billing@Example.com " }),
        sourceType: "gmail",
      }),
    ).toEqual({ subjectKind: "sender", subjectKey: "billing@example.com" });
  });

  test("falls back to the channel rather than guessing a sender", () => {
    expect(
      feedbackSubject({ sourceContext: null, sourceType: "slack" }),
    ).toEqual({ subjectKind: "channel", subjectKey: "slack" });
  });

  test("a malformed provenance blob does not throw and does not invent", () => {
    expect(
      feedbackSubject({ sourceContext: "{not json", sourceType: "gmail" }),
    ).toEqual({ subjectKind: "channel", subjectKey: "gmail" });
  });

  test("nothing to teach about returns null, so no ✕ is offered", () => {
    expect(feedbackSubject({ sourceContext: null, sourceType: null })).toBeNull();
    expect(feedbackSubject({ sourceContext: "{}", sourceType: "  " })).toBeNull();
  });
});
