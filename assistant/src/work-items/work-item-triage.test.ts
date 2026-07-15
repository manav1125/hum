import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// The auto-run tests exercise `maybeAutoRunWorkItem` against a real DB; mock
// the runner + policy modules so no background conversation actually spawns
// and the policy is deterministic ("auto" for everything — the hard-deny
// guard must hold even under the most permissive policy).
//
// `mock.module` mutates the *process-global* module registry, so a top-level
// mock here would leak into any other test file sharing the same `bun test`
// process (bun loads every test file up front, before running any test). That
// silently broke `work-items-routes.test.ts`, whose "Run now" route tests
// exercise the REAL `runWorkItemInBackground`. So we capture the real exports
// by value, install the mock only for this file's tests (beforeAll), and
// restore the real module afterward (afterAll) — targeted, so it leaves other
// files' unrelated mocks intact.
import * as workItemRunner from "./work-item-runner.js";

const realRunWorkItemInBackground = workItemRunner.runWorkItemInBackground;
const realBroadcastWorkItemStatus = workItemRunner.broadcastWorkItemStatus;

let runnerCalls: string[] = [];

beforeAll(() => {
  mock.module("./work-item-runner.js", () => ({
    runWorkItemInBackground: (id: string) => {
      runnerCalls.push(id);
      return { success: true };
    },
    broadcastWorkItemStatus: () => {},
  }));
});

afterAll(() => {
  mock.module("./work-item-runner.js", () => ({
    runWorkItemInBackground: realRunWorkItemInBackground,
    broadcastWorkItemStatus: realBroadcastWorkItemStatus,
  }));
});

let mockPolicy: Record<string, string> = {};
mock.module("../permissions/autonomy-policy-reader.js", () => ({
  getAutonomyPolicy: async () => mockPolicy,
}));

// Force the heuristic scoring path — no provider in tests.
mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => null,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  type WorkItem,
} from "./work-item-store.js";
import {
  buildSourceContext,
  buildTriagePrompt,
  classifyWorkItemAutonomy,
  CONSERVATIVE_AUTO_RUN_TOOLS,
  conservativeRequiredToolsForCapture,
  hardDeniedAutoRunTools,
  impliesSideEffectDeliverable,
  isHardDeniedForAutoRun,
  maybeAutoRunWorkItem,
  parseTriageResponse,
  triageWorkItem,
} from "./work-item-triage.js";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    taskId: "task-1",
    title: "Test item",
    notes: null,
    status: "queued",
    priorityTier: 1,
    sortIndex: null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: null,
    sourceId: null,
    requiredTools: null,
    approvedTools: null,
    approvalStatus: "none",
    context: null,
    sourceContext: null,
    lastActivityAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as WorkItem;
}

describe("classifyWorkItemAutonomy", () => {
  test("empty tool snapshot classifies as other", () => {
    expect(classifyWorkItemAutonomy(makeItem())).toEqual(["other"]);
    expect(classifyWorkItemAutonomy(makeItem({ requiredTools: "[]" }))).toEqual(
      ["other"],
    );
  });

  test("malformed snapshot degrades to other rather than throwing", () => {
    expect(
      classifyWorkItemAutonomy(makeItem({ requiredTools: "not json" })),
    ).toEqual(["other"]);
  });

  test("research-only tools classify as research", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["web_search", "read"]),
    });
    expect(classifyWorkItemAutonomy(item)).toEqual(["research"]);
  });

  test("a money tool surfaces the money class alongside others", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["web_search", "stripe_create_payment"]),
    });
    const classes = classifyWorkItemAutonomy(item);
    expect(classes).toContain("money");
    expect(classes).toContain("research");
  });

  test("non-string entries in the snapshot are ignored", () => {
    const item = makeItem({
      requiredTools: JSON.stringify(["read", 42, null]),
    });
    expect(classifyWorkItemAutonomy(item)).toEqual(["research"]);
  });
});

describe("conservativeRequiredToolsForCapture (deterministic producer stamp)", () => {
  test("research-y captures get the read-only research set", () => {
    const stamped = conservativeRequiredToolsForCapture(
      "Research competitor pricing",
      "Compare the top 5 and summarize",
    );
    expect(stamped).toBeDefined();
    expect(JSON.parse(stamped!)).toEqual([...CONSERVATIVE_AUTO_RUN_TOOLS]);
  });

  test("a stamped item classifies to a real category, not ['other']", () => {
    // The whole point of the stamp: meeting/mission items used to land with
    // no snapshot → ["other"] → policy fail-closes to ask → parked forever.
    const item = makeItem({
      requiredTools: conservativeRequiredToolsForCapture("Summarize the news")!,
    });
    expect(classifyWorkItemAutonomy(item)).toEqual(["research"]);
    expect(classifyWorkItemAutonomy(item)).not.toEqual(["other"]);
  });

  test("every tool in the conservative set passes the hard-deny floor", () => {
    for (const tool of CONSERVATIVE_AUTO_RUN_TOOLS) {
      expect(isHardDeniedForAutoRun(tool)).toBe(false);
    }
    const item = makeItem({
      requiredTools: JSON.stringify(CONSERVATIVE_AUTO_RUN_TOOLS),
    });
    expect(hardDeniedAutoRunTools(item)).toEqual([]);
  });

  test("side-effect-implying titles keep an empty snapshot (park for review)", () => {
    for (const title of [
      "Email Sarah the updated deck",
      "Post the launch announcement on LinkedIn",
      "Buy a domain for the microsite",
      "Reply to Aileen about the OTP",
      "Send the OTP to Aileen",
      "Cancel the Notion subscription",
      "Call the vendor about the renewal",
      "Follow up with the design agency",
      "Delete the stale staging database",
      "Publish the changelog",
      "Pay the AWS invoice",
    ]) {
      expect(conservativeRequiredToolsForCapture(title)).toBeUndefined();
      expect(impliesSideEffectDeliverable(title)).toBe(true);
    }
  });

  test("side-effect intent in the notes also blocks the stamp", () => {
    expect(
      conservativeRequiredToolsForCapture(
        "Vendor renewal prep",
        "then email them the signed PO",
      ),
    ).toBeUndefined();
  });

  test("benign research/draft phrasing is not treated as a side effect", () => {
    for (const title of [
      "Research competitor pricing",
      "Summarize yesterday's standup",
      "Draft an outline for the Q3 strategy doc",
      "Review the onboarding flow for friction",
      "Prepare talking points for the offsite",
    ]) {
      expect(impliesSideEffectDeliverable(title)).toBe(false);
      expect(conservativeRequiredToolsForCapture(title)).toBeDefined();
    }
  });
});

describe("buildTriagePrompt (provenance + sender identity)", () => {
  test("includes source provenance and the sender-identity scoring guidance", () => {
    const prompt = buildTriagePrompt(
      makeItem({
        title: "Reply to Aileen",
        notes: "From: Aileen Diaz via whatsapp — asking for the login code",
        sourceType: "whatsapp",
        sourceId: "chat-42",
      }),
      [],
    );
    expect(prompt).toContain("captured from whatsapp");
    expect(prompt).toContain("Source: whatsapp (source id: chat-42)");
    // Notes (which carry the "From: … via …" provenance line) are included.
    expect(prompt).toContain("From: Aileen Diaz via whatsapp");
    // The explicit scoring instruction for sender identity is present.
    expect(prompt).toContain("Sender identity:");
    expect(prompt).toContain("VIP or frequent correspondent");
    // The JSON output contract is unchanged.
    expect(prompt).toContain(
      '{"urgency": <0-100>, "tier": <0|1|2>, "projectId": <string|null>, "dueAt": <"YYYY-MM-DDTHH:MM"|null>}',
    );
  });

  test("source line includes the sourceType alone when no sourceId is set", () => {
    const prompt = buildTriagePrompt(
      makeItem({ title: "Task", sourceType: "meeting" }),
      [],
    );
    expect(prompt).toContain("Source: meeting");
    expect(prompt).not.toContain("source id:");
  });

  test("omits the provenance line entirely for source-less items", () => {
    const prompt = buildTriagePrompt(makeItem({ title: "Plain task" }), []);
    expect(prompt).not.toContain("Source:");
  });
});

describe("isHardDeniedForAutoRun (auto-run safety floor)", () => {
  test("denies desktop host control tools", () => {
    expect(isHardDeniedForAutoRun("host_bash")).toBe(true);
    expect(isHardDeniedForAutoRun("host_cu")).toBe(true);
    expect(isHardDeniedForAutoRun("host_browser")).toBe(true);
    expect(isHardDeniedForAutoRun("host_app_control")).toBe(true);
    expect(isHardDeniedForAutoRun("host_file")).toBe(true);
  });

  test("denies browser and computer-use automation tools", () => {
    expect(isHardDeniedForAutoRun("browser_navigate")).toBe(true);
    expect(isHardDeniedForAutoRun("browser_click")).toBe(true);
    expect(isHardDeniedForAutoRun("mcp__computer-use__left_click")).toBe(true);
    expect(isHardDeniedForAutoRun("computer")).toBe(true);
  });

  test("denies purchase/order-like tools", () => {
    expect(isHardDeniedForAutoRun("amazon_place_order")).toBe(true);
    expect(isHardDeniedForAutoRun("create_checkout_session")).toBe(true);
    expect(isHardDeniedForAutoRun("add_to_cart")).toBe(true);
    expect(isHardDeniedForAutoRun("buy_now")).toBe(true);
    expect(isHardDeniedForAutoRun("stripe_create_payment")).toBe(true);
  });

  test("denies messaging egress and money tools via the autonomy classifier", () => {
    expect(isHardDeniedForAutoRun("send_email")).toBe(true);
    expect(isHardDeniedForAutoRun("mcp__slack__post_message")).toBe(true);
    expect(isHardDeniedForAutoRun("message_send")).toBe(true);
    expect(isHardDeniedForAutoRun("bank_transfer")).toBe(true);
  });

  test("allows research/draft tools and does not false-positive on segments", () => {
    expect(isHardDeniedForAutoRun("web_search")).toBe(false);
    expect(isHardDeniedForAutoRun("read")).toBe(false);
    expect(isHardDeniedForAutoRun("write")).toBe(false);
    expect(isHardDeniedForAutoRun("bash")).toBe(false);
    // Segment matching, not substring: "coordinate" must not match "order",
    // "cart", etc.
    expect(isHardDeniedForAutoRun("coordinate_notes")).toBe(false);
    expect(isHardDeniedForAutoRun("list_email_templates")).toBe(false);
  });

  test("hardDeniedAutoRunTools surfaces only the offending tools", () => {
    const item = makeItem({
      requiredTools: JSON.stringify([
        "web_search",
        "browser_navigate",
        "host_bash",
      ]),
    });
    expect(hardDeniedAutoRunTools(item)).toEqual([
      "browser_navigate",
      "host_bash",
    ]);
    expect(hardDeniedAutoRunTools(makeItem())).toEqual([]);
  });
});

/** Shared by the DB-backed describes; refreshed in each beforeEach. */
let taskId = "";

describe("maybeAutoRunWorkItem (DB-backed auto-run gate)", () => {
  initializeDb();

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    taskId = createTask({ title: "Test task", template: "do it" }).id;
    runnerCalls = [];
    // Most permissive policy possible — the hard-deny floor must still hold.
    mockPolicy = {
      research: "auto",
      draft: "auto",
      send: "auto",
      money: "auto",
      delete: "auto",
      other: "auto",
    };
  });

  // Don't leak rows to a later test file sharing this `bun test` process.
  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  test("hard-denies auto-run when the snapshot includes browser/host/purchase tools, even under an all-auto policy", async () => {
    for (const tools of [
      ["browser_navigate", "web_search"],
      ["host_bash"],
      ["amazon_place_order"],
      ["send_email"],
    ]) {
      const item = createWorkItem({
        taskId,
        title: `Buy stroopwafels via ${tools[0]}`,
        requiredTools: JSON.stringify(tools),
      });
      const decision = await maybeAutoRunWorkItem(item.id);
      expect(decision).toEqual({ started: false, reason: "hard_denied" });
      expect(runnerCalls).toEqual([]);
      expect(getWorkItem(item.id)!.status).toBe("queued");
    }
  });

  test("still auto-runs research-only items when policy allows", async () => {
    const item = createWorkItem({
      taskId,
      title: "Summarize the news",
      requiredTools: JSON.stringify(["web_search", "read"]),
    });
    const decision = await maybeAutoRunWorkItem(item.id);
    expect(decision).toEqual({ started: true, reason: "started" });
    expect(runnerCalls).toEqual([item.id]);
  });

  test("an item stamped with the conservative producer set auto-runs under a research=auto policy", async () => {
    const item = createWorkItem({
      taskId,
      title: "Research competitor pricing",
      requiredTools: conservativeRequiredToolsForCapture(
        "Research competitor pricing",
      ),
    });
    const decision = await maybeAutoRunWorkItem(item.id);
    expect(decision).toEqual({ started: true, reason: "started" });
    expect(runnerCalls).toEqual([item.id]);
  });

  test("defers to the policy for non-hard-denied classes (ask blocks)", async () => {
    mockPolicy = { ...mockPolicy, research: "ask" };
    const item = createWorkItem({
      taskId,
      title: "Research something",
      requiredTools: JSON.stringify(["web_search"]),
    });
    const decision = await maybeAutoRunWorkItem(item.id);
    expect(decision).toEqual({ started: false, reason: "policy_ask" });
    expect(runnerCalls).toEqual([]);
  });
});

describe("triageWorkItem stamping (DB-backed)", () => {
  initializeDb();

  beforeEach(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
    taskId = createTask({ title: "Test task", template: "do it" }).id;
  });

  // Don't leak rows to a later test file sharing this `bun test` process.
  afterAll(() => {
    getDb().run("DELETE FROM work_items");
    getDb().run("DELETE FROM tasks");
  });

  test("stamps priorityTier and sortIndex on a queued item (heuristic path)", async () => {
    const item = createWorkItem({
      taskId,
      title: "File the expense report today — deadline",
    });
    await triageWorkItem(item.id, {});
    const fresh = getWorkItem(item.id)!;
    expect(fresh.sortIndex).not.toBeNull();
    expect(fresh.priorityTier).toBe(0); // "today"/"deadline" → high urgency
  });

  test("still blank-fills sortIndex when the item left 'queued' mid-triage, but leaves priority alone", async () => {
    // Reproduces the prod race: the item was created, then a manual flow
    // flipped it to running/awaiting_review within ~2s while the (slow) LLM
    // triage was still in flight — the item ended up with neither dueAt nor
    // sortIndex. Blank-fill fields must be stamped regardless of status.
    const item = createWorkItem({
      taskId,
      title: "Send the report",
      priorityTier: 2,
    });
    updateWorkItem(item.id, { status: "awaiting_review" });
    await triageWorkItem(item.id, {});
    const fresh = getWorkItem(item.id)!;
    expect(fresh.sortIndex).not.toBeNull();
    expect(fresh.priorityTier).toBe(2); // not re-scored once no longer queued
  });

  test("sender/channel provenance in notes bumps heuristic urgency (smaller sortIndex)", async () => {
    const withSender = createWorkItem({
      taskId,
      title: "Look into the login issue",
      notes: "From: Aileen Diaz via whatsapp — she can't get the code",
      sourceType: "whatsapp",
    });
    const selfNote = createWorkItem({
      taskId,
      title: "Look into the login issue",
    });
    await triageWorkItem(withSender.id, {});
    await triageWorkItem(selfNote.id, {});
    // Base heuristic urgency 50 → sortIndex 50; the sender bump (+15) ranks
    // the human-sourced item first within the tier.
    expect(getWorkItem(selfNote.id)!.sortIndex).toBe(50);
    expect(getWorkItem(withSender.id)!.sortIndex).toBe(35);
  });

  test("the sender bump caps at 100 urgency and stacks with high-urgency keywords", async () => {
    const item = createWorkItem({
      taskId,
      title: "Urgent: unblock the deploy",
      notes: "From: Marco via slack — blocked, deadline today",
      sourceType: "slack",
    });
    await triageWorkItem(item.id, {});
    // High-urgency base 85 + 15 bump = 100 → sortIndex 0.
    expect(getWorkItem(item.id)!.sortIndex).toBe(0);
    expect(getWorkItem(item.id)!.priorityTier).toBe(0);
  });

  test("never overwrites caller-provided sortIndex or priority (callerSetPriority)", async () => {
    const item = createWorkItem({
      taskId,
      title: "Whenever task — no rush",
      priorityTier: 0,
      sortIndex: 7,
    });
    await triageWorkItem(item.id, { callerSetPriority: true });
    const fresh = getWorkItem(item.id)!;
    expect(fresh.priorityTier).toBe(0);
    expect(fresh.sortIndex).toBe(7);
  });

  test("skips archived/cancelled items entirely", async () => {
    const item = createWorkItem({ taskId, title: "Old junk" });
    updateWorkItem(item.id, { status: "cancelled" });
    await triageWorkItem(item.id, {});
    expect(getWorkItem(item.id)!.sortIndex).toBeNull();
  });

  test("stamps source_context (origin + snippet) from the creating channel", async () => {
    const item = createWorkItem({
      taskId,
      title: "Reply to Aileen about the OTP",
      notes: "She DM'd asking for the login code",
      sourceType: "whatsapp",
      sourceId: "chat-42",
    });
    await triageWorkItem(item.id, {});
    const fresh = getWorkItem(item.id)!;
    expect(fresh.sourceContext).not.toBeNull();
    const parsed = JSON.parse(fresh.sourceContext!) as {
      origin: string;
      sourceId?: string;
      snippet: string;
    };
    expect(parsed.origin).toBe("whatsapp");
    expect(parsed.sourceId).toBe("chat-42");
    expect(parsed.snippet).toBe("She DM'd asking for the login code");
  });

  test("source_context defaults origin to 'chat' and uses the title when there are no notes", async () => {
    const item = createWorkItem({ taskId, title: "Draft the launch email" });
    await triageWorkItem(item.id, {});
    const parsed = JSON.parse(getWorkItem(item.id)!.sourceContext!) as {
      origin: string;
      snippet: string;
    };
    expect(parsed.origin).toBe("chat");
    expect(parsed.snippet).toBe("Draft the launch email");
  });

  test("never overwrites an existing source_context", async () => {
    const item = createWorkItem({
      taskId,
      title: "Task",
      sourceContext: JSON.stringify({ origin: "mcp", snippet: "pre-set" }),
    });
    await triageWorkItem(item.id, {});
    const parsed = JSON.parse(getWorkItem(item.id)!.sourceContext!) as {
      origin: string;
    };
    expect(parsed.origin).toBe("mcp");
  });
});

describe("buildSourceContext", () => {
  test("truncates a long snippet to 500 chars with an ellipsis", () => {
    const long = "x".repeat(600);
    const parsed = JSON.parse(
      buildSourceContext(makeItem({ title: "t", notes: long })),
    ) as { snippet: string };
    expect(parsed.snippet.endsWith("…")).toBe(true);
    expect(parsed.snippet.length).toBe(501); // 500 chars + ellipsis
  });
});

describe("parseTriageResponse", () => {
  const ids = new Set(["proj-1", "proj-2"]);

  test("accepts a valid project id and drops hallucinated ones", () => {
    const ok = parseTriageResponse(
      '{"urgency": 70, "tier": 1, "projectId": "proj-1", "dueAt": null}',
      ids,
    );
    expect(ok?.projectId).toBe("proj-1");
    const bad = parseTriageResponse(
      '{"urgency": 70, "tier": 1, "projectId": "made-up", "dueAt": null}',
      ids,
    );
    expect(bad?.projectId).toBeNull();
  });

  test("parses a local-ISO dueAt to epoch ms and rejects garbage + stale dates", () => {
    const now = Date.parse("2026-07-02T12:00");
    const future = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "2026-07-03T17:00"}',
      ids,
      now,
    );
    expect(future?.dueAt).toBe(Date.parse("2026-07-03T17:00"));
    const garbage = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "next friday-ish"}',
      ids,
      now,
    );
    expect(garbage?.dueAt).toBeNull();
    const stale = parseTriageResponse(
      '{"urgency": 80, "tier": 0, "projectId": null, "dueAt": "2026-06-20T17:00"}',
      ids,
      now,
    );
    expect(stale?.dueAt).toBeNull();
  });

  test("still parses plain urgency/tier responses (fields absent)", () => {
    const r = parseTriageResponse('{"urgency": 55, "tier": 1}', ids);
    expect(r).toEqual({ urgency: 55, tier: 1, projectId: null, dueAt: null });
  });

  test("clamps out-of-range values and rejects non-JSON", () => {
    const r = parseTriageResponse('{"urgency": 300, "tier": 9}', ids);
    expect(r).toEqual({ urgency: 100, tier: 2, projectId: null, dueAt: null });
    expect(parseTriageResponse("no json here", ids)).toBeNull();
  });
});
