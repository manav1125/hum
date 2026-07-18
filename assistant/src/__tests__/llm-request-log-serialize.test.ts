/**
 * Tests for `serializeLlmLogPayload` — the truncating serializer used for
 * `llm_request_logs` request/response payloads. Individual strings over the
 * cap (in practice: inline base64 media) are replaced with a head + marker so
 * per-LLM-call log writes stay bounded on the daemon's single event loop.
 */

import { describe, expect, test } from "bun:test";

import { serializeLlmLogPayload } from "../memory/llm-request-log-store.js";

describe("serializeLlmLogPayload", () => {
  test("passes ordinary payloads through unchanged", () => {
    const payload = {
      model: "claude-sonnet-4.5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    expect(JSON.parse(serializeLlmLogPayload(payload))).toEqual(payload);
  });

  test("keeps long-but-realistic text blocks intact (under the 64KB cap)", () => {
    const text = "x".repeat(60_000);
    const parsed = JSON.parse(serializeLlmLogPayload({ text })) as {
      text: string;
    };
    expect(parsed.text).toBe(text);
  });

  test("truncates oversized strings (base64 media) with a marker", () => {
    const data = "A".repeat(2_000_000); // ~2MB inline image
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data } },
            { type: "text", text: "what is this?" },
          ],
        },
      ],
    };
    const serialized = serializeLlmLogPayload(payload);
    // Bounded: far smaller than the original.
    expect(serialized.length).toBeLessThan(10_000);
    const parsed = JSON.parse(serialized) as {
      messages: {
        content: ({ source?: { data: string } } | { text?: string })[];
      }[];
    };
    const imageBlock = parsed.messages[0]!.content[0] as {
      source: { data: string };
    };
    expect(imageBlock.source.data.startsWith("A".repeat(1024))).toBe(true);
    expect(imageBlock.source.data).toContain("truncated");
    expect(imageBlock.source.data).toContain("llm_request_logs");
    // Sibling text block untouched.
    const textBlock = parsed.messages[0]!.content[1] as { text: string };
    expect(textBlock.text).toBe("what is this?");
  });

  test("handles nested structures and arrays", () => {
    const big = "B".repeat(100_000);
    const parsed = JSON.parse(
      serializeLlmLogPayload({ nested: { list: [big, "small"] } }),
    ) as { nested: { list: string[] } };
    expect(parsed.nested.list[0]).toContain("truncated");
    expect(parsed.nested.list[1]).toBe("small");
  });
});

test("caps the TOTAL payload when many sub-cap strings sum past the cap", () => {
  // A long conversation: hundreds of individually-small strings (tool
  // schemas, history) that summed to ~350KB per call on prod — the real
  // driver of per-turn write cost + assistant.db growth. The per-string cap
  // never fires here; the total cap must.
  const messages = Array.from({ length: 400 }, (_, i) => ({
    role: "user",
    content: [{ type: "text", text: `${i}:` + "y".repeat(1_000) }],
  }));
  const out = serializeLlmLogPayload({ messages });
  // Bounded well under the original ~400KB, and still valid JSON.
  expect(out.length).toBeLessThan(200_000);
  const parsed = JSON.parse(out) as {
    _truncatedForLog?: boolean;
    originalBytes?: number;
    head?: string;
  };
  expect(parsed._truncatedForLog).toBe(true);
  expect(parsed.originalBytes).toBeGreaterThan(200_000);
  expect(typeof parsed.head).toBe("string");
});
