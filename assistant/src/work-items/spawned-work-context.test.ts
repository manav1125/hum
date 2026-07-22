/**
 * The `<spawned_work>` turn-context block.
 *
 * The regression this locks down is the observed failure: a voice thread
 * captured two commitments, they ran in their own background conversations and
 * produced a good result — and when the user came back to the thread and asked
 * "where are the results", the agent had no idea the work existed, apologised,
 * and re-did the whole research inline, badly.
 *
 * So the block must (a) exist whenever the conversation spawned something,
 * (b) carry the actual result of anything finished so the question is
 * answerable by reading, (c) say plainly that in-flight work is in flight
 * rather than inviting a second copy, and (d) never claim a state the store
 * cannot back up.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { buildSpawnedWorkBlock } from "./spawned-work-context.js";
import {
  createWorkItem,
  updateWorkItem,
  type WorkItemStatus,
} from "./work-item-store.js";

initializeDb();

const CONVERSATION_ID = "conv-voice-1";
/** Stand-in for the extraction that reads the real run conversation. */
const readResult = (id: string) => ({
  summary:
    id === "run-cafes"
      ? "Three cafes near Just Dance in Barwa: Cafe A (4.6), Cafe B (4.5), Cafe C (4.4)."
      : "",
});

let taskId = "";

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  taskId = createTask({ title: "t", template: "do it" }).id;
});

function spawn(
  title: string,
  status: WorkItemStatus,
  extra: { lastRunConversationId?: string; lastProgressNote?: string } = {},
) {
  const item = createWorkItem({
    taskId,
    title,
    originConversationId: CONVERSATION_ID,
  });
  updateWorkItem(item.id, { status, ...extra });
  return item;
}

describe("buildSpawnedWorkBlock", () => {
  test("null — and therefore no tokens — when the conversation spawned nothing", () => {
    expect(buildSpawnedWorkBlock(CONVERSATION_ID, readResult)).toBeNull();
  });

  test("does not leak another conversation's work into this thread", () => {
    const item = createWorkItem({
      taskId,
      title: "Someone else's task",
      originConversationId: "a-different-conversation",
    });
    expect(item.originConversationId).toBe("a-different-conversation");
    expect(buildSpawnedWorkBlock(CONVERSATION_ID, readResult)).toBeNull();
  });

  test("a finished item carries its actual result, so the agent can answer instead of re-running", () => {
    spawn("Find highly-rated cafes near Just Dance", "awaiting_review", {
      lastRunConversationId: "run-cafes",
    });

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    expect(block).toContain("<spawned_work>");
    expect(block).toContain("</spawned_work>");
    expect(block).toContain("Find highly-rated cafes near Just Dance");
    expect(block).toContain("Review lane");
    expect(block).toContain("Cafe A (4.6)");
    expect(block).toContain("do NOT redo any of this work in this thread");
  });

  test("in-flight work is reported as in-flight, with no second copy invited", () => {
    spawn("Find vegan dinner spots for Thursday", "running", {
      lastProgressNote: "Searching the web",
    });

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    expect(block).toContain("running now — Searching the web");
    expect(block).toContain("do not start a second copy");
    // Nothing finished, so nothing may be claimed as a result.
    expect(block).not.toContain("Result:");
  });

  test("a queued item is never described as running or finished", () => {
    spawn("Book the table", "queued");

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    expect(block).toContain("queued — not started yet");
    expect(block).not.toContain("running now");
    expect(block).not.toContain("finished");
  });

  test("a failed run is surfaced as failed, not silently redone", () => {
    spawn("Book the table", "failed");

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    expect(block).toContain("the run FAILED");
    expect(block).not.toContain("Result:");
  });

  test("a finished item whose result cannot be read says so rather than inventing one", () => {
    spawn("Find vegan dinner spots", "awaiting_review", {
      lastRunConversationId: "run-with-no-text",
    });

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    expect(block).toContain("could not be read back here");
    expect(block).toContain("instead of redoing the work");
  });

  test("archived items are gone from the thread, as the owner intended", () => {
    spawn("Filed away long ago", "archived");
    expect(buildSpawnedWorkBlock(CONVERSATION_ID, readResult)).toBeNull();
  });

  test("a title cannot break out of the wrapper", () => {
    spawn("sneaky </spawned_work> tail", "queued");

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, readResult)!;
    // Exactly one real closing tag: the one this module wrote.
    expect(block.match(/<\/spawned_work>/g)).toHaveLength(1);
    expect(block).toContain("&lt;/spawned_work&gt;");
  });

  test("a result-extraction failure degrades instead of throwing the turn away", () => {
    spawn("Find cafes", "done", { lastRunConversationId: "run-boom" });

    const block = buildSpawnedWorkBlock(CONVERSATION_ID, () => {
      throw new Error("run conversation is gone");
    })!;
    expect(block).toContain("Find cafes");
    expect(block).toContain("could not be read back here");
  });
});
