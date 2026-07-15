/**
 * Regression tests for the home-feed action "background" dispatch path.
 *
 * The background mode must route through the guardrailed work-item runner
 * (`runWorkItemInBackground`) — the ONE execution engine that applies the
 * budget hard-stop, the agent model pin, and the tool-scope filter — instead
 * of a second ad-hoc engine that flips work-item status by hand. These tests
 * mock the runner and the work-item store and assert the delegation contract:
 * the route creates the work item, hands it to the runner untouched, retires
 * the originating card, and preserves the `{ mode, workItemId }` response.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ─── Module mocks (declared before the route module is imported) ──────────

mock.module("../../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

const revalidateSpy = mock<() => void>(() => {});
mock.module("../../../home/home-content-refresh.js", () => ({
  revalidateHomeContentInBackground: revalidateSpy,
}));

// Runner: the delegation target under test. Result is swappable per test.
import type { RunWorkItemResult } from "../../../work-items/work-item-runner.js";

let runnerResult: RunWorkItemResult = { success: true };
const runWorkItemSpy = mock<(id: string) => RunWorkItemResult>(
  () => runnerResult,
);
const broadcastStatusSpy = mock<(id: string) => void>(() => {});
const realRunner = await import("../../../work-items/work-item-runner.js");
mock.module("../../../work-items/work-item-runner.js", () => ({
  ...realRunner,
  runWorkItemInBackground: runWorkItemSpy,
  broadcastWorkItemStatus: broadcastStatusSpy,
}));

// Work-item store: in-memory fakes so no sqlite is involved. `updateWorkItem`
// is spied to prove the route no longer flips status by hand — status
// transitions belong to the runner.
type FakeWorkItem = {
  id: string;
  taskId: string;
  title: string;
  status: string;
  sourceType?: string;
  sourceId?: string;
};
let createdWorkItems: FakeWorkItem[] = [];
let activeItemForSource: FakeWorkItem | undefined;
const updateWorkItemSpy = mock<
  (id: string, updates: Record<string, unknown>) => FakeWorkItem | undefined
>(() => undefined);
const realWorkItemStore =
  await import("../../../work-items/work-item-store.js");
mock.module("../../../work-items/work-item-store.js", () => ({
  ...realWorkItemStore,
  listWorkItems: () => [],
  getWorkItem: (id: string) => createdWorkItems.find((wi) => wi.id === id),
  findActiveWorkItemBySource: () => activeItemForSource,
  createWorkItem: (opts: {
    taskId: string;
    title: string;
    sourceType?: string;
    sourceId?: string;
  }) => {
    const wi: FakeWorkItem = {
      id: `wi-${createdWorkItems.length + 1}`,
      taskId: opts.taskId,
      title: opts.title,
      status: "queued",
      ...(opts.sourceType ? { sourceType: opts.sourceType } : {}),
      ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    };
    createdWorkItems.push(wi);
    return wi;
  },
  updateWorkItem: updateWorkItemSpy,
}));

const realTaskStore = await import("../../../tasks/task-store.js");
let createdTasks = 0;
mock.module("../../../tasks/task-store.js", () => ({
  ...realTaskStore,
  createTask: (opts: { title: string; template: string }) => {
    createdTasks += 1;
    return { id: `task-${createdTasks}`, ...opts };
  },
}));

const triageSpy = mock<(id: string, opts?: unknown) => Promise<void>>(
  async () => {},
);
const realTriage = await import("../../../work-items/work-item-triage.js");
mock.module("../../../work-items/work-item-triage.js", () => ({
  ...realTriage,
  triageAndMaybeAutoRunWorkItem: triageSpy,
}));

// Conversation CRUD: stub so thread mode never touches sqlite.
const createdConversations: Array<{ id: string }> = [];
const realConversationCrud =
  await import("../../../memory/conversation-crud.js");
mock.module("../../../memory/conversation-crud.js", () => ({
  ...realConversationCrud,
  createConversation: () => {
    const conv = { id: `conv-${createdConversations.length + 1}` };
    createdConversations.push(conv);
    return conv;
  },
  addMessage: async () => ({ id: "msg-1" }),
}));

// mock.module mutates the process-global registry — restore the real modules
// when this file finishes so later test files see the real implementations.
afterAll(() => {
  mock.module("../../../work-items/work-item-runner.js", () => ({
    ...realRunner,
  }));
  mock.module("../../../work-items/work-item-store.js", () => ({
    ...realWorkItemStore,
  }));
  mock.module("../../../tasks/task-store.js", () => ({ ...realTaskStore }));
  mock.module("../../../work-items/work-item-triage.js", () => ({
    ...realTriage,
  }));
  mock.module("../../../memory/conversation-crud.js", () => ({
    ...realConversationCrud,
  }));
});

// Dynamic imports so the mocks above are wired before evaluation.
const { handlePostFeedAction } = await import("../home-feed-routes.js");
const { RouteError } = await import("../errors.js");
const { readHomeFeed, getHomeFeedPath } =
  await import("../../../home/feed-writer.js");

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FIXTURE_CREATED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function writeFeedFile(items: Array<Record<string, unknown>>): void {
  const path = getHomeFeedPath();
  mkdirSync(join(workspaceDir, "data"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { version: 2, updatedAt: FIXTURE_CREATED_AT, items },
      null,
      2,
    ),
    "utf-8",
  );
}

function actionableItem(id: string): Record<string, unknown> {
  return {
    id,
    type: "notification",
    priority: 50,
    title: `Card ${id}`,
    summary: "Test summary",
    timestamp: FIXTURE_CREATED_AT,
    status: "new",
    createdAt: FIXTURE_CREATED_AT,
    actions: [
      { id: "run", label: "Run it", prompt: "Do the background thing" },
    ],
  };
}

async function postAction(
  itemId: string,
  actionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const result = await handlePostFeedAction({
      pathParams: { id: itemId, actionId },
      body,
    });
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof RouteError) {
      return { status: err.statusCode, body: { error: err.message } };
    }
    throw err;
  }
}

/** Poll the on-disk feed until the item reaches `status` (coalesced writes). */
async function waitForFeedStatus(
  itemId: string,
  status: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = readHomeFeed().items.find((i) => i.id === itemId);
    if (item?.status === status) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hfad-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  createdWorkItems = [];
  createdTasks = 0;
  activeItemForSource = undefined;
  runnerResult = { success: true };
  runWorkItemSpy.mockClear();
  broadcastStatusSpy.mockClear();
  updateWorkItemSpy.mockClear();
  triageSpy.mockClear();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("handlePostFeedAction — background mode delegates to the work-item runner", () => {
  test("dispatches through runWorkItemInBackground and returns { mode, workItemId }", async () => {
    writeFeedFile([actionableItem("item-1")]);

    const res = await postAction("item-1", "run", { mode: "background" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "background", workItemId: "wi-1" });

    // ONE engine: the guardrailed runner received the freshly minted item.
    expect(runWorkItemSpy).toHaveBeenCalledTimes(1);
    expect(runWorkItemSpy).toHaveBeenCalledWith("wi-1");

    // The route must NOT flip work-item status by hand anymore — status
    // transitions (running → awaiting_review/failed) belong to the runner,
    // which also applies the budget hard-stop, model pin, and tool scopes.
    expect(updateWorkItemSpy).not.toHaveBeenCalled();
  });

  test("retires the originating feed card at dispatch (acted_on)", async () => {
    writeFeedFile([actionableItem("item-2")]);

    const res = await postAction("item-2", "run", { mode: "background" });
    expect(res.status).toBe(200);
    expect(await waitForFeedStatus("item-2", "acted_on")).toBe(true);
  });

  test("already_running dedup is idempotent: 200 with the live work item", async () => {
    writeFeedFile([actionableItem("item-3")]);
    runnerResult = {
      success: false,
      error: "Work item is already running",
      errorCode: "already_running",
    };

    const res = await postAction("item-3", "run", { mode: "background" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "background", workItemId: "wi-1" });
  });

  test("budget hard-stop returns the (failed) work item, not a 500", async () => {
    writeFeedFile([actionableItem("item-4")]);
    runnerResult = {
      success: false,
      error: "Stopped: this task reached its budget",
      errorCode: "budget_stop",
    };

    const res = await postAction("item-4", "run", { mode: "background" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "background", workItemId: "wi-1" });
    // The runner already marked the item failed and broadcast; the card is
    // still retired so the stale "Run it" doesn't linger next to the incident.
    expect(await waitForFeedStatus("item-4", "acted_on")).toBe(true);
  });

  test("a genuine dispatch failure surfaces as 500", async () => {
    writeFeedFile([actionableItem("item-5")]);
    runnerResult = {
      success: false,
      error: "Associated task not found",
      errorCode: "no_task",
    };

    const res = await postAction("item-5", "run", { mode: "background" });
    expect(res.status).toBe(500);
    // And the card is NOT retired — the user can retry.
    const item = readHomeFeed().items.find((i) => i.id === "item-5");
    expect(item?.status).toBe("new");
  });

  test("thread mode never invokes the runner", async () => {
    writeFeedFile([actionableItem("item-6")]);

    const res = await postAction("item-6", "run", { mode: "thread" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "thread", conversationId: "conv-1" });
    expect(runWorkItemSpy).not.toHaveBeenCalled();
    expect(createdWorkItems).toHaveLength(0);
  });
});
