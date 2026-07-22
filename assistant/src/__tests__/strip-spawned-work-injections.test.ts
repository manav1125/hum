/**
 * The `<spawned_work>` block is ephemeral by contract.
 *
 * It reports LIVE state ("running now", "finished — waiting in the Review
 * lane") and the text of finished results. A copy left riding history from an
 * earlier turn would have the system asserting a state it can no longer back
 * up. Runtime assembly strip-and-replaces it every turn; compaction and
 * overflow recovery drop it too.
 */

import { describe, expect, test } from "bun:test";

import {
  stripInjectionsForCompaction,
  stripSpawnedWorkInjections,
} from "../context/strip-injections.js";
import type { Message } from "../providers/types.js";

const STALE =
  '<spawned_work>\n- "Find cafes" — running now\n</spawned_work>';
const FRESH =
  '<spawned_work>\n- "Find cafes" — finished — the result is waiting in the user\'s Review lane\n</spawned_work>';

function userMessage(...texts: string[]): Message {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text" as const, text })),
  } as Message;
}

describe("stripSpawnedWorkInjections", () => {
  test("removes every stale copy while leaving the user's own text", () => {
    const messages = [
      userMessage(STALE, "where are the results"),
      userMessage(FRESH, "and the vegan one?"),
    ];

    const stripped = stripSpawnedWorkInjections(messages);

    expect(stripped).toHaveLength(2);
    expect(stripped[0].content).toEqual([
      { type: "text", text: "where are the results" },
    ]);
    expect(stripped[1].content).toEqual([
      { type: "text", text: "and the vegan one?" },
    ]);
  });

  test("leaves other injected blocks alone — this is a scoped, single-id strip", () => {
    const messages = [userMessage("<turn_context>\ncurrent_time: x", STALE)];

    const stripped = stripSpawnedWorkInjections(messages);

    expect(stripped[0].content).toEqual([
      { type: "text", text: "<turn_context>\ncurrent_time: x" },
    ]);
  });

  test("user-authored text that merely starts with the tag is not dropped", () => {
    // Full-wrapper matcher: prefix AND suffix both required.
    const authored = "<spawned_work> — what does this tag of yours do?";
    const stripped = stripSpawnedWorkInjections([userMessage(authored)]);
    expect(stripped[0].content).toEqual([{ type: "text", text: authored }]);
  });

  test("compaction drops it along with the other runtime injections", () => {
    const stripped = stripInjectionsForCompaction([
      userMessage(STALE, "carry on"),
    ]);
    expect(stripped[0].content).toEqual([{ type: "text", text: "carry on" }]);
  });
});
