/**
 * Graph extraction must checkpoint on what it READ, never on what exists.
 *
 * The bug: `runGraphExtraction` returned `lastProcessedTimestamp:
 * conversationTimestamp`, and that resolves to MAX(messages.created_at) for
 * the whole conversation. Every conversation gets at least two extraction
 * jobs — a debounced mid-conversation one and an end-of-conversation full
 * pass — so after the first job the checkpoint already sat at the newest
 * message, and the full pass then found nothing new. Every time. Messages that
 * arrived while an LLM call was in flight were marked processed without ever
 * being looked at.
 *
 * On production that was roughly 190 of 237 jobs in one day logging
 * `Graph extraction job complete` with `nodesCreated: 0`. Not an error — an
 * absence, reported as a success, for as long as anyone cared to look.
 *
 * The checkpoint is a claim ("everything up to here has been read"), and a
 * claim you cannot substantiate is a lie whatever the intent. These tests hold
 * the parser to the narrow honest answer.
 */

import { describe, expect, test } from "bun:test";

import { readTranscriptLines } from "../extraction.js";

const at = (iso: string) => new Date(iso).getTime();

function jsonl(
  ...msgs: Array<{ role?: string; content?: string; ts?: string }>
): string {
  return msgs.map((m) => JSON.stringify(m)).join("\n");
}

describe("readTranscriptLines", () => {
  test("reports the newest message it actually included", () => {
    const body = jsonl(
      { role: "user", content: "first", ts: "2026-08-01T10:00:00Z" },
      { role: "assistant", content: "second", ts: "2026-08-01T10:05:00Z" },
    );
    const result = readTranscriptLines(body);
    expect(result?.newestTimestamp).toBe(at("2026-08-01T10:05:00Z"));
  });

  test("an incremental window never reports past its own last message", () => {
    // The exact shape of the bug. Three messages exist; the window starts
    // after the first, so two are read — and the checkpoint must be the second
    // of those, not "the newest message in the file".
    const body = jsonl(
      { role: "user", content: "already read", ts: "2026-08-01T10:00:00Z" },
      { role: "assistant", content: "new one", ts: "2026-08-01T10:05:00Z" },
      { role: "user", content: "newer still", ts: "2026-08-01T10:09:00Z" },
    );
    const result = readTranscriptLines(body, at("2026-08-01T10:00:00Z"));
    expect(result?.text).not.toContain("already read");
    expect(result?.text).toContain("new one");
    expect(result?.newestTimestamp).toBe(at("2026-08-01T10:09:00Z"));
  });

  test("a message that arrives after the read is NOT claimed as processed", () => {
    // What happens when a message lands mid-LLM-call: it is not in the body
    // this run parsed, so the checkpoint must stop short of it and the next
    // run must still find it.
    const readBody = jsonl({
      role: "user",
      content: "in the transcript",
      ts: "2026-08-01T10:00:00Z",
    });
    const first = readTranscriptLines(readBody);
    expect(first?.newestTimestamp).toBe(at("2026-08-01T10:00:00Z"));

    const laterBody = jsonl(
      {
        role: "user",
        content: "in the transcript",
        ts: "2026-08-01T10:00:00Z",
      },
      { role: "user", content: "arrived late", ts: "2026-08-01T10:00:30Z" },
    );
    const second = readTranscriptLines(laterBody, first!.newestTimestamp!);
    expect(second?.text).toContain("arrived late");
  });

  test("nothing new means null, not an empty transcript to extract from", () => {
    const body = jsonl({
      role: "user",
      content: "old",
      ts: "2026-08-01T10:00:00Z",
    });
    expect(readTranscriptLines(body, at("2026-08-01T11:00:00Z"))).toBeNull();
  });

  test("a message with no usable timestamp is read but cannot move the checkpoint", () => {
    // Including it keeps content; advancing on it would claim a position we
    // cannot justify. Content in, claim out.
    const body = jsonl(
      { role: "user", content: "undated" },
      { role: "user", content: "malformed date", ts: "not a date" },
    );
    const result = readTranscriptLines(body);
    expect(result?.text).toContain("undated");
    expect(result?.text).toContain("malformed date");
    expect(result?.newestTimestamp).toBeNull();
  });

  test("out-of-order lines still yield the true maximum", () => {
    const body = jsonl(
      { role: "user", content: "later", ts: "2026-08-01T12:00:00Z" },
      { role: "assistant", content: "earlier", ts: "2026-08-01T09:00:00Z" },
    );
    expect(readTranscriptLines(body)?.newestTimestamp).toBe(
      at("2026-08-01T12:00:00Z"),
    );
  });

  test("malformed lines are skipped without losing the rest", () => {
    const body = [
      JSON.stringify({
        role: "user",
        content: "good",
        ts: "2026-08-01T10:00:00Z",
      }),
      "{ not json",
      JSON.stringify({ role: "assistant", content: "" }),
      JSON.stringify({
        role: "assistant",
        content: "also good",
        ts: "2026-08-01T10:01:00Z",
      }),
    ].join("\n");
    const result = readTranscriptLines(body);
    expect(result?.text).toContain("good");
    expect(result?.text).toContain("also good");
    expect(result?.newestTimestamp).toBe(at("2026-08-01T10:01:00Z"));
  });

  test("an empty body is null", () => {
    expect(readTranscriptLines("")).toBeNull();
    expect(readTranscriptLines("\n\n")).toBeNull();
  });
});
