/**
 * End-to-end tests for the relevance gate, driven through the REAL intake
 * function production runs — `fileWatcherEventsToCameIn` — with real watcher
 * rows, real watcher events, and assertions against the database rows that
 * result.
 *
 * This is deliberately not a test of an extracted copy of the logic. A
 * previous fix in this repo passed its tests while being completely broken,
 * because the test exercised a helper rather than the code production runs.
 * Everything here goes in the front door: create a watcher, insert events,
 * pull the pending batch out of the store, hand it to intake, then read
 * `arrivals` and `work_items` back out of SQLite.
 *
 * Only the LLM judge is injected — that is a network call, not logic.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  applySafetyFloor,
  type ArrivalJudge,
  type FloorContext,
  type JudgeVerdict,
} from "../../arrivals/arrival-gate.js";
import { buildArrivalSignals } from "../../arrivals/arrival-signals.js";
import {
  getArrivalsSummary,
  listArrivals,
  markArrivalReversed,
} from "../../arrivals/arrival-store.js";
import { createWorkItemForArrival } from "../../arrivals/arrival-surface.js";
import { upsertContact } from "../../contacts/contact-store.js";
import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { createMission } from "../../missions/mission-store.js";
import { listWorkItems } from "../../work-items/work-item-store.js";
import { fileWatcherEventsToCameIn } from "../watcher-intake.js";
import {
  createWatcher,
  getPendingEvents,
  insertWatcherEvent,
  listWatcherEvents,
  type Watcher,
} from "../watcher-store.js";

initializeDb();

let watcher: Watcher;

beforeEach(() => {
  const db = getDb();
  db.run("DELETE FROM arrivals");
  db.run("DELETE FROM work_items");
  db.run("DELETE FROM tasks");
  db.run("DELETE FROM watcher_events");
  db.run("DELETE FROM watchers");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM missions");
  db.run("DELETE FROM projects");
  watcher = createWatcher({
    name: "Gmail",
    providerId: "gmail",
    actionPrompt: "watch the inbox",
    credentialService: "google",
  });
});

interface MailFixture {
  externalId: string;
  from: string;
  subject: string;
  snippet?: string;
  listUnsubscribe?: string;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  inReplyTo?: string;
  toMe?: boolean;
  ccMe?: boolean;
  userParticipatedInThread?: boolean;
}

/** Insert a Gmail-shaped watcher event exactly as the provider would. */
function arrive(mail: MailFixture): void {
  const inserted = insertWatcherEvent({
    watcherId: watcher.id,
    externalId: mail.externalId,
    eventType: "new_email",
    summary: `Email from ${mail.from}: ${mail.subject}`,
    payloadJson: JSON.stringify({
      id: mail.externalId,
      threadId: `t-${mail.externalId}`,
      from: mail.from,
      subject: mail.subject,
      snippet: mail.snippet ?? "",
      labelIds: ["INBOX"],
      to: mail.toMe ? "user@example.com" : "list@example.net",
      cc: mail.ccMe ? "user@example.com" : "",
      listUnsubscribe: mail.listUnsubscribe ?? "",
      listId: mail.listId ?? "",
      precedence: mail.precedence ?? "",
      autoSubmitted: mail.autoSubmitted ?? "",
      inReplyTo: mail.inReplyTo ?? "",
      references: "",
      toMe: mail.toMe ?? false,
      ccMe: mail.ccMe ?? false,
      ...(mail.userParticipatedInThread !== undefined
        ? { userParticipatedInThread: mail.userParticipatedInThread }
        : {}),
    }),
  });
  expect(inserted).toBe(true);
}

/** A judge that returns the same verdict for everything it is shown. */
function fixedJudge(
  keep: boolean,
  reason = "a fixed verdict",
): ArrivalJudge & { calls: number } {
  const judge = async (items: Parameters<ArrivalJudge>[0]) => {
    judge.calls += 1;
    return items.map(
      (i): JudgeVerdict => ({
        externalId: i.externalId,
        keep,
        reason,
        confidence: 0.9,
      }),
    );
  };
  judge.calls = 0;
  return judge as ArrivalJudge & { calls: number };
}

/** Run the real intake over everything currently pending. */
async function runIntake(opts: {
  judge?: ArrivalJudge;
  floorContext?: FloorContext;
}) {
  const pending = getPendingEvents(watcher.id);
  return fileWatcherEventsToCameIn(watcher, pending, opts);
}

function arrivalFor(externalId: string) {
  const row = listArrivals({ limit: 200 }).find(
    (a) => a.externalId === externalId,
  );
  expect(row).toBeDefined();
  return row!;
}

describe("bulk headers file deterministically, without a model call", () => {
  test("List-Unsubscribe files with a reason in the owner's words", async () => {
    arrive({
      externalId: "m-news",
      from: "Stripe <news@example.org>",
      subject: "Your weekly Stripe digest",
      listUnsubscribe: "<https://stripe.com/unsub>",
    });
    const judge = fixedJudge(true);

    const dispositions = await runIntake({ judge });

    expect([...dispositions.values()]).toEqual(["filed"]);
    // The judge was never consulted — the obvious cases are deterministic.
    expect(judge.calls).toBe(0);

    const arrival = arrivalFor("m-news");
    expect(arrival.disposition).toBe("filed");
    expect(arrival.reason).toBe("newsletter from Stripe");
    expect(arrival.decidedBy).toBe("rule");
    expect(arrival.ruleId).toBe("list_mail");
    expect(arrival.senderAddress).toBe("news@example.org");
    expect(arrival.workItemId).toBeNull();

    // Nothing entered the lane.
    expect(listWorkItems()).toEqual([]);
  });

  test("Precedence: bulk and Auto-Submitted file too", async () => {
    arrive({
      externalId: "m-bulk",
      from: "blast@example.net",
      subject: "50% off",
      precedence: "bulk",
    });
    arrive({
      externalId: "m-ci",
      from: "notifications@example.net",
      subject: "Build #4412 failed",
      autoSubmitted: "auto-generated",
    });

    await runIntake({ judge: fixedJudge(true) });

    expect(arrivalFor("m-bulk").ruleId).toBe("precedence_bulk");
    expect(arrivalFor("m-ci").ruleId).toBe("auto_submitted");
    expect(arrivalFor("m-ci").reason).toBe(
      "automated notification from example.net",
    );
    expect(listWorkItems()).toEqual([]);
  });
});

describe("the safety floor beats every other layer", () => {
  test("a known contact surfaces even when the model says file", async () => {
    upsertContact({
      displayName: "Jane Doe",
      channels: [{ type: "email", address: "jane@example.com" }],
    });
    arrive({
      externalId: "m-jane",
      from: "Jane Doe <jane@example.com>",
      subject: "quick question",
    });

    // The model is emphatic that this is junk. It does not get to decide.
    await runIntake({ judge: fixedJudge(false, "looks like marketing") });

    const arrival = arrivalFor("m-jane");
    expect(arrival.disposition).toBe("surfaced");
    expect(arrival.decidedBy).toBe("rule");
    expect(arrival.ruleId).toBe("known_contact");
    expect(arrival.reason).toBe("from Jane Doe, who is in your contacts");

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].arrivalId).toBe(arrival.id);
    expect(items[0].autoRunEligibility).toBe("parked");
  });

  test("a known contact surfaces even when a bulk header says file", async () => {
    upsertContact({
      displayName: "Jane Doe",
      channels: [{ type: "email", address: "jane@example.com" }],
    });
    arrive({
      externalId: "m-jane-list",
      from: "Jane Doe <jane@example.com>",
      subject: "fwd: the eng list thread",
      listUnsubscribe: "<https://lists.example.com/unsub>",
    });

    await runIntake({ judge: fixedJudge(false) });

    const arrival = arrivalFor("m-jane-list");
    expect(arrival.disposition).toBe("surfaced");
    // Routed through the floor override, so the provenance says so.
    expect(arrival.decidedBy).toBe("floor");
    expect(arrival.ruleId).toBe("known_contact");
    expect(listWorkItems()).toHaveLength(1);
  });

  test("a reply in a thread the owner is part of surfaces", async () => {
    arrive({
      externalId: "m-reply",
      from: "someone@example.org",
      subject: "Re: the contract",
      inReplyTo: "<abc@partner.com>",
      userParticipatedInThread: true,
    });

    await runIntake({ judge: fixedJudge(false, "cold outreach") });

    const arrival = arrivalFor("m-reply");
    expect(arrival.disposition).toBe("surfaced");
    expect(arrival.ruleId).toBe("thread_participant");
    expect(listWorkItems()).toHaveLength(1);
  });

  test("an active mission named in the subject surfaces", async () => {
    createMission({ title: "Orbit launch", outcome: "ship it" });
    arrive({
      externalId: "m-mission",
      from: "stranger@example.net",
      subject: "notes on the Orbit launch",
    });

    await runIntake({ judge: fixedJudge(false) });

    const arrival = arrivalFor("m-mission");
    expect(arrival.disposition).toBe("surfaced");
    expect(arrival.ruleId).toBe("named_work");
    expect(arrival.reason).toBe('mentions your mission "Orbit launch"');
  });

  test("a direct To: from a human surfaces", async () => {
    arrive({
      externalId: "m-direct",
      from: "newperson@example.org",
      subject: "intro",
      toMe: true,
    });

    await runIntake({ judge: fixedJudge(false, "cold outreach") });

    const arrival = arrivalFor("m-direct");
    expect(arrival.disposition).toBe("surfaced");
    expect(arrival.ruleId).toBe("direct_human");
    expect(listWorkItems()).toHaveLength(1);
  });

  /**
   * The mutation check. `applySafetyFloor` is the safety floor's whole
   * implementation; if its known-contact branch stops firing, THIS assertion
   * is what fails. The simulation below reproduces the exact mutation
   * (drop the contact lookup) and proves the floor is what was protecting the
   * message — not the rules, not the model, not luck.
   */
  test("MUTATION: breaking the known-contact guard files a real person's mail", () => {
    const from = "Jane Doe <jane@example.com>";
    const contactCtx: FloorContext = {
      lookupContact: (a) => (a === "jane@example.com" ? "Jane Doe" : null),
      namedWork: [],
    };
    const brokenCtx: FloorContext = {
      lookupContact: () => null,
      namedWork: [],
    };
    const mail = {
      channel: "watcher:gmail",
      externalId: "m-mut",
      title: "quick question",
      summary: "s",
      payloadJson: JSON.stringify({ from, listUnsubscribe: "<https://u>" }),
    };
    const s = buildArrivalSignals(mail);

    // Intact: the floor protects her.
    expect(applySafetyFloor(s, contactCtx)?.ruleId).toBe("known_contact");
    // Mutated: nothing protects her, and the bulk rule's filing would stand.
    expect(applySafetyFloor(s, brokenCtx)).toBeNull();
  });
});

describe("failures surface, never swallow", () => {
  test("a judge that throws surfaces every ambiguous item", async () => {
    arrive({
      externalId: "m-err",
      from: "unknown@example.net",
      subject: "who knows",
    });

    const exploding: ArrivalJudge = async () => {
      throw new Error("provider is down");
    };
    await runIntake({ judge: exploding });

    const arrival = arrivalFor("m-err");
    expect(arrival.disposition).toBe("surfaced");
    expect(arrival.decidedBy).toBe("fallback");
    expect(arrival.reason).toBe(
      "Cue could not judge this one, so it kept it for you",
    );
    expect(listWorkItems()).toHaveLength(1);
  });

  test("a judge that returns nothing surfaces every ambiguous item", async () => {
    arrive({ externalId: "m-null", from: "a@example.org", subject: "hmm" });
    await runIntake({ judge: async () => null });
    expect(arrivalFor("m-null").disposition).toBe("surfaced");
    expect(listWorkItems()).toHaveLength(1);
  });

  test("a judge that skips an item surfaces it", async () => {
    arrive({ externalId: "m-a", from: "a@example.org", subject: "one" });
    arrive({ externalId: "m-b", from: "c@example.net", subject: "two" });
    await runIntake({
      judge: async () => [
        {
          externalId: "m-a",
          keep: false,
          reason: "newsletter from example.org",
          confidence: 0.9,
        },
      ],
    });
    expect(arrivalFor("m-a").disposition).toBe("filed");
    expect(arrivalFor("m-b").disposition).toBe("surfaced");
    expect(arrivalFor("m-b").decidedBy).toBe("fallback");
  });
});

describe("the model decides the ambiguous middle", () => {
  test("a 'file' verdict keeps it out of the lane, with its reason", async () => {
    arrive({
      externalId: "m-mid",
      from: "Acme Deals <deals@acme.io>",
      subject: "Last chance",
    });

    await runIntake({ judge: fixedJudge(false, "marketing blast from Acme") });

    const arrival = arrivalFor("m-mid");
    expect(arrival.disposition).toBe("filed");
    expect(arrival.decidedBy).toBe("model");
    expect(arrival.reason).toBe("marketing blast from Acme");
    expect(arrival.confidence).toBeCloseTo(0.9);
    expect(listWorkItems()).toEqual([]);
  });

  test("a 'keep' verdict becomes a normal parked Came-in item", async () => {
    arrive({
      externalId: "m-keep",
      from: "lawyer@example.org",
      subject: "signature needed today",
    });

    await runIntake({
      judge: fixedJudge(true, "a signature is being asked of you"),
    });

    const arrival = arrivalFor("m-keep");
    expect(arrival.disposition).toBe("surfaced");
    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].sourceType).toBe("watcher:gmail");
    expect(items[0].sourceId).toBe("m-keep");
    expect(items[0].arrivalId).toBe(arrival.id);
  });
});

describe("filed items are absent from the lane but never gone", () => {
  test("the default work-item list query returns no filed arrivals", async () => {
    for (let i = 0; i < 5; i++) {
      arrive({
        externalId: `noise-${i}`,
        from: `list${i}@example.net`,
        subject: `Digest ${i}`,
        listId: "<news.io>",
      });
    }
    arrive({
      externalId: "real",
      from: "boss@example.org",
      subject: "budget sign-off",
      toMe: true,
    });

    await runIntake({ judge: fixedJudge(false) });

    // The lane holds exactly the one thing that mattered.
    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].sourceId).toBe("real");
    expect(listWorkItems({ status: "queued" })).toHaveLength(1);

    // …and everything else is still on record, with reasons.
    const filed = listArrivals({ disposition: "filed" });
    expect(filed).toHaveLength(5);
    for (const row of filed) {
      expect(row.reason).toBeTruthy();
      expect(row.reason).toContain("newsletter from");
    }
  });

  test("nothing is deleted: every raw event and every arrival persists", async () => {
    arrive({
      externalId: "gone",
      from: "spam@example.net",
      subject: "buy now",
      listUnsubscribe: "<https://u>",
    });

    await runIntake({ judge: fixedJudge(false) });

    // The arrival row survives.
    expect(listArrivals({ limit: 200 })).toHaveLength(1);
    // The raw watcher event survives too — filed is a disposition, not a purge.
    const events = listWatcherEvents({ watcherId: watcher.id, limit: 50 });
    expect(events).toHaveLength(1);
    expect(events[0].externalId).toBe("gone");
  });
});

describe("reversal", () => {
  test("a reversed filing becomes a normal lane item and records the correction", async () => {
    arrive({
      externalId: "m-rev",
      from: "Stripe <news@example.org>",
      subject: "Your invoice is ready",
      listUnsubscribe: "<https://stripe.com/unsub>",
    });
    await runIntake({ judge: fixedJudge(false) });

    const filed = arrivalFor("m-rev");
    expect(filed.disposition).toBe("filed");
    expect(listWorkItems()).toEqual([]);

    // The reversal path the route runs.
    const workItem = createWorkItemForArrival(filed, { actor: "user" });
    const reversed = markArrivalReversed(filed.id, workItem.id, "user");

    expect(reversed?.disposition).toBe("surfaced");
    expect(reversed?.workItemId).toBe(workItem.id);
    expect(reversed?.reversedAt).toBeGreaterThan(0);
    expect(reversed?.reversedBy).toBe("user");
    // The ORIGINAL decision is preserved — that record is the training signal.
    expect(reversed?.reason).toBe("newsletter from Stripe");
    expect(reversed?.ruleId).toBe("list_mail");
    expect(reversed?.decidedBy).toBe("rule");

    const items = listWorkItems();
    expect(items).toHaveLength(1);
    expect(items[0].arrivalId).toBe(filed.id);
    expect(items[0].sourceId).toBe("m-rev");
    expect(items[0].autoRunEligibility).toBe("parked");
  });
});

describe("the census", () => {
  test("arrived = filed + kept, and kept counts what Cue decided you need", async () => {
    upsertContact({
      displayName: "Jane Doe",
      channels: [{ type: "email", address: "jane@example.com" }],
    });
    arrive({
      externalId: "c-1",
      from: "n@example.net",
      subject: "Digest",
      listId: "<news.io>",
    });
    arrive({
      externalId: "c-2",
      from: "ci@example.net",
      subject: "Build failed",
      autoSubmitted: "auto-generated",
    });
    arrive({
      externalId: "c-3",
      from: "Jane Doe <jane@example.com>",
      subject: "lunch?",
    });

    await runIntake({ judge: fixedJudge(false) });

    const summary = getArrivalsSummary({ windowHours: 24 });
    expect(summary.arrived).toBe(3);
    expect(summary.filed).toBe(2);
    expect(summary.kept).toBe(1);
    expect(summary.arrived).toBe(summary.filed + summary.kept);
    expect(summary.reversed).toBe(0);
    expect(summary.topFiledReasons.map((r) => r.reason).sort()).toEqual([
      "automated notification from example.net",
      "newsletter from example.net",
    ]);
  });

  test("re-intake of the same hit does not double-count", async () => {
    arrive({
      externalId: "dupe",
      from: "n@example.net",
      subject: "Digest",
      listId: "<news.io>",
    });
    const pending = getPendingEvents(watcher.id);
    await fileWatcherEventsToCameIn(watcher, pending, {
      judge: fixedJudge(false),
    });
    // The same batch handed back in — a replayed or repaired poll.
    await fileWatcherEventsToCameIn(watcher, pending, {
      judge: fixedJudge(false),
    });

    expect(getArrivalsSummary({ windowHours: 24 }).arrived).toBe(1);
    expect(listArrivals({ limit: 200 })).toHaveLength(1);
  });

  test("a replayed surfaced hit does not mint a second work item", async () => {
    arrive({
      externalId: "dupe-keep",
      from: "boss@example.org",
      subject: "sign off",
      toMe: true,
    });
    const pending = getPendingEvents(watcher.id);
    await fileWatcherEventsToCameIn(watcher, pending, {
      judge: fixedJudge(true),
    });
    await fileWatcherEventsToCameIn(watcher, pending, {
      judge: fixedJudge(true),
    });

    expect(listWorkItems()).toHaveLength(1);
  });
});
