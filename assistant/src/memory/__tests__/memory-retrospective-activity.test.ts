/**
 * The retrospective's user-activity gate (port of upstream ff10e008e1),
 * driven against a real database rather than a mocked activity module.
 *
 * A retrospective fires only when the unprocessed tail carries user activity.
 * The subtlety the gate exists for: tool results ride on **user-role** rows,
 * so a bare role check counts any tool-using assistant stretch as user
 * activity. Assistant-only stretches (proactive sends, broadcast recaps) have
 * no user turn to anchor a window on, and their content is a recap of work
 * already captured at its source.
 *
 * Deliberately no `mock.module` for the module under test: the enqueue funnel
 * is exercised end-to-end through real `messages` / `memory_jobs` rows, so
 * these assertions cannot pass against a stubbed probe.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

const loggerActual = await import("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...loggerActual,
  getLogger: () => makeMockLogger(),
}));

/** Mutable so a test can flip `requireUserActivity` off. */
let testConfig: AssistantConfig = structuredClone(DEFAULT_CONFIG);
const configActual = await import("../../config/loader.js");
mock.module("../../config/loader.js", () => ({
  ...configActual,
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
}));

const tmpWorkspace = mkdtempSync(join(tmpdir(), "retro-activity-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { getDb, getMemoryDb } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { conversations, messages } = await import("../schema/conversations.js");
const { memoryJobs } = await import("../schema.js");
const { upsertRetrospectiveState } =
  await import("../memory-retrospective-state.js");
const {
  hasQualifyingUserMessageAfter,
  messagesHaveUserActivity,
  retrospectiveRequiresUserActivity,
} = await import("../memory-retrospective-activity.js");
const { enqueueMemoryRetrospectiveIfEnabled } =
  await import("../memory-retrospective-enqueue.js");

const CONV = "conv-activity-1";

/** Insert a message row; `content` is stored verbatim. */
function addMessage(args: {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}) {
  getDb()
    .insert(messages)
    .values({
      id: args.id,
      conversationId: CONV,
      role: args.role,
      content: args.content,
      createdAt: args.createdAt,
    })
    .run();
}

/** A user-authored turn. */
function userText(id: string, createdAt: number, text = "hello") {
  addMessage({
    id,
    role: "user",
    content: JSON.stringify([{ type: "text", text }]),
    createdAt,
  });
}

/** A user-role row that carries only tool results — not user activity. */
function toolResultCarrier(id: string, createdAt: number) {
  addMessage({
    id,
    role: "user",
    content: JSON.stringify([{ type: "tool_result", tool_use_id: "t1" }]),
    createdAt,
  });
}

function assistantText(id: string, createdAt: number, text = "recap") {
  addMessage({
    id,
    role: "assistant",
    content: JSON.stringify([{ type: "text", text }]),
    createdAt,
  });
}

function retrospectiveJobRows() {
  return getMemoryDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "memory_retrospective"))
    .all();
}

beforeAll(() => {
  initializeDb();
});

afterAll(() => {
  process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

beforeEach(() => {
  testConfig = structuredClone(DEFAULT_CONFIG);
  getDb().delete(messages).run();
  getDb().delete(conversations).run();
  getMemoryDb().delete(memoryJobs).run();
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({ id: CONV, createdAt: now, updatedAt: now })
    .run();
});

describe("retrospectiveRequiresUserActivity", () => {
  test("defaults ON when the key is absent from the config", () => {
    expect(
      retrospectiveRequiresUserActivity(testConfig.memory.retrospective),
    ).toBe(true);
  });

  test("an explicit false turns it off", () => {
    const cfg = {
      ...testConfig.memory.retrospective,
      requireUserActivity: false,
    };
    expect(retrospectiveRequiresUserActivity(cfg)).toBe(false);
  });
});

describe("messagesHaveUserActivity", () => {
  test("a user turn with text counts", () => {
    expect(
      messagesHaveUserActivity([
        {
          role: "user",
          content: JSON.stringify([{ type: "text", text: "x" }]),
        },
      ]),
    ).toBe(true);
  });

  test("a user row carrying only tool_result blocks does not count", () => {
    expect(
      messagesHaveUserActivity([
        {
          role: "assistant",
          content: JSON.stringify([{ type: "tool_use", id: "t1" }]),
        },
        {
          role: "user",
          content: JSON.stringify([
            { type: "tool_result", tool_use_id: "t1" },
            { type: "tool_result", tool_use_id: "t2" },
          ]),
        },
      ]),
    ).toBe(false);
  });

  test("a mixed row counts — one non-tool_result block is enough", () => {
    expect(
      messagesHaveUserActivity([
        {
          role: "user",
          content: JSON.stringify([
            { type: "tool_result", tool_use_id: "t1" },
            { type: "text", text: "and here's why" },
          ]),
        },
      ]),
    ).toBe(true);
  });

  test("assistant rows never count, whatever they carry", () => {
    expect(
      messagesHaveUserActivity([
        {
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "proactive send" }]),
        },
      ]),
    ).toBe(false);
  });

  test("unparseable or non-array user content fails toward running", () => {
    // Legacy plain strings and file-backed refs must not silence the pass.
    expect(
      messagesHaveUserActivity([
        { role: "user", content: "legacy plain text" },
      ]),
    ).toBe(true);
    expect(
      messagesHaveUserActivity([{ role: "user", content: '{"ref":"file"}' }]),
    ).toBe(true);
  });

  test("an empty content array carries nothing", () => {
    expect(messagesHaveUserActivity([{ role: "user", content: "[]" }])).toBe(
      false,
    );
    expect(messagesHaveUserActivity([{ role: "user", content: "" }])).toBe(
      false,
    );
  });

  test("an empty slice is not user activity", () => {
    expect(messagesHaveUserActivity([])).toBe(false);
  });
});

describe("hasQualifyingUserMessageAfter", () => {
  test("finds a user turn after the cursor", () => {
    userText("m1", 1000);
    assistantText("m2", 2000);
    userText("m3", 3000);

    expect(hasQualifyingUserMessageAfter(CONV, "m1")).toBe(true);
  });

  test("an assistant-only tail after the cursor does not qualify", () => {
    userText("m1", 1000);
    assistantText("m2", 2000);
    assistantText("m3", 3000);

    expect(hasQualifyingUserMessageAfter(CONV, "m1")).toBe(false);
  });

  test("a tool-result carrier after the cursor does not qualify", () => {
    userText("m1", 1000);
    assistantText("m2", 2000);
    toolResultCarrier("m3", 3000);

    expect(hasQualifyingUserMessageAfter(CONV, "m1")).toBe(false);
  });

  test("the cursor row itself is excluded — strictly after", () => {
    assistantText("m1", 1000);
    userText("m2", 2000);

    // m2 is the cursor: nothing after it.
    expect(hasQualifyingUserMessageAfter(CONV, "m2")).toBe(false);
  });

  test("ties on createdAt break by id, so a same-ms user turn is still seen", () => {
    assistantText("m1", 1000);
    userText("m2", 1000);

    expect(hasQualifyingUserMessageAfter(CONV, "m1")).toBe(true);
  });

  test("a null cursor scans the whole conversation", () => {
    userText("m1", 1000);
    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(true);
    expect(hasQualifyingUserMessageAfter(CONV, "")).toBe(true);
  });

  test("a vanished cursor row means no new work", () => {
    // The referenced message was deleted (compaction, history strip). Without
    // an anchor there is no defensible window, so the gate reports nothing.
    userText("m1", 1000);
    expect(hasQualifyingUserMessageAfter(CONV, "gone")).toBe(false);
  });

  test("other conversations' user turns do not leak in", () => {
    const other = "conv-other";
    const now = Date.now();
    getDb()
      .insert(conversations)
      .values({ id: other, createdAt: now, updatedAt: now })
      .run();
    assistantText("m1", 1000);
    getDb()
      .insert(messages)
      .values({
        id: "other-1",
        conversationId: other,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
        createdAt: 5000,
      })
      .run();

    expect(hasQualifyingUserMessageAfter(CONV, null)).toBe(false);
  });
});

describe("the enqueue funnel applies the gate", () => {
  test("a user turn in the unprocessed tail enqueues a real job row", () => {
    userText("m1", 1000);

    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: CONV,
      trigger: "interval",
    });

    expect(enqueued).toBe(true);
    expect(retrospectiveJobRows()).toHaveLength(1);
  });

  test("an assistant-only tail enqueues nothing", () => {
    assistantText("m1", 1000);

    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: CONV,
      trigger: "interval",
    });

    expect(enqueued).toBe(false);
    expect(retrospectiveJobRows()).toHaveLength(0);
  });

  test("the gate reads the tail after the persisted cursor, not the whole conversation", () => {
    // The user turn is BEFORE the cursor, so it is already accounted for;
    // only the assistant recap after it is new.
    userText("m1", 1000);
    assistantText("m2", 2000);
    upsertRetrospectiveState({
      conversationId: CONV,
      lastProcessedMessageId: "m1",
      lastRunAt: Date.now() - 60 * 60 * 1000,
    });

    expect(
      enqueueMemoryRetrospectiveIfEnabled({
        conversationId: CONV,
        trigger: "message_count",
      }),
    ).toBe(false);

    // A fresh user turn re-opens the window, and the deferred assistant
    // stretch is reviewed along with it.
    userText("m3", 3000);
    expect(
      enqueueMemoryRetrospectiveIfEnabled({
        conversationId: CONV,
        trigger: "message_count",
      }),
    ).toBe(true);
  });

  test("requireUserActivity=false enqueues over an assistant-only tail", () => {
    assistantText("m1", 1000);
    (
      testConfig.memory.retrospective as unknown as Record<string, unknown>
    ).requireUserActivity = false;

    expect(
      enqueueMemoryRetrospectiveIfEnabled({
        conversationId: CONV,
        trigger: "interval",
      }),
    ).toBe(true);
    expect(retrospectiveJobRows()).toHaveLength(1);
  });

  test("the recursion guard still wins over a qualifying tail", () => {
    userText("m1", 1000);
    getDb()
      .update(conversations)
      .set({ source: "memory-retrospective" })
      .where(eq(conversations.id, CONV))
      .run();

    expect(
      enqueueMemoryRetrospectiveIfEnabled({
        conversationId: CONV,
        trigger: "interval",
      }),
    ).toBe(false);
    expect(retrospectiveJobRows()).toHaveLength(0);
  });
});
