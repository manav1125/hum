/**
 * Tests for the Morning Brief endpoint: the three-beat story assembly —
 * overnight completions (review vs done, window filtering, attribution),
 * the single ask (approval outranks review), and the day schedule (due-today
 * work items; calendar degrades to unavailable when no connection exists).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// No Google connection in tests — the calendar gather must degrade to
// `calendarAvailable: false` without any network I/O.
mock.module("../../oauth/connection-resolver.js", () => ({
  resolveOAuthConnection: async () => {
    throw new Error("google not connected (test)");
  },
}));

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createTask } from "../../tasks/task-store.js";
import {
  createAgent,
  deleteAgent,
  listAgents,
} from "../../work-items/agent-store.js";
import { createProject } from "../../work-items/project-store.js";
import {
  createWorkItem,
  listWorkItems,
  removeWorkItemFromQueue,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import {
  clear as clearInteractions,
  register,
} from "../pending-interactions.js";
import {
  type MorningBrief,
  parseSinceHours,
  ROUTES,
} from "./morning-brief-routes.js";

initializeDb();

const route = ROUTES.find(
  (r) => r.endpoint === "brief/morning" && r.method === "GET",
)!;

async function callBrief(
  queryParams?: Record<string, string>,
): Promise<MorningBrief> {
  return (await route.handler({ headers: {}, queryParams })) as MorningBrief;
}

function clearWorkItems(): void {
  for (const i of listWorkItems()) removeWorkItemFromQueue(i.id);
}

function clearAgents(): void {
  for (const a of listAgents()) deleteAgent(a.id);
}

/**
 * Backdate a work item's completion: both the row's updated_at (the cheap
 * pre-filter) and its audit-trail event timestamps (the precise signal).
 * Ids are store-minted uuids and `at` is caller-controlled — safe to inline.
 */
function backdate(id: string, at: number): void {
  const ts = Math.floor(at);
  getDb().run(`UPDATE work_items SET updated_at = ${ts} WHERE id = '${id}'`);
  getDb().run(
    `UPDATE work_item_events SET at = ${ts} WHERE work_item_id = '${id}'`,
  );
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  clearWorkItems();
  clearAgents();
  clearInteractions();
});

afterEach(() => {
  clearWorkItems();
  clearAgents();
  clearInteractions();
});

describe("morning brief endpoint", () => {
  test("all quiet: empty beats, calendar honestly unavailable", async () => {
    const brief = await callBrief();
    expect(brief.overnight).toEqual([]);
    expect(brief.ask).toBeNull();
    expect(brief.day).toEqual([]);
    expect(brief.calendarAvailable).toBe(false);
    // Window default is 24h.
    expect(Date.parse(brief.generatedAt) - Date.parse(brief.since)).toBeCloseTo(
      24 * HOUR,
      -4,
    );
  });

  test("overnight: done + review items in-window; the ask never doubles as an overnight row", async () => {
    const task = createTask({ title: "t", template: "..." });
    const done = createWorkItem({
      taskId: task.id,
      title: "14 emails triaged & filed",
    });
    updateWorkItem(done.id, { status: "done" });
    const reviewTop = createWorkItem({
      taskId: task.id,
      title: "Acme one-pager",
    });
    updateWorkItem(reviewTop.id, { status: "awaiting_review" });
    const reviewOther = createWorkItem({
      taskId: task.id,
      title: "Pricing follow-up",
    });
    updateWorkItem(reviewOther.id, { status: "awaiting_review" });
    // Still-running work is not an overnight win.
    const running = createWorkItem({ taskId: task.id, title: "Still running" });
    updateWorkItem(running.id, { status: "running" });

    const brief = await callBrief();
    // The single ask is one of the review items…
    expect(brief.ask?.kind).toBe("review");
    const askId = brief.ask!.id;
    // …and that exact item is NOT narrated again under "while you slept"
    // (status reconciliation: a next-move isn't also "finished").
    expect(brief.overnight.map((o) => o.id)).not.toContain(askId);
    const otherReviewId =
      askId === reviewTop.id ? reviewOther.id : reviewTop.id;
    expect(brief.overnight.map((o) => o.id)).toEqual([
      otherReviewId,
      done.id,
    ]);
    expect(brief.overnight[0].state).toBe("review");
    expect(brief.overnight[1]).toMatchObject({
      title: "14 emails triaged & filed",
      state: "done",
    });
    // completedAt is a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(brief.overnight[0].completedAt))).toBe(
      false,
    );
  });

  test("overnight: completions older than the window are excluded", async () => {
    const task = createTask({ title: "t", template: "..." });
    const old = createWorkItem({ taskId: task.id, title: "Done last week" });
    updateWorkItem(old.id, { status: "done" });
    backdate(old.id, Date.now() - 26 * HOUR);
    const fresh = createWorkItem({ taskId: task.id, title: "Done overnight" });
    updateWorkItem(fresh.id, { status: "done" });

    const brief = await callBrief();
    expect(brief.overnight.map((o) => o.id)).toEqual([fresh.id]);

    // A wider explicit window pulls the older completion back in.
    const wide = await callBrief({ sinceHours: "48" });
    expect(wide.overnight.map((o) => o.id)).toEqual([fresh.id, old.id]);
  });

  test("overnight: project + named-agent attribution", async () => {
    const project = createProject({ title: "Acme renewal" });
    createAgent({ name: "Ops", domain: "Operations" });
    const task = createTask({ title: "t", template: "..." });
    const wi = createWorkItem({
      taskId: task.id,
      title: "Draft the renewal one-pager",
      projectId: project.id,
      assignee: "ops", // case-insensitive match against the Ops agent
    });
    updateWorkItem(wi.id, { status: "awaiting_review" });
    // A pending approval takes the ask slot, so the review item stays an
    // overnight row (otherwise the reconciliation pass would claim it).
    register("req-attr", {
      conversationId: "conv-attr",
      kind: "confirmation",
      confirmationDetails: {
        toolName: "send_email",
        input: {},
        riskLevel: "high",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    const brief = await callBrief();
    expect(brief.overnight[0].project).toBe("Acme renewal");
    expect(brief.overnight[0].agent).toBe("Ops");
  });

  test("overnight: duplicate titles collapse and degenerate titles are skipped", async () => {
    const task = createTask({ title: "t", template: "..." });
    const dentistA = createWorkItem({
      taskId: task.id,
      title: "Call the dentist",
    });
    updateWorkItem(dentistA.id, { status: "done" });
    const dentistB = createWorkItem({
      taskId: task.id,
      title: "  call the  dentist ", // same story, messier capture
    });
    updateWorkItem(dentistB.id, { status: "done" });
    const garbage = createWorkItem({ taskId: task.id, title: "ok" });
    updateWorkItem(garbage.id, { status: "done" });
    const real = createWorkItem({
      taskId: task.id,
      title: "File the expense report",
    });
    updateWorkItem(real.id, { status: "done" });

    const brief = await callBrief();
    const titles = brief.overnight.map((o) => o.title);
    // One dentist row, no "ok" row, the real row present.
    expect(
      titles.filter((t) => t.toLowerCase().includes("dentist")),
    ).toHaveLength(1);
    expect(titles).not.toContain("ok");
    expect(titles).toContain("File the expense report");
  });

  test("ask: a degenerate-titled top review yields to the next narratable one", async () => {
    const task = createTask({ title: "t", template: "..." });
    const garbage = createWorkItem({ taskId: task.id, title: "ok" });
    updateWorkItem(garbage.id, { status: "awaiting_review" });
    const real = createWorkItem({
      taskId: task.id,
      title: "Review the pricing page",
    });
    updateWorkItem(real.id, { status: "awaiting_review" });

    const brief = await callBrief();
    expect(brief.ask?.title).toBe("Review the pricing page");
  });

  test("overnight: the implicit house assignee 'cue' carries no agent chip", async () => {
    const task = createTask({ title: "t", template: "..." });
    const wi = createWorkItem({ taskId: task.id, title: "Filed quietly" });
    updateWorkItem(wi.id, { status: "done" });

    const brief = await callBrief();
    expect(brief.overnight[0].agent).toBeUndefined();
    expect(brief.overnight[0].project).toBeUndefined();
  });

  test("ask: a pending approval outranks an awaiting-review item", async () => {
    const task = createTask({ title: "t", template: "..." });
    const review = createWorkItem({ taskId: task.id, title: "Review me" });
    updateWorkItem(review.id, { status: "awaiting_review" });

    register("req-nda", {
      conversationId: "conv-1",
      kind: "confirmation",
      confirmationDetails: {
        toolName: "send_email",
        input: {},
        riskLevel: "high",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    const brief = await callBrief();
    expect(brief.ask).toMatchObject({
      id: "req-nda",
      kind: "approval",
      title: "Approve: send_email",
      conversationId: "conv-1",
    });
    expect(brief.ask!.actions.map((a) => a.kind).sort()).toEqual([
      "approve",
      "decline",
    ]);
    expect(brief.ask!.actions[0].endpoint).toBe("/v1/confirm");
  });

  test("ask: with no approvals, the top awaiting-review item is the ask", async () => {
    const task = createTask({ title: "t", template: "..." });
    const review = createWorkItem({ taskId: task.id, title: "Pricing page" });
    updateWorkItem(review.id, { status: "awaiting_review" });

    const brief = await callBrief();
    expect(brief.ask).toMatchObject({
      id: review.id,
      kind: "review",
      title: "Pricing page",
    });
    expect(brief.ask!.actions).toEqual([
      {
        id: "open_review",
        label: "Review",
        kind: "open_thread",
        endpoint: `/v1/work-items/${review.id}/output`,
        method: "GET",
      },
    ]);
  });

  test("day: due-today active items included with ISO times; others excluded", async () => {
    const task = createTask({ title: "t", template: "..." });
    const now = new Date();
    // Due later today (clamped inside today even near midnight).
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 0, 0, 0);
    const dueToday = createWorkItem({
      taskId: task.id,
      title: "Renewal call prep",
      dueAt: Math.max(endOfDay.getTime(), now.getTime()),
    });
    // Due tomorrow — not part of today's story.
    createWorkItem({
      taskId: task.id,
      title: "Tomorrow's item",
      dueAt: now.getTime() + 30 * HOUR,
    });
    // Due today but already done — belongs to overnight, not the day plan.
    const doneDue = createWorkItem({
      taskId: task.id,
      title: "Already done",
      dueAt: Math.max(endOfDay.getTime(), now.getTime()),
    });
    updateWorkItem(doneDue.id, { status: "done" });

    const brief = await callBrief();
    expect(brief.day).toHaveLength(1);
    expect(brief.day[0]).toMatchObject({
      title: "Renewal call prep",
      kind: "work_item",
    });
    expect(Number.isNaN(Date.parse(brief.day[0].time!))).toBe(false);
    // The done-due item still shows up as an overnight win.
    expect(brief.overnight.map((o) => o.id)).toContain(doneDue.id);
    void dueToday;
  });

  test("parseSinceHours: defaults and clamps", () => {
    expect(parseSinceHours(undefined)).toBe(24);
    expect(parseSinceHours("")).toBe(24);
    expect(parseSinceHours("junk")).toBe(24);
    expect(parseSinceHours("-3")).toBe(24);
    expect(parseSinceHours("48")).toBe(48);
    expect(parseSinceHours("500")).toBe(72);
  });
});
