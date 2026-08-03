import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Provider seam: capture the prompt the extractor receives, return a forced
// tool_use with whatever `toolItems` is set to for the current test.
let lastUserContent = "";
let toolItems: Array<{ text: string }> = [];
const realProvider = await import("../../providers/provider-send-message.js");
mock.module("../../providers/provider-send-message.js", () => ({
  ...realProvider,
  getConfiguredProvider: async () => ({
    // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    sendMessage: async (messages: any) => {
      lastUserContent = messages?.[0]?.content?.[0]?.text ?? "";
      return {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "capture_session_followups",
            input: { action_items: toolItems },
          },
        ],
      };
    },
  }),
}));

// Keep memory extraction a no-op — synthesis fires it detached/best-effort and
// we don't want a real extraction run touching the DB after the test.
mock.module("../../memory/graph/extraction.js", () => ({
  runGraphExtraction: async () => {},
}));

import {
  addMessage,
  createConversation,
} from "../../memory/conversation-crud.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createWorkItemWithPermissions,
  listWorkItemsByOriginConversation,
} from "../../work-items/work-item-store.js";
import { synthesizeLiveVoiceSession } from "../synthesize-live-voice-session.js";

initializeDb();

function resetTables() {
  const db = getDb();
  for (const t of ["work_items", "tasks", "messages", "conversations"]) {
    db.run(`DELETE FROM ${t}`);
  }
}

function seedConversation(id: string, turns: Array<[string, string]>) {
  createConversation({
    id,
    conversationType: "standard",
    source: "live-voice",
  });
  for (const [role, text] of turns) {
    void addMessage(
      id,
      role as "user" | "assistant",
      JSON.stringify([{ type: "text", text }]),
    );
  }
}

describe("synthesizeLiveVoiceSession", () => {
  beforeEach(() => {
    resetTables();
    lastUserContent = "";
    toolItems = [];
  });

  test("returns empty (no throw) when the conversation does not exist", async () => {
    const result = await synthesizeLiveVoiceSession("missing-conversation");
    expect(result.newTaskTitles).toEqual([]);
  });

  test("returns empty for a too-short transcript", async () => {
    const id = crypto.randomUUID();
    seedConversation(id, [["user", "hi"]]);
    toolItems = [{ text: "should not be created" }];
    const result = await synthesizeLiveVoiceSession(id);
    expect(result.newTaskTitles).toEqual([]);
    expect(listWorkItemsByOriginConversation(id)).toHaveLength(0);
  });

  test("parks a residual to-do and returns its title", async () => {
    const id = crypto.randomUUID();
    seedConversation(id, [
      [
        "user",
        "Thanks for the help planning the offsite, that all sounds great to me.",
      ],
      [
        "assistant",
        "Of course — I've got the venue shortlist going. Anything else on your mind?",
      ],
      [
        "user",
        "Oh, and remind me to book the oat milk delivery before the weekend.",
      ],
    ]);
    toolItems = [{ text: "Book the oat milk delivery before the weekend" }];

    const result = await synthesizeLiveVoiceSession(id);

    expect(result.newTaskTitles).toContain(
      "Book the oat milk delivery before the weekend",
    );
    const items = listWorkItemsByOriginConversation(id);
    const created = items.find(
      (w) => w.title === "Book the oat milk delivery before the weekend",
    );
    expect(created).toBeTruthy();
    expect(created?.sourceType).toBe("voice-live");
    // Parked → never auto-runs at hang-up.
    expect(created?.autoRunEligibility).toBe("parked");
  });

  test("passes already-captured task titles to the extractor as already-handled", async () => {
    const id = crypto.randomUUID();
    seedConversation(id, [
      [
        "user",
        "Great, so you're already emailing the investor deck to the team today.",
      ],
      [
        "assistant",
        "Yes, that's sending now. I'll confirm once it's out the door.",
      ],
    ]);
    // A task already created DURING the call (origin = this conversation).
    const task = createTask({
      title: "Email the investor deck to the team",
      template: "Email the investor deck to the team",
      createdFromConversationId: id,
    });
    createWorkItemWithPermissions({
      taskId: task.id,
      title: "Email the investor deck to the team",
      originConversationId: id,
    });
    toolItems = []; // extractor finds nothing new

    await synthesizeLiveVoiceSession(id);

    expect(lastUserContent).toContain("Already handled");
    expect(lastUserContent).toContain("Email the investor deck to the team");
  });
});
