/**
 * Tests for the retro-run of the relevance gate over the pre-gate backlog.
 *
 * The invariant under test throughout is that nothing is destroyed and nothing
 * is filed on a signal the row does not actually carry. The payload fixtures
 * are the real shape of a pre-gate `watcher_events.payload_json` — id,
 * threadId, from, subject, date, snippet, labelIds and nothing else.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createTask } from "../tasks/task-store.js";
import { createWatcher, insertWatcherEvent } from "../watcher/watcher-store.js";
import {
  createWorkItem,
  getWorkItem,
  type WorkItem,
} from "../work-items/work-item-store.js";
import type { ArrivalDecision, FloorContext } from "./arrival-gate.js";
import {
  BULK_GMAIL_CATEGORIES,
  DEFAULT_RETRO_CHANNEL,
  describeReconstruction,
  isBulkSenderAddress,
  proposeFromStoredLabels,
  retrofitArrivalGate,
} from "./arrival-retrofit.js";
import { findArrivalByExternalId, listArrivals } from "./arrival-store.js";

initializeDb();

const CHANNEL = DEFAULT_RETRO_CHANNEL;
let watcherId = "";

const emptyFloor: FloorContext = { lookupContact: () => null, namedWork: [] };

beforeEach(() => {
  getDb().run("DELETE FROM work_items");
  getDb().run("DELETE FROM tasks");
  getDb().run("DELETE FROM projects");
  getDb().run("DELETE FROM arrivals");
  getDb().run("DELETE FROM watcher_events");
  getDb().run("DELETE FROM watchers");
  watcherId = createWatcher({
    name: "Gmail",
    providerId: "gmail",
    actionPrompt: "triage",
    credentialService: "gmail",
  }).id;
});

/** The real shape of a pre-gate Gmail payload: no header block at all. */
function preGatePayload(opts: {
  id: string;
  from: string;
  subject: string;
  labelIds?: string[];
}): string {
  return JSON.stringify({
    id: opts.id,
    threadId: opts.id,
    from: opts.from,
    subject: opts.subject,
    date: "Fri, 31 Jul 2026 22:20:07 +0000",
    snippet: `${opts.subject} — body text`,
    labelIds: opts.labelIds ?? ["UNREAD", "INBOX"],
  });
}

function seedArrival(opts: {
  externalId: string;
  from: string;
  subject: string;
  labelIds?: string[];
  payloadJson?: string;
  withEvent?: boolean;
}): WorkItem {
  if (opts.withEvent !== false) {
    insertWatcherEvent({
      watcherId,
      externalId: opts.externalId,
      eventType: "message",
      summary: opts.subject,
      payloadJson: opts.payloadJson ?? preGatePayload(opts as never),
    });
  }
  const task = createTask({ title: opts.subject, template: opts.subject });
  return createWorkItem({
    taskId: task.id,
    title: opts.subject,
    sourceType: CHANNEL,
    sourceId: opts.externalId,
  });
}

describe("describeReconstruction", () => {
  test("a pre-gate payload is thin, and says exactly what it is missing", () => {
    const payload = JSON.parse(
      preGatePayload({ id: "m1", from: "sender@example.com", subject: "Hi" }),
    );
    const described = describeReconstruction(payload);
    expect(described.quality).toBe("thin");
    expect(described.present).toContain("sender");
    expect(described.present).toContain("gmail labels");
    // The four things the gate normally reads and this row does not have. The
    // tool must never quietly render these as "false".
    expect(described.missing).toContain("List-Unsubscribe / List-Id");
    expect(described.missing).toContain(
      "whether the owner was a direct recipient",
    );
    expect(described.missing).toContain(
      "whether the owner replied in this thread",
    );
  });

  test("a post-gate payload is full", () => {
    const described = describeReconstruction({
      from: "sender@example.com",
      subject: "Hi",
      listUnsubscribe: "<mailto:x>",
      toMe: false,
    });
    expect(described.quality).toBe("full");
    expect(described.present).toContain("mail headers");
  });

  test("a missing payload is unavailable, never thin", () => {
    expect(describeReconstruction(null).quality).toBe("unavailable");
  });
});

describe("isBulkSenderAddress — a claim about the address, not the message", () => {
  test("catches the shapes that flooded the lane", () => {
    for (const a of [
      // The local-part shapes that flooded the real lane. The domain is
      // deliberately constant: the rule reads the local part only, so varying
      // the domain would suggest it matters.
      "notification@example.com",
      "noreply@example.com",
      "news-noreply@example.com",
      "en_flight_noreply@example.com",
      "buzz@example.com",
      "promotions@example.com",
      "news@example.com",
      "newsletter@example.com",
      "do-not-reply@example.com",
    ]) {
      expect(isBulkSenderAddress(a)).toBe(true);
    }
  });

  test("a surname is not a newsletter", () => {
    // The failure a substring match would produce: filing a real person's mail
    // because their name contains one of the tokens. This is the whole reason
    // the match is on delimited tokens rather than `includes`.
    for (const a of [
      "newsome@example.com",
      "promotional.director@example.com",
      "jnews@example.com",
      "buzzard@example.com",
    ]) {
      expect(isBulkSenderAddress(a)).toBe(false);
    }
  });

  test("addresses that are routinely a human, or a robot owed an answer", () => {
    // Approval requests, expiring tokens and invoices arrive from addresses
    // like these. One missed invoice costs more than eight promos kept.
    for (const a of [
      "support@example.com",
      "hello@example.com",
      "billing@example.com",
      "accounts@example.com",
      "team@example.com",
      "admin@example.com",
    ]) {
      expect(isBulkSenderAddress(a)).toBe(false);
    }
  });

  test("malformed input is never bulk", () => {
    expect(isBulkSenderAddress(null)).toBe(false);
    expect(isBulkSenderAddress("")).toBe(false);
    expect(isBulkSenderAddress("noreply")).toBe(false);
    expect(isBulkSenderAddress("@noreply.com")).toBe(false);
  });
});

describe("proposeFromStoredLabels", () => {
  test("files on Gmail's own bulk categories", () => {
    for (const label of Object.keys(BULK_GMAIL_CATEGORIES)) {
      const proposed = proposeFromStoredLabels({
        labelIds: ["INBOX", label],
      } as never);
      expect(proposed?.disposition).toBe("filed");
      expect(proposed?.decidedBy).toBe("rule");
    }
  });

  test("CATEGORY_UPDATES is NOT bulk — statements and statutory notices live there", () => {
    // The real item this protects: a company annual-return deadline that
    // Gmail categorised as an update.
    const proposed = proposeFromStoredLabels({
      labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
    } as never);
    expect(proposed).toBeNull();
  });

  test("Gmail's IMPORTANT marker outranks its category", () => {
    const proposed = proposeFromStoredLabels({
      labelIds: ["IMPORTANT", "CATEGORY_PROMOTIONS"],
    } as never);
    expect(proposed).toBeNull();
  });

  test("no labels means no proposal — never file on absence", () => {
    expect(proposeFromStoredLabels({ labelIds: [] } as never)).toBeNull();
    expect(proposeFromStoredLabels(null)).toBeNull();
  });
});

describe("retrofitArrivalGate", () => {
  const noDecisions = async () => new Map<string, ArrivalDecision>();

  test("dry run is the default and writes absolutely nothing", async () => {
    const promo = seedArrival({
      externalId: "m-promo",
      from: "Newsletter <news@example.org>",
      subject: "This week's reads",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const report = await retrofitArrivalGate({
      decide: noDecisions,
      floorContext: emptyFloor,
    });

    expect(report.applied).toBe(false);
    expect(report.filed).toBe(1);
    // The plan says "filed"; the database says otherwise.
    expect(getWorkItem(promo.id)!.status).toBe("queued");
    expect(listArrivals({})).toHaveLength(0);
    expect(findArrivalByExternalId(CHANNEL, "m-promo")).toBeUndefined();
  });

  test("filing archives the item and links it — nothing is deleted", async () => {
    const promo = seedArrival({
      externalId: "m-promo",
      from: "Newsletter <news@example.org>",
      subject: "This week's reads",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });

    expect(report.filed).toBe(1);
    const after = getWorkItem(promo.id)!;
    // Archived, not deleted, not cancelled. The row and its history survive.
    expect(after.status).toBe("archived");
    expect(after.title).toBe("This week's reads");

    const arrival = findArrivalByExternalId(CHANNEL, "m-promo")!;
    expect(arrival.disposition).toBe("filed");
    expect(arrival.reason).toBe(BULK_GMAIL_CATEGORIES.CATEGORY_PROMOTIONS);
    // The back-link is what makes the reversal exact rather than a copy.
    expect(arrival.workItemId).toBe(promo.id);
    expect(report.items[0].reversible).toBe(true);
  });

  test("a thin row with nothing bulk about it is kept, not guessed at", async () => {
    const personal = seedArrival({
      externalId: "m-person",
      from: "A Friend <friend@example.com>",
      subject: "Fwd: LRC JUNE 2026 - eReminder",
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });

    expect(report.kept).toBe(1);
    expect(getWorkItem(personal.id)!.status).toBe("queued");
    expect(report.items[0].reason).toContain("kept for you");
    expect(report.items[0].reconstruction).toBe("thin");
  });

  test("the safety floor still wins on a thin row", async () => {
    seedArrival({
      externalId: "m-contact",
      from: "Lawyer <lawyer@example.com>",
      subject: "Newsletter-ish subject",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: {
        lookupContact: (a) => (a === "lawyer@example.com" ? "Olga" : null),
        namedWork: [],
      },
    });

    // Gmail called it Promotions. She is in his contacts, so it surfaces.
    expect(report.filed).toBe(0);
    expect(report.kept).toBe(1);
    expect(report.items[0].decidedBy).toBe("floor");
    expect(report.items[0].ruleId).toBe("known_contact");
  });

  test("a named project mentioned in the subject beats a bulk label", async () => {
    seedArrival({
      externalId: "m-project",
      from: "Digest <digest@example.org>",
      subject: "Blackpine weekly roundup",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: {
        lookupContact: () => null,
        namedWork: [{ kind: "project", name: "Blackpine" }],
      },
    });
    expect(report.filed).toBe(0);
    expect(report.items[0].ruleId).toBe("named_work");
  });

  test("an item whose watcher event is gone is kept, never filed", async () => {
    const orphan = seedArrival({
      externalId: "m-orphan",
      from: "Whoever <someone@example.com>",
      subject: "Lost to history",
      withEvent: false,
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });

    expect(report.unreconstructable).toBe(1);
    expect(report.filed).toBe(0);
    expect(getWorkItem(orphan.id)!.status).toBe("queued");
    expect(report.items[0].reconstruction).toBe("unavailable");
  });

  test("the model is not consulted on thin rows unless asked", async () => {
    seedArrival({
      externalId: "m-thin",
      from: "Someone <someone@example.org>",
      subject: "Ambiguous",
    });

    let sawItems = 0;
    const spy = async (signals: unknown[]) => {
      sawItems += signals.length;
      return new Map<string, ArrivalDecision>();
    };

    await retrofitArrivalGate({
      decide: spy as never,
      floorContext: emptyFloor,
    });
    expect(sawItems).toBe(0);

    await retrofitArrivalGate({
      decide: spy as never,
      floorContext: emptyFloor,
      useModelOnThin: true,
    });
    expect(sawItems).toBe(1);
  });

  test("running twice does not double-file or mint a second arrival", async () => {
    const promo = seedArrival({
      externalId: "m-promo",
      from: "Newsletter <news@example.org>",
      subject: "This week's reads",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const first = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    expect(first.filed).toBe(1);

    // The second run sees the archived item is no longer queued, and even if
    // it were, the arrivals row is the marker.
    const second = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    expect(second.filed).toBe(0);
    expect(listArrivals({})).toHaveLength(1);
    expect(getWorkItem(promo.id)!.status).toBe("archived");
  });

  test("an item already decided by the gate is never re-decided", async () => {
    const task = createTask({ title: "Gated", template: "Gated" });
    const gated = createWorkItem({
      taskId: task.id,
      title: "Gated",
      sourceType: CHANNEL,
      sourceId: "m-gated",
      arrivalId: "arr-existing",
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    expect(report.scanned).toBe(0);
    expect(getWorkItem(gated.id)!.status).toBe("queued");
  });

  test("only the named channel is touched", async () => {
    const task = createTask({ title: "Slack thing", template: "Slack thing" });
    const other = createWorkItem({
      taskId: task.id,
      title: "Slack thing",
      sourceType: "watcher:slack",
      sourceId: "s-1",
    });
    seedArrival({
      externalId: "m-promo",
      from: "Newsletter <news@example.org>",
      subject: "This week's reads",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });

    const report = await retrofitArrivalGate({
      apply: true,
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    expect(report.scanned).toBe(1);
    expect(getWorkItem(other.id)!.status).toBe("queued");
  });

  test("--limit takes the oldest first, and the rest are untouched", async () => {
    for (let i = 0; i < 5; i++) {
      seedArrival({
        externalId: `m-${i}`,
        from: "Newsletter <news@example.org>",
        subject: `Promo ${i}`,
        labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
      });
    }
    const report = await retrofitArrivalGate({
      apply: true,
      limit: 2,
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    expect(report.scanned).toBe(2);
    expect(report.filed).toBe(2);
    expect(listArrivals({})).toHaveLength(2);
  });

  test("every filed item reports the reason and what it was decided on", async () => {
    seedArrival({
      externalId: "m-promo",
      from: "Newsletter <news@example.org>",
      subject: "This week's reads",
      labelIds: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    const report = await retrofitArrivalGate({
      decide: noDecisions,
      floorContext: emptyFloor,
    });
    const item = report.items[0];
    expect(item.reason).toBe(BULK_GMAIL_CATEGORIES.CATEGORY_PROMOTIONS);
    expect(item.title).toBe("This week's reads");
    expect(item.sender).toBe("news@example.org");
    // The reviewer can see the decision was made without the header block.
    expect(item.signalsMissing.length).toBeGreaterThan(0);
  });
});
