import { describe, expect, test } from "bun:test";

import { ReasoningTagFilter } from "../reasoning-tag-filter.js";

/** Feed deltas one at a time and return everything the filter let through. */
function run(deltas: string[]): string {
  const filter = new ReasoningTagFilter();
  let out = "";
  for (const delta of deltas) out += filter.push(delta);
  out += filter.flush();
  return out;
}

describe("ReasoningTagFilter", () => {
  test("a stream with no tags passes through byte-for-byte", () => {
    const deltas = ["Hello, ", "the meeting ", "is at three."];
    expect(run(deltas)).toBe("Hello, the meeting is at three.");
  });

  test("strips a leading think span and speaks only the answer", () => {
    expect(run(["<think>the user wants the time</think>It is three."])).toBe(
      "It is three.",
    );
  });

  test("strips a thinking span mid-stream, keeping both sides", () => {
    expect(run(["Sure. <thinking>check the calendar</thinking>Three."])).toBe(
      "Sure. Three.",
    );
  });

  test("holds a tag split across delta boundaries", () => {
    // The classic failure: `<think` looks like speakable text until the next
    // chunk proves it is a tag.
    expect(run(["<thin", "k>secret</thi", "nk>Spoken."])).toBe("Spoken.");
  });

  test("releases a partial that never became a tag", () => {
    expect(run(["The tag is <th"])).toBe("The tag is <th");
  });

  test("emits ordinary angle-bracket text untouched", () => {
    expect(run(["Use <b>bold</b> and a < b comparison."])).toBe(
      "Use <b>bold</b> and a < b comparison.",
    );
  });

  test("holds nothing once a candidate is disproved mid-delta", () => {
    const filter = new ReasoningTagFilter();
    expect(filter.push("a <thx b")).toBe("a <thx b");
    expect(filter.flush()).toBe("");
  });

  test("drops a stray closing tag without muting the turn", () => {
    // Observed shape: the model opened the span on the reasoning channel, and
    // only the tail — reasoning text plus the close tag — leaked onto the
    // content channel. The close must not be spoken, and must not be mistaken
    // for an opener that silences everything after it.
    expect(run(["...and execute it.</think>", "Writing it now."])).toBe(
      "...and execute it.Writing it now.",
    );
  });

  test("matches tags case-insensitively", () => {
    expect(run(["<THINK>noise</Think>Answer."])).toBe("Answer.");
  });

  test("does not close a thinking span on the shorter close tag", () => {
    // `</think>` is a prefix-sibling of `</thinking>`; a shortest-match scan
    // would close here and then speak "ing>".
    expect(run(["<thinking>noise</thinking>Answer."])).toBe("Answer.");
  });

  test("an unclosed span suppresses the rest of the turn", () => {
    expect(run(["<think>reasoning that never closes"])).toBe("");
  });

  test("suppression does not survive flush", () => {
    const filter = new ReasoningTagFilter();
    expect(filter.push("<think>unclosed")).toBe("");
    expect(filter.flush()).toBe("");
    expect(filter.push("Next turn speaks.")).toBe("Next turn speaks.");
  });

  test("reset drops held text and clears the span", () => {
    const filter = new ReasoningTagFilter();
    filter.push("<think>noise");
    filter.reset();
    expect(filter.push("Fresh.")).toBe("Fresh.");
  });

  test("handles multiple spans in one stream", () => {
    expect(run(["<think>a</think>One. <think>b</think>Two."])).toBe(
      "One. Two.",
    );
  });

  test("survives a one-character-at-a-time stream", () => {
    const source = "<think>hidden</think>Said aloud.";
    expect(run([...source])).toBe("Said aloud.");
  });

  test("empty deltas are inert", () => {
    const filter = new ReasoningTagFilter();
    expect(filter.push("")).toBe("");
    expect(filter.push("hi")).toBe("hi");
    expect(filter.push("")).toBe("");
  });

  test("a tag straddling many deltas still opens exactly once", () => {
    expect(
      run(["<", "t", "h", "i", "n", "k", ">", "x", "</think>", "ok"]),
    ).toBe("ok");
  });
});
