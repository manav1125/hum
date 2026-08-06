/**
 * End-to-end tests for comprehension and grouping, driven through the REAL
 * intake function production runs — `fileWatcherEventsToCameIn` — with events
 * shaped exactly as the Gmail provider builds them, and every assertion read
 * back out of SQLite.
 *
 * Deliberately not a test of an extracted copy. A fix in this repo has already
 * shipped broken while its tests passed, because the test exercised a helper
 * rather than the code production runs. Everything here goes in the front
 * door: hand the engine's own arguments to intake, then read `work_items`,
 * `work_item_comprehension`, `arrival_group_members` and `arrivals` back.
 *
 * The `Watcher` / `WatcherEvent` arguments are built here rather than pulled
 * out of `watcher-store`, and that is not laziness. `engine.test.ts` and
 * `auto-provision.test.ts` install process-global `mock.module` factories over
 * `watcher-store.js` that replace `getPendingEvents`, `insertWatcherEvent` and
 * `createWatcher` for every later file in the run — so a store round-trip here
 * silently reads the ENGINE suite's fixtures instead of ours. These are the
 * exact objects the engine passes to intake, so the code under test is
 * identical; the store's own round-trip is covered by
 * `watcher-intake-relevance.test.ts`.
 *
 * Only the two network calls are injected — the relevance judge and the
 * comprehension extractor. Everything else is the real thing.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  type ArrivalExtractor,
  getComprehensionHealth,
  MAX_COMPREHEND_BATCH,
  type RawComprehension,
  resetComprehensionHealth,
} from "../../arrivals/arrival-comprehension.js";
import type { ArrivalJudge } from "../../arrivals/arrival-gate.js";
import {
  getGroupSummary,
  ungroupGroupMember,
} from "../../arrivals/arrival-grouping.js";
import { getArrival, listArrivals } from "../../arrivals/arrival-store.js";
import { getComprehension } from "../../arrivals/comprehension-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  listWorkItems,
  updateWorkItem,
} from "../../work-items/work-item-store.js";
import { fileWatcherEventsToCameIn } from "../watcher-intake.js";
import type { Watcher, WatcherEvent } from "../watcher-store.js";

initializeDb();

const WATCHER_ID = "watcher-gmail-test";

/** The watcher row the engine would have claimed. */
const watcher: Watcher = {
  id: WATCHER_ID,
  name: "Gmail",
  providerId: "gmail",
  enabled: true,
  pollIntervalMs: 60_000,
  actionPrompt: "watch the inbox",
  watermark: null,
  conversationId: null,
  status: "idle",
  consecutiveErrors: 0,
  lastError: null,
  lastPollAt: null,
  nextPollAt: 0,
  configJson: null,
  credentialService: "google",
  intakeMode: "came_in",
  createdAt: 0,
  updatedAt: 0,
};

/** Events waiting for the next poll, drained by {@link runIntake}. */
let pending: WatcherEvent[] = [];
let eventSeq = 0;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM work_item_comprehension");
  db.run("DELETE FROM arrival_group_members");
  db.run("DELETE FROM arrivals");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM watcher_events");
  db.run("DELETE FROM watchers");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM missions");
  db.run("DELETE FROM projects");
  resetComprehensionHealth();
  pending = [];
  eventSeq = 0;
});

interface MailFixture {
  externalId: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet?: string;
  inReplyTo?: string;
}

/**
 * Queue a Gmail-shaped watcher event exactly as the provider builds it —
 * including the `threadId` the provider now records, which is the fact thread
 * grouping is built on.
 */
function arrive(mail: MailFixture): void {
  pending.push({
    id: `event-${++eventSeq}`,
    watcherId: watcher.id,
    externalId: mail.externalId,
    eventType: "new_email",
    occurredAt: null,
    summary: `Email from ${mail.from}: ${mail.subject}`,
    disposition: "pending",
    llmAction: null,
    processedAt: null,
    createdAt: Date.now(),
    payloadJson: JSON.stringify({
      id: mail.externalId,
      threadId: mail.threadId ?? `t-${mail.externalId}`,
      from: mail.from,
      subject: mail.subject,
      snippet: mail.snippet ?? "",
      labelIds: ["INBOX"],
      // Direct to the owner with no bulk headers: the safety floor surfaces
      // these without spending a judge call, which keeps these tests about
      // comprehension rather than about the gate.
      to: "user@example.com",
      cc: "",
      listUnsubscribe: "",
      listId: "",
      precedence: "",
      autoSubmitted: "",
      inReplyTo: mail.inReplyTo ?? "",
      references: "",
      toMe: true,
      ccMe: false,
    }),
  });
}

/** A judge that keeps everything — the gate is not what these tests exercise. */
const keepEverything: ArrivalJudge = async (items) =>
  items.map((i) => ({
    externalId: i.externalId,
    keep: true,
    reason: "kept for the test",
    confidence: 0.9,
  }));

/** An extractor driven by a lookup on the item's current title. */
function extractorFor(
  answers: Array<Partial<RawComprehension> & { match: string }>,
): ArrivalExtractor & { calls: number; batchSizes: number[] } {
  const extractor = async (candidates: Parameters<ArrivalExtractor>[0]) => {
    extractor.calls += 1;
    extractor.batchSizes.push(candidates.length);
    const out: RawComprehension[] = [];
    for (const candidate of candidates) {
      const answer = answers.find((a) => candidate.title.includes(a.match));
      if (!answer) continue;
      const { match: _match, ...rest } = answer;
      out.push({ ...rest, workItemId: candidate.workItemId });
    }
    return out;
  };
  extractor.calls = 0;
  extractor.batchSizes = [] as number[];
  return extractor as ArrivalExtractor & {
    calls: number;
    batchSizes: number[];
  };
}

/**
 * Run the real intake over everything queued since the last call, then drain
 * the queue — the engine stamps each event's disposition after intake, so a
 * later poll only ever sees genuinely new events. Tests that poll twice depend
 * on that, because the second message in a thread arrives on a later poll.
 */
async function runIntake(opts: {
  extractor?: ArrivalExtractor;
  judge?: ArrivalJudge;
  now?: number;
}) {
  const batch = pending;
  pending = [];
  return fileWatcherEventsToCameIn(watcher, batch, {
    judge: opts.judge ?? keepEverything,
    ...(opts.extractor ? { extractor: opts.extractor } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

const NOW = Date.UTC(2026, 7, 2);

// ---------------------------------------------------------------------------
// An arrival becomes a task
// ---------------------------------------------------------------------------

describe("an arrival becomes a task, not a relabelled email", () => {
  test("a real obligation gets a verb-phrase title and its real deadline", async () => {
    arrive({
      externalId: "m-cipa",
      from: "CIPA <registrar@example.org>",
      subject:
        "2026 Annual Return Due for Brinc Innovation Africa (First Reminder)",
      snippet:
        "The annual return for Brinc Innovation Africa must be filed by 30 September 2026. A late fee of BWP 250.00 applies after that date.",
    });

    await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Annual Return",
          task: "Renew Brinc Innovation Africa's annual return",
          confidence: 0.92,
          dueDate: "2026-09-30",
          dueQuote: "filed by 30 September 2026",
          amount: "BWP 250.00",
          amountQuote: "BWP 250.00",
          askedBy: "CIPA",
          decision: "whether to file now or pay the late fee",
        },
      ]),
    });

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    const item = items[0];

    // The title says what the owner must DO.
    expect(item.title).toBe("Renew Brinc Innovation Africa's annual return");
    expect(item.title.startsWith("Email from")).toBe(false);
    expect(item.dueAt).toBe(Date.UTC(2026, 8, 30, 23, 59, 59, 999));

    // The structured reading is queryable, not buried in prose.
    const comprehension = getComprehension(item.id)!;
    expect(comprehension.status).toBe("comprehended");
    expect(comprehension.amountText).toBe("BWP 250.00");
    expect(comprehension.askedBy).toBe("CIPA");
    expect(comprehension.decisionNeeded).toBe(
      "whether to file now or pay the late fee",
    );
    expect(comprehension.dueQuote).toBe("filed by 30 September 2026");

    // Provenance survives: the sender, the original title, and the raw
    // arrival are all still reachable.
    expect(comprehension.originalTitle).toContain("Email from CIPA");
    const arrival = getArrival(comprehension.arrivalId!)!;
    expect(arrival.senderAddress).toBe("registrar@example.org");
    expect(arrival.title).toContain("Email from CIPA");
    expect(item.sourceContext).toContain("watcher:gmail");
    expect(item.sourceId).toBe("m-cipa");
  });

  test("a message with no deadline gets NO deadline", async () => {
    arrive({
      externalId: "m-intro",
      from: "Jane Doe <jane@example.com>",
      subject: "Intro to the Lagos team",
      snippet: "Happy to make the intro whenever you are ready.",
    });

    await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Intro to the Lagos team",
          task: "Reply to Jane about the Lagos intro",
          confidence: 0.85,
          // No deadline in the message, so none in the answer.
          dueDate: null,
          dueQuote: null,
        },
      ]),
    });

    const item = listWorkItems()[0];
    expect(item.title).toBe("Reply to Jane about the Lagos intro");
    expect(item.dueAt).toBeNull();
    const comprehension = getComprehension(item.id)!;
    expect(comprehension.dueAt).toBeNull();
    expect(comprehension.dueQuote).toBeNull();
  });

  test("NEVER INVENT: an ungrounded deadline is refused, even confidently asserted", async () => {
    // MUTATION CHECK. This test is the reason `isGroundedIn` exists. Make the
    // extractor emit a default due date — as this one does, with a quote that
    // appears nowhere in the message — and the deadline must still be null. If
    // `isGroundedIn` is deleted or made to return true, this fails.
    arrive({
      externalId: "m-invoice",
      from: "Accounts <accounts@example.com>",
      subject: "Invoice 4471",
      snippet: "Please find invoice 4471 attached for your records.",
    });

    await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Invoice 4471",
          task: "Pay invoice 4471",
          confidence: 0.99,
          dueDate: "2026-08-16",
          dueQuote: "payment due within 14 days",
        },
      ]),
    });

    const item = listWorkItems()[0];
    // The title is fine — it is a real action and it was allowed through.
    expect(item.title).toBe("Pay invoice 4471");
    // The date was not in the message, so it does not exist.
    expect(item.dueAt).toBeNull();
    expect(getComprehension(item.id)!.dueAt).toBeNull();
  });

  test("comprehension failure keeps the existing title and SAYS so", async () => {
    arrive({
      externalId: "m-opaque",
      from: "Ops <ops@example.com>",
      subject: "Following up",
      snippet: "As discussed.",
    });

    // The extractor returns nothing at all — an outage, a timeout, a garbled
    // reply. All three look like this.
    const dead: ArrivalExtractor = async () => null;
    await runIntake({ now: NOW, extractor: dead });

    const item = listWorkItems()[0];
    expect(item.title).toBe("Email from Ops <ops@example.com>: Following up");

    const comprehension = getComprehension(item.id)!;
    // The failure is a ROW, not an absence — a client can tell "Cue read this
    // and kept the subject line" from "Cue never got to it".
    expect(comprehension.status).toBe("failed");
    expect(comprehension.actionTitle).toBeNull();
    expect(comprehension.note).toBeTruthy();
  });

  test("a low-confidence reading leaves the title alone and is recorded as such", async () => {
    arrive({
      externalId: "m-vague",
      from: "Ops <ops@example.com>",
      subject: "Quick one",
      snippet: "See below.",
    });

    await runIntake({
      now: NOW,
      extractor: extractorFor([
        { match: "Quick one", task: "Do the thing", confidence: 0.1 },
      ]),
    });

    // A low-confidence reading is Cue admitting it read the message and could
    // not tell what it needs, so the item is no longer a task — it lives in
    // arrivals as the `⌗` state. It is relocated, not lost, so it is still
    // there when explicitly asked for, still carrying its original subject.
    expect(listWorkItems()).toHaveLength(0);

    const item = listWorkItems({ includeUnComprehended: true })[0]!;
    expect(item.title).toContain("Email from Ops");
    expect(getComprehension(item.id)!.status).toBe("low_confidence");
  });

  test("one batched call for the whole poll, whatever arrives", async () => {
    // Deliberately under the cap, so this asserts the batching invariant
    // ("one call per poll") and not the cap's current value — which moved
    // from 8 to 4 when a full batch stopped fitting in the deadline.
    const arrived = MAX_COMPREHEND_BATCH - 1;
    for (let i = 0; i < arrived; i++) {
      arrive({
        externalId: `m-batch-${i}`,
        from: `Person ${i} <p${i}@example.com>`,
        subject: `Subject ${i}`,
      });
    }
    const extractor = extractorFor([]);
    await runIntake({ now: NOW, extractor });

    expect(extractor.calls).toBe(1);
    expect(extractor.batchSizes).toEqual([arrived]);
  });

  test("more than the cap still makes ONE call, and the rest is recorded", async () => {
    // The cap is what bounds a single call's wall-clock, so it has to hold
    // however much arrives at once — and the overflow must be visible as
    // "not looked at yet" rather than silently dropped or quietly failed.
    for (let i = 0; i < MAX_COMPREHEND_BATCH + 3; i++) {
      arrive({
        externalId: `m-over-${i}`,
        from: `Person ${i} <p${i}@example.com>`,
        subject: `Subject ${i}`,
      });
    }
    const extractor = extractorFor([]);
    await runIntake({ now: NOW, extractor });

    expect(extractor.calls).toBe(1);
    expect(extractor.batchSizes).toEqual([MAX_COMPREHEND_BATCH]);

    const skipped = listWorkItems({ includeUnComprehended: true }).filter(
      (i) => getComprehension(i.id)?.status === "skipped",
    );
    expect(skipped).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe("grouping what is the same thing", () => {
  test("two messages in one thread become ONE work item", async () => {
    arrive({
      externalId: "m-lease-1",
      threadId: "thread-lease",
      from: "Jane Doe <jane@example.com>",
      subject: "Lease renewal",
      snippet: "Are we renewing the Kowloon lease?",
    });
    await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Lease renewal",
          task: "Decide whether to renew the Kowloon lease",
          confidence: 0.9,
        },
      ]),
    });
    expect(listWorkItems()).toHaveLength(1);

    // The reply lands on a later poll, as replies do.
    arrive({
      externalId: "m-lease-2",
      threadId: "thread-lease",
      from: "Jane Doe <jane@example.com>",
      subject: "Re: Lease renewal",
      snippet: "The landlord wants an answer this week.",
      inReplyTo: "m-lease-1",
    });
    const dispositions = await runIntake({
      now: NOW,
      extractor: extractorFor([]),
    });

    expect([...dispositions.values()]).toEqual(["grouped"]);
    const items = listWorkItems();
    expect(items).toHaveLength(1);
    // The reply did not overwrite what the item is about.
    expect(items[0].title).toBe("Decide whether to renew the Kowloon lease");

    const group = getGroupSummary(items[0].id);
    expect(group.count).toBe(2);
    expect(group.groupKind).toBe("thread");
    expect(group.members.map((m) => m.externalId)).toEqual([
      "m-lease-1",
      "m-lease-2",
    ]);

    // Nothing was destroyed: BOTH messages are still full arrival rows.
    expect(listArrivals({ limit: 50 })).toHaveLength(2);
  });

  test("fifteen notifications from one sender collapse to one item with a count", async () => {
    for (let i = 1; i <= 15; i++) {
      arrive({
        externalId: `m-za-${i}`,
        // Robots open a fresh thread per alert — thread id groups nothing here.
        threadId: `thread-za-${i}`,
        from: "ZA Bank <no-reply@example.org>",
        subject: `Transaction alert ${i}`,
        snippet: `Card ending 4471 was used for HKD ${i}0.00.`,
      });
    }

    const dispositions = await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Transaction alert 1",
          task: "Review the ZA Bank card alerts",
          confidence: 0.8,
        },
      ]),
    });

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(
      [...dispositions.values()].filter((d) => d === "grouped"),
    ).toHaveLength(14);

    const group = getGroupSummary(items[0].id);
    expect(group.count).toBe(15);
    expect(group.groupKind).toBe("sender");
    // Every one of the fifteen is still recorded and still readable.
    expect(group.members).toHaveLength(15);
    expect(listArrivals({ limit: 50 })).toHaveLength(15);
  });

  test("two different people are never grouped, and neither are two topics", async () => {
    arrive({
      externalId: "m-a",
      from: "Jane Doe <jane@example.com>",
      subject: "Annual return for Brinc Africa",
    });
    arrive({
      externalId: "m-b",
      from: "John Roe <john@example.com>",
      subject: "Annual return for Brinc Asia",
    });

    await runIntake({ now: NOW, extractor: extractorFor([]) });

    // Same words, two senders, two threads: two obligations. Merging these is
    // the failure this pass deliberately refuses to risk.
    expect(listWorkItems()).toHaveLength(2);
  });

  test("a group does not swallow messages once the item is finished", async () => {
    arrive({
      externalId: "m-za-old",
      from: "ZA Bank <no-reply@example.org>",
      subject: "Transaction alert",
    });
    await runIntake({ now: NOW, extractor: extractorFor([]) });
    const first = listWorkItems()[0];
    updateWorkItem(first.id, { status: "done" }, { actor: "user" });

    arrive({
      externalId: "m-za-new",
      from: "ZA Bank <no-reply@example.org>",
      subject: "Transaction alert",
    });
    await runIntake({ now: NOW, extractor: extractorFor([]) });

    // A new alert after the owner dealt with the last one is a new thing to
    // look at — folding it into a done item would hide it.
    expect(listWorkItems()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Reversibility
// ---------------------------------------------------------------------------

describe("grouping is reversible and nothing is destroyed", () => {
  test("ungrouping restores the original as its own work item", async () => {
    arrive({
      externalId: "m-thread-1",
      threadId: "thread-x",
      from: "Jane Doe <jane@example.com>",
      subject: "Contract",
      snippet: "First message.",
    });
    arrive({
      externalId: "m-thread-2",
      threadId: "thread-x",
      from: "Jane Doe <jane@example.com>",
      subject: "Re: Contract",
      snippet: "Second message.",
      inReplyTo: "m-thread-1",
    });
    await runIntake({ now: NOW, extractor: extractorFor([]) });

    const anchorItem = listWorkItems()[0];
    const group = getGroupSummary(anchorItem.id);
    expect(group.count).toBe(2);

    const folded = group.members.find((m) => m.isAnchor === 0)!;
    const result = ungroupGroupMember(folded.id, { getArrival, actor: "user" });
    expect(result.status).toBe("ungrouped");

    // It came back as a normal work item, titled with what actually arrived.
    const items = listWorkItems();
    expect(items).toHaveLength(2);
    const restored = items.find((i) => i.sourceId === "m-thread-2")!;
    expect(restored.title).toContain("Re: Contract");
    expect(restored.arrivalId).toBe(folded.arrivalId);

    // The arrival now points at the item it became…
    expect(getArrival(folded.arrivalId)!.workItemId).toBe(restored.id);
    // …and the merge is still on the record rather than tidied away.
    const after = getGroupSummary(anchorItem.id);
    expect(after.count).toBe(1);
    expect(after.members).toHaveLength(2);
    const detached = after.members.find((m) => m.id === folded.id)!;
    expect(detached.detachedAt).not.toBeNull();
    expect(detached.detachedBy).toBe("user");
    expect(detached.detachedWorkItemId).toBe(restored.id);
  });

  test("the anchor cannot be split out of itself, and nothing changes when you try", async () => {
    arrive({
      externalId: "m-solo",
      from: "Jane Doe <jane@example.com>",
      subject: "Just one",
    });
    await runIntake({ now: NOW, extractor: extractorFor([]) });

    const item = listWorkItems()[0];
    const anchor = getGroupSummary(item.id).members[0];
    const result = ungroupGroupMember(anchor.id, { getArrival });

    expect(result.status).toBe("is_anchor");
    expect(listWorkItems()).toHaveLength(1);
    expect(getGroupSummary(item.id).count).toBe(1);
  });

  test("splitting the same message twice is refused rather than duplicating it", async () => {
    arrive({
      externalId: "m-dup-1",
      threadId: "thread-dup",
      from: "Jane Doe <jane@example.com>",
      subject: "Dup",
    });
    arrive({
      externalId: "m-dup-2",
      threadId: "thread-dup",
      from: "Jane Doe <jane@example.com>",
      subject: "Re: Dup",
      inReplyTo: "m-dup-1",
    });
    await runIntake({ now: NOW, extractor: extractorFor([]) });

    const anchorItem = listWorkItems()[0];
    const folded = getGroupSummary(anchorItem.id).members.find(
      (m) => m.isAnchor === 0,
    )!;

    expect(ungroupGroupMember(folded.id, { getArrival }).status).toBe(
      "ungrouped",
    );
    expect(ungroupGroupMember(folded.id, { getArrival }).status).toBe(
      "already_detached",
    );
    expect(listWorkItems()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

describe("a pass that does nothing has to say so", () => {
  test("the barren-batch streak counts up, and a productive batch clears it", async () => {
    const dead: ArrivalExtractor = async () => null;

    for (let i = 0; i < 3; i++) {
      arrive({
        externalId: `m-dead-${i}`,
        from: `Person ${i} <p${i}@example.com>`,
        subject: `Nothing ${i}`,
      });
      await runIntake({ now: NOW, extractor: dead });
    }

    const barren = getComprehensionHealth();
    expect(barren.consecutiveUnproductiveBatches).toBe(3);
    expect(barren.totalComprehended).toBe(0);
    expect(barren.lastBatchCandidates).toBe(1);

    arrive({
      externalId: "m-alive",
      from: "Jane Doe <jane@example.com>",
      subject: "Sign the lease",
    });
    await runIntake({
      now: NOW,
      extractor: extractorFor([
        {
          match: "Sign the lease",
          task: "Sign the Kowloon lease and return it",
          confidence: 0.9,
        },
      ]),
    });

    const healthy = getComprehensionHealth();
    expect(healthy.consecutiveUnproductiveBatches).toBe(0);
    expect(healthy.totalComprehended).toBe(1);
  });
});
