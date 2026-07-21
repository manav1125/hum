/**
 * WS-G — post-call action-item capture.
 *
 * Verifies the transcript → work-items pipeline end-to-end with the LLM
 * extractor and the triage hand-off injected via the module's test-only
 * override hook (no provider, no background run, no real Twilio/media). The
 * pure helpers (transcript flattening, response parsing, spoken-text
 * extraction) are covered directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { addMessage } from "../../memory/conversation-crud.js";
import { getOrCreateConversation } from "../../memory/conversation-key-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { listWorkItems } from "../../work-items/work-item-store.js";
import {
  _resetCallCaptureGuardForTests,
  _setCallCaptureOverridesForTests,
  buildTranscriptTurns,
  captureCallActionItems,
  type ExtractedCallItem,
  extractSpokenText,
  parseCallItemsResponse,
} from "../call-action-item-capture.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
}

async function seedTranscript(convKey: string): Promise<string> {
  const { conversationId } = getOrCreateConversation(convKey);
  // Caller turn (plain transcribed text).
  await addMessage(
    conversationId,
    "user",
    "Hi, this is Dana from Acme. Can you have Sam send over the signed contract by Friday?",
    { metadata: { userMessageChannel: "phone" } },
  );
  // Cue turn (JSON content blocks, incl. a control marker + a UI surface that
  // must be ignored when flattening).
  await addMessage(
    conversationId,
    "assistant",
    JSON.stringify([
      {
        type: "text",
        text: "Absolutely, I'll make sure Sam sends it over. [END_CALL]",
      },
      { type: "ui_surface", surfaceType: "call_summary", data: {} },
    ]),
    { metadata: { assistantMessageChannel: "phone" } },
  );
  return conversationId;
}

beforeEach(() => {
  resetTables();
  _resetCallCaptureGuardForTests();
});

afterEach(() => {
  _setCallCaptureOverridesForTests({});
  _resetCallCaptureGuardForTests();
});

describe("pure helpers", () => {
  test("extractSpokenText pulls text out of JSON blocks and strips markers", () => {
    const out = extractSpokenText(
      JSON.stringify([
        { type: "text", text: "Sure thing. [ASK_GUARDIAN: ok to book?]" },
        { type: "ui_surface", surfaceType: "call_summary" },
        { type: "tool_use", name: "x" },
      ]),
    );
    expect(out).toBe("Sure thing.");
  });

  test("extractSpokenText handles plain text", () => {
    expect(extractSpokenText("Hello there")).toBe("Hello there");
  });

  test("extractSpokenText returns empty for a pure UI surface", () => {
    expect(
      extractSpokenText(
        JSON.stringify([{ type: "ui_surface", surfaceType: "call_summary" }]),
      ),
    ).toBe("");
  });

  test("buildTranscriptTurns labels caller/Cue and drops opening markers", () => {
    const turns = buildTranscriptTurns([
      { role: "user", content: "(call connected — deliver opening greeting)" },
      { role: "assistant", content: "Hey, this is Ava." },
      { role: "user", content: "Can you send the deck?" },
      { role: "system", content: "ignored" },
    ]);
    expect(turns).toEqual([
      { speaker: "Cue", text: "Hey, this is Ava." },
      { speaker: "Caller", text: "Can you send the deck?" },
    ]);
  });

  test("parseCallItemsResponse types items and nulls stale/invalid dueAt", () => {
    const now = Date.parse("2026-07-21T12:00:00");
    const items = parseCallItemsResponse(
      JSON.stringify([
        {
          type: "action",
          title: "Send signed contract",
          executionPrompt: "Email the signed contract to Dana at Acme.",
          dueAtIso: "2026-07-24T17:00",
        },
        {
          type: "decision",
          title: "Agreed to Friday deadline",
          executionPrompt: "",
        },
        { type: "context", title: "Dana is the Acme contact" },
        { type: "action", title: "", executionPrompt: "missing title" },
        { type: "action", executionPrompt: "missing title too" },
      ]),
      now,
    );
    expect(items).not.toBeNull();
    expect(items).toHaveLength(3);
    expect(items?.[0]).toMatchObject({
      type: "action",
      title: "Send signed contract",
    });
    expect(items?.[0]?.dueAt).toBe(Date.parse("2026-07-24T17:00"));
    // decision/context fall back to the title as their note.
    expect(items?.[1]).toMatchObject({
      type: "decision",
      executionPrompt: "Agreed to Friday deadline",
    });
    expect(items?.[2]?.type).toBe("context");
  });

  test("parseCallItemsResponse returns null on non-JSON (LLM failure)", () => {
    expect(parseCallItemsResponse("I could not extract anything.")).toBeNull();
  });
});

describe("captureCallActionItems", () => {
  test("files action items as phone-sourced work items, skips decision/context", async () => {
    const conversationId = await seedTranscript("voice:inbound:CA-1");

    const triaged: string[] = [];
    _setCallCaptureOverridesForTests({
      extractor: async () =>
        [
          {
            type: "action",
            title: "Send signed contract to Dana",
            executionPrompt:
              "Email the signed contract to Dana at Acme by Friday.",
            dueAt: null,
          },
          {
            type: "decision",
            title: "Agreed to Friday deadline",
            executionPrompt: "note",
            dueAt: null,
          },
          {
            type: "context",
            title: "Dana = Acme contact",
            executionPrompt: "note",
            dueAt: null,
          },
        ] satisfies ExtractedCallItem[],
      triage: async (id: string) => {
        triaged.push(id);
        return { autoRunStarted: false, reason: "skipped" as const };
      },
    });

    const result = await captureCallActionItems({
      callSessionId: "CS-1",
      conversationId,
      direction: "inbound",
      counterparty: "+15555550142",
    });

    expect(result.status).toBe("captured");
    expect(result.items).toHaveLength(3);
    expect(result.createdWorkItemIds).toHaveLength(1); // only the action
    expect(triaged).toEqual(result.createdWorkItemIds);

    const items = listWorkItems();
    const filed = items.filter((i) => i.sourceType === "phone");
    expect(filed).toHaveLength(1);
    expect(filed[0]?.title).toBe("Send signed contract to Dana");
    expect(filed[0]?.assignee).toBe("Inbox");
    expect(filed[0]?.sourceId).toBe(conversationId);
  });

  test("is idempotent across the two finalize paths (one extraction)", async () => {
    const conversationId = await seedTranscript("voice:inbound:CA-2");
    let extractorCalls = 0;
    _setCallCaptureOverridesForTests({
      extractor: async () => {
        extractorCalls += 1;
        return [
          {
            type: "action",
            title: "Call Dana back",
            executionPrompt: "Return Dana's call.",
            dueAt: null,
          },
        ] satisfies ExtractedCallItem[];
      },
      triage: async () => ({
        autoRunStarted: false,
        reason: "skipped" as const,
      }),
    });

    const args = {
      callSessionId: "CS-2",
      conversationId,
      direction: "inbound" as const,
      counterparty: "+15555550100",
    };
    const first = await captureCallActionItems(args);
    const second = await captureCallActionItems(args);

    expect(first.status).toBe("captured");
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("already_captured");
    expect(extractorCalls).toBe(1);
    expect(
      listWorkItems().filter((i) => i.sourceType === "phone"),
    ).toHaveLength(1);
  });

  test("skips when the transcript is too short", async () => {
    const { conversationId } = getOrCreateConversation("voice:inbound:CA-3");
    await addMessage(conversationId, "user", "Hi", {
      metadata: { userMessageChannel: "phone" },
    });
    _setCallCaptureOverridesForTests({
      extractor: async () => [],
      triage: async () => ({
        autoRunStarted: false,
        reason: "skipped" as const,
      }),
    });

    const result = await captureCallActionItems({
      callSessionId: "CS-3",
      conversationId,
      direction: "inbound",
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("transcript_too_short");
    expect(listWorkItems()).toHaveLength(0);
  });

  test("skips (never guesses) when the extractor fails", async () => {
    const conversationId = await seedTranscript("voice:inbound:CA-4");
    _setCallCaptureOverridesForTests({
      extractor: async () => null, // LLM failure
      triage: async () => ({
        autoRunStarted: false,
        reason: "skipped" as const,
      }),
    });

    const result = await captureCallActionItems({
      callSessionId: "CS-4",
      conversationId,
      direction: "inbound",
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("llm_unavailable");
    expect(listWorkItems()).toHaveLength(0);
  });
});
