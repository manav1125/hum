/**
 * Tests for the chat clarify pre-check — the chat-side sibling of the
 * work-item pre-run assessment.
 *
 * The two gates are tested independently:
 *   - {@link shouldConsiderClarify} is pure, so its "consequential vs simple"
 *     mapping is asserted directly and exhaustively — this is the gate that
 *     protects the hot path, so the MUST-NOT-trigger set is the important half.
 *   - {@link assessChatClarify} is driven by an injected model stub, so the
 *     execute/clarify/confidence-floor behaviour is deterministic and offline.
 *     A spy proves the model is NEVER called for a message the heuristic
 *     rejects (no added latency on simple turns).
 */
import { describe, expect, test } from "bun:test";

import type { Message } from "../providers/types.js";
import {
  appendClarifyDirective,
  assessChatClarify,
  buildChatClarifyPrompt,
  buildClarifyDirective,
  extractQuestionsArray,
  shouldConsiderClarify,
  type ChatClarifyModel,
} from "./chat-clarify-precheck.js";

// ---------------------------------------------------------------------------
// Gate 1 — the pure heuristic
// ---------------------------------------------------------------------------

describe("shouldConsiderClarify", () => {
  const CONSEQUENTIAL = [
    "book the flights",
    "book the flights to Bali next week",
    "buy the tickets for Saturday",
    "reserve a table for four",
    "pay the invoice from the landlord",
    "wire the deposit to the agent",
    "cancel my subscription",
    "reschedule the dentist",
    "order the parts",
    "email the team the update",
    "reply to the client",
    "forward that to finance",
    "schedule a call with the investors",
    "rsvp yes to the wedding",
    "renew the domain",
    "get me a hotel in Lisbon",
  ];

  const SIMPLE = [
    "what's 2+2",
    "summarise this thread",
    "thanks!",
    "explain how promises work",
    "what time is it in Tokyo",
    "who won the 2020 election",
    "translate this to French",
    "what's the weather like",
    "give me a summary of the doc", // self-directed "give me", no action
    "send me the notes", // self-directed "send me", not outbound
    "show me the options",
    "", // empty
  ];

  for (const text of CONSEQUENTIAL) {
    test(`triggers on consequential: "${text}"`, () => {
      expect(shouldConsiderClarify(text)).toBe(true);
    });
  }

  for (const text of SIMPLE) {
    test(`does NOT trigger on simple/cheap: "${text}"`, () => {
      expect(shouldConsiderClarify(text)).toBe(false);
    });
  }

  test("skips very long pastes (not a crisp command)", () => {
    const wall = "book ".repeat(600); // > 2000 chars, contains "book"
    expect(wall.length).toBeGreaterThan(2_000);
    expect(shouldConsiderClarify(wall)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prompt + directive shape
// ---------------------------------------------------------------------------

const CAPS = {
  lines: ["search the web and read web pages", "drive a real web browser"],
  connectors: ["google"],
  fingerprint: "cap-fixed",
};

describe("buildChatClarifyPrompt", () => {
  test("quotes the message, capabilities, and the execute-by-default rule", () => {
    const prompt = buildChatClarifyPrompt("book the flights", CAPS);
    expect(prompt).toContain("MESSAGE: book the flights");
    expect(prompt).toContain("search the web and read web pages");
    expect(prompt).toContain("LINKED ACCOUNTS: google");
    expect(prompt).toContain('"verdict": "execute" | "clarify"');
    // The execute-by-default bias must be explicit in the prompt.
    expect(prompt.toLowerCase()).toContain("default");
  });
});

describe("buildClarifyDirective / appendClarifyDirective", () => {
  test("single question routes to ask_question and does not answer for the user", () => {
    const d = buildClarifyDirective(["Which trip — the Bali one or Tokyo?"]);
    expect(d).toContain("ask_question");
    expect(d).toContain("Which trip — the Bali one or Tokyo?");
    expect(d).toContain("ONE question");
    expect(d).toContain("<clarify_directive>");
    expect(d).toContain("</clarify_directive>");
  });

  test("several questions route to ONE batched ask_question call", () => {
    const d = buildClarifyDirective([
      "Which trip?",
      "Which dates?",
      "How many travellers?",
    ]);
    expect(d).toContain("ask_question");
    // One batched call via the `questions` array, not one-at-a-time.
    expect(d).toContain("`questions` array");
    expect(d).toContain("do not ask them one message at a time");
    expect(d).toContain("1. Which trip?");
    expect(d).toContain("2. Which dates?");
    expect(d).toContain("3. How many travellers?");
  });

  test("empty / whitespace-only list yields no directive", () => {
    expect(buildClarifyDirective([])).toBe("");
    expect(buildClarifyDirective(["   ", ""])).toBe("");
  });

  test("appends a text block to the tail user message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "book the flights" }] },
    ];
    const out = appendClarifyDirective(messages, ["Which trip?"]);
    const tail = out[out.length - 1]!;
    expect(tail.role).toBe("user");
    expect(tail.content).toHaveLength(2);
    const last = tail.content[tail.content.length - 1]!;
    expect(last.type).toBe("text");
    expect((last as { text: string }).text).toContain("Which trip?");
    // Non-mutating.
    expect(messages[0]!.content).toHaveLength(1);
  });

  test("no-ops (returns input) when the tail is not a user message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(appendClarifyDirective(messages, ["q?"])).toBe(messages);
  });

  test("no-ops (returns input) when the question list is empty", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "book the flights" }] },
    ];
    expect(appendClarifyDirective(messages, [])).toBe(messages);
  });
});

describe("extractQuestionsArray", () => {
  test("pulls a real questions[] array, trimmed and de-duplicated", () => {
    const out = extractQuestionsArray(
      '{"verdict":"clarify","questions":[" Which trip? "," Which dates? ","Which trip?"],"confidence":0.9}',
    );
    expect(out).toEqual(["Which trip?", "Which dates?"]);
  });

  test("returns null when absent, empty, or not an array", () => {
    expect(
      extractQuestionsArray('{"verdict":"clarify","question":"x"}'),
    ).toBeNull();
    expect(
      extractQuestionsArray('{"questions":[]}'),
    ).toBeNull();
    expect(
      extractQuestionsArray('{"questions":"not an array"}'),
    ).toBeNull();
    expect(extractQuestionsArray("no json here")).toBeNull();
  });

  test("caps the batch at MAX_QUESTIONS (4)", () => {
    const out = extractQuestionsArray(
      '{"questions":["a","b","c","d","e","f"]}',
    );
    expect(out).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — the model call (injected stub)
// ---------------------------------------------------------------------------

function modelReturning(json: string): ChatClarifyModel {
  return async () => json;
}

describe("assessChatClarify", () => {
  test("simple message → heuristic short-circuits, model is NEVER called", async () => {
    let called = false;
    const spy: ChatClarifyModel = async () => {
      called = true;
      return '{"verdict":"clarify","question":"?","confidence":1}';
    };
    const result = await assessChatClarify("summarise this thread", spy);
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("consequential + confident clarify → returns the ONE question", async () => {
    const result = await assessChatClarify(
      "book the flights",
      modelReturning(
        '{"verdict":"clarify","question":"Which trip and dates — and how many travellers?","confidence":0.9}',
      ),
    );
    expect(result).not.toBeNull();
    expect(result!.questions).toEqual([
      "Which trip and dates — and how many travellers?",
    ]);
  });

  test("clarify with a real questions[] → returns the whole batch", async () => {
    const result = await assessChatClarify(
      "book the flights",
      modelReturning(
        '{"verdict":"clarify","question":"Which trip?","questions":["Which trip?","Which dates?","How many travellers?"],"confidence":0.9}',
      ),
    );
    expect(result).not.toBeNull();
    expect(result!.questions).toEqual([
      "Which trip?",
      "Which dates?",
      "How many travellers?",
    ]);
  });

  test("questions[] present but no top-level question still degrades to execute → null", async () => {
    // parseAssessmentResponse requires `question` for a clarify; a reply that
    // only fills `questions` degrades to execute (no single question), so the
    // pre-check declines rather than guessing. The prompt asks the model to
    // always mirror the first question into `question`.
    const result = await assessChatClarify(
      "book the flights",
      modelReturning(
        '{"verdict":"clarify","questions":["Which trip?","Which dates?"],"confidence":0.9}',
      ),
    );
    expect(result).toBeNull();
  });

  test("consequential but execute verdict → null (runs unclarified)", async () => {
    const result = await assessChatClarify(
      "book the flights to Bali on the 3rd for me and Sam",
      modelReturning('{"verdict":"execute","confidence":0.9}'),
    );
    expect(result).toBeNull();
  });

  test("clarify below the confidence floor → null (bias to execute)", async () => {
    const result = await assessChatClarify(
      "book the flights",
      modelReturning(
        '{"verdict":"clarify","question":"Which trip?","confidence":0.2}',
      ),
    );
    expect(result).toBeNull();
  });

  test("model returns no reply → null (fail open)", async () => {
    const result = await assessChatClarify("book the flights", async () => null);
    expect(result).toBeNull();
  });

  test("clarify with no question degrades to execute → null", async () => {
    const result = await assessChatClarify(
      "book the flights",
      modelReturning('{"verdict":"clarify","confidence":0.9}'),
    );
    expect(result).toBeNull();
  });

  test("a run-on `question` string is split to its FIRST sentence", async () => {
    // When the model crams several asks into the single `question` field (no
    // `questions` array), the assessment parser keeps only the first — the
    // batch path is opt-in via `questions`, not inferred from punctuation.
    const result = await assessChatClarify(
      "book the flights",
      modelReturning(
        '{"verdict":"clarify","question":"Which trip? Also which airline? And what class?","confidence":0.9}',
      ),
    );
    expect(result!.questions).toEqual(["Which trip?"]);
  });
});
