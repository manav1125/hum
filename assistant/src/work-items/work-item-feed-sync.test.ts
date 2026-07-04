/**
 * Feed ↔ work-item lifecycle sync, exercised through the store chokepoints.
 *
 * The historical bug: work-item mirror cards persisted on the Home feed
 * outlived the work item itself — archiving/completing/deleting the item left
 * its "Run it" card in the Inbound lane forever. `updateWorkItem` (on any
 * terminal status transition) and `removeWorkItemFromQueue` now reconcile the
 * feed, dismissing matching cards. The reconcile is fire-and-forget, so these
 * tests poll the on-disk feed briefly instead of awaiting a promise.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { resetDbForTesting } from "../__tests__/db-test-helpers.js";
import { appendFeedItem, readHomeFeed } from "../home/feed-writer.js";
import { workItemToFeedItem } from "../home/work-item-feed.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  createWorkItem,
  removeWorkItemFromQueue,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";

// An earlier test file in the same process may have lazily opened the DB
// singleton inside its own (since-deleted) per-test workspace override,
// leaving an unmigrated handle behind. Drop it so initializeDb() opens a
// migrated DB in the preload workspace.
resetDbForTesting();
initializeDb();

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let taskId = "";

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-wifs-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "Feed sync task", template: "do it" }).id;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

// Don't leak rows to a later test file sharing this `bun test` process.
afterAll(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
});

/** Poll until `pred` holds (the feed reconcile is fire-and-forget). */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(pred()).toBe(true);
}

/** Persist the work item's mirror card to the on-disk feed. */
async function persistMirrorCard(item: WorkItem): Promise<string> {
  const card = workItemToFeedItem(item, new Date());
  await appendFeedItem(card);
  expect(readHomeFeed().items.find((i) => i.id === card.id)?.status).toBe(
    "new",
  );
  return card.id;
}

function cardStatus(cardId: string): string | undefined {
  return readHomeFeed().items.find((i) => i.id === cardId)?.status;
}

describe("work-item → feed lifecycle sync", () => {
  test("archiving a work item dismisses its persisted mirror card", async () => {
    const item = createWorkItem({ taskId, title: "Archive me" });
    const cardId = await persistMirrorCard(item);

    updateWorkItem(item.id, { status: "archived" }, { actor: "user" });

    await waitFor(() => cardStatus(cardId) === "dismissed");
  });

  test("completing a work item dismisses its mirror card", async () => {
    const item = createWorkItem({ taskId, title: "Finish me" });
    const cardId = await persistMirrorCard(item);

    updateWorkItem(item.id, { status: "done" }, { actor: "user" });

    await waitFor(() => cardStatus(cardId) === "dismissed");
  });

  test("a non-terminal transition leaves the card alone", async () => {
    const item = createWorkItem({ taskId, title: "Still live" });
    const cardId = await persistMirrorCard(item);

    updateWorkItem(item.id, { status: "running" }, { actor: "runner" });

    // Give the (should-not-fire) reconcile a beat, then assert unchanged.
    await new Promise((r) => setTimeout(r, 100));
    expect(cardStatus(cardId)).toBe("new");
  });

  test("deleting via removeWorkItemFromQueue dismisses the mirror card", async () => {
    const item = createWorkItem({ taskId, title: "Delete me" });
    const cardId = await persistMirrorCard(item);

    const result = removeWorkItemFromQueue(item.id);
    expect(result.success).toBe(true);

    await waitFor(() => cardStatus(cardId) === "dismissed");
  });
});
