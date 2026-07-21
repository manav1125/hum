/**
 * Tests for the static spoken-ack phrase rotation (WS-E presence layer).
 */

import { describe, expect, test } from "bun:test";

import { pickAckPhrase } from "../ack-phrases.js";

describe("pickAckPhrase", () => {
  test("rotates deterministically within a kind and wraps by modulo", () => {
    const first = pickAckPhrase("first_delta", 0);
    const second = pickAckPhrase("first_delta", 1);
    expect(first).not.toBe(second);
    // Wraps: counter and counter+listLength pick the same phrase.
    expect(pickAckPhrase("first_delta", 0)).toBe(
      pickAckPhrase("first_delta", 5),
    );
  });

  test("first_delta and tool_use draw from distinct phrase pools", () => {
    const firstDelta = pickAckPhrase("first_delta", 0);
    const toolUse = pickAckPhrase("tool_use", 0);
    expect(firstDelta).not.toBe(toolUse);
  });

  test("every phrase is short (<= 6 words) and content-free floor-holder", () => {
    for (const kind of ["first_delta", "tool_use"] as const) {
      for (let counter = 0; counter < 5; counter += 1) {
        const phrase = pickAckPhrase(kind, counter);
        expect(phrase.length).toBeGreaterThan(0);
        expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(6);
      }
    }
  });
});
