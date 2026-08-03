/**
 * Unit tests for the valve's pure rules — the ladder, the demotion policy, and
 * above all the fail-open guarantees.
 *
 * These are the supplement, not the proof: the end-to-end behaviour over real
 * rows is in `__tests__/valve-filter.test.ts`, which drives the reader that HQ
 * actually calls. A previous fix in this repo passed its tests while being
 * completely broken because the test exercised a helper rather than the code
 * production runs.
 *
 * Several tests below are written as MUTATION CHECKS: they assert a property
 * that only holds while a specific guard is intact, so removing the guard
 * turns the suite red rather than turning the product quiet. Each one names
 * the line it is protecting.
 */
import { describe, expect, test } from "bun:test";

import type { Arrival } from "../arrivals/arrival-store.js";
import type { WorkItem } from "../work-items/work-item-store.js";
import {
  applyRest,
  BAND_EVERYTHING,
  BAND_NEEDS_YOU,
  BAND_URGENT,
  type BandContext,
  bandItem,
  bandPassesStop,
  collapseSenderStreams,
  DUE_SOON_MS,
  isMachineAddress,
  liveFloor,
  REST_AFTER_MS,
  RULE_BANDS,
  type StreamCandidate,
  VALVE_RULE_IDS,
  VALVE_STOPS,
  type ValveRuleId,
} from "./valve-bands.js";

const NOW = 1_800_000_000_000;

function ctx(over: Partial<BandContext> = {}): BandContext {
  return {
    now: NOW,
    isLearnedDown: () => false,
    boostedProjectIds: new Set(),
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    taskId: "task-1",
    title: "A thing",
    notes: null,
    status: "queued",
    priorityTier: 1,
    sortIndex: null,
    lastRunId: null,
    lastRunConversationId: null,
    lastRunStatus: null,
    sourceType: "watcher:gmail",
    sourceId: "ext-1",
    approvalStatus: "none",
    projectId: null,
    dueAt: null,
    autoRunEligibility: "parked",
    arrivalId: "arr-1",
    createdAt: NOW,
    updatedAt: NOW,
    // Everything else the row carries is irrelevant to banding; the cast keeps
    // this factory honest about that rather than inventing plausible values
    // that a reader might mistake for meaningful setup.
    ...over,
  } as unknown as WorkItem;
}

function arrival(over: Partial<Arrival> = {}): Arrival {
  return {
    id: "arr-1",
    channel: "watcher:gmail",
    externalId: "ext-1",
    watcherId: null,
    eventId: null,
    title: "A subject",
    senderAddress: "jane@example.com",
    senderName: "Jane",
    snippet: "hello",
    sourceContext: null,
    disposition: "surfaced",
    reason: "a reason",
    decidedBy: "rule",
    ruleId: "direct_human",
    confidence: null,
    workItemId: "wi-1",
    reversedAt: null,
    reversedBy: null,
    occurredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Arrival;
}

describe("the ladder", () => {
  test("every band answers at every stop, and urgent always passes", () => {
    for (const stop of VALVE_STOPS) {
      expect(bandPassesStop(BAND_URGENT, stop)).toBe(true);
      expect(typeof bandPassesStop(BAND_NEEDS_YOU, stop)).toBe("boolean");
      expect(typeof bandPassesStop(BAND_EVERYTHING, stop)).toBe("boolean");
    }
  });

  test("raising the stop only ever hides more", () => {
    // Monotonicity. If this breaks, "quieter" and "louder" stop being
    // opposites and the control becomes unpredictable.
    for (const band of [
      BAND_URGENT,
      BAND_NEEDS_YOU,
      BAND_EVERYTHING,
    ] as const) {
      const everything = bandPassesStop(band, "everything");
      const needsYou = bandPassesStop(band, "needs_you");
      const onlyUrgent = bandPassesStop(band, "only_urgent");
      expect(everything || !needsYou).toBe(true);
      expect(needsYou || !onlyUrgent).toBe(true);
    }
  });

  test("the everything stop hides nothing at all", () => {
    for (const band of [
      BAND_URGENT,
      BAND_NEEDS_YOU,
      BAND_EVERYTHING,
    ] as const) {
      expect(bandPassesStop(band, "everything")).toBe(true);
    }
  });
});

describe("fail open", () => {
  test("MUTATION CHECK: an arrival the gate could not judge is never demoted", () => {
    // Protects the `gate_unsure` branch's position ABOVE every demotion rule
    // in `bandItem`. Move it below them and this goes red.
    //
    // The setup deliberately stacks every reason to be quiet at once: the
    // sender is a robot's address with nothing transactional in it, AND the
    // owner has dismissed that sender repeatedly. The gate still said it could
    // not judge, so it still has to show.
    const verdict = bandItem(
      item(),
      arrival({
        decidedBy: "fallback",
        ruleId: null,
        // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
        senderAddress: "noreply@notification.example.com",
        title: "Monthly newsletter",
        snippet: "nothing to do here",
      }),
      ctx({ isLearnedDown: () => true }),
    );
    expect(verdict.band).toBe(BAND_NEEDS_YOU);
    expect(verdict.ruleId).toBe("gate_unsure");
    expect(bandPassesStop(verdict.band, "needs_you")).toBe(true);
  });

  test("an unjudged arrival does not rest, however long it has been seen", () => {
    // Protects the `gate_unsure` exemption in `applyRest`. Showing an item Cue
    // never understood exactly once, then quieting it, is how "I don't know"
    // becomes "gone" on a delay.
    const verdict = bandItem(
      item(),
      arrival({ decidedBy: "fallback", ruleId: null }),
      ctx(),
    );
    const rested = applyRest(verdict, NOW - REST_AFTER_MS * 10, NOW);
    expect(rested.band).toBe(BAND_NEEDS_YOU);
    expect(rested.ruleId).toBe("gate_unsure");
  });

  test("an item with no arrival at all stays visible at the default stop", () => {
    // Quick-add, chat, voice, MCP. Nothing to judge, nobody to blame it on.
    const verdict = bandItem(item({ arrivalId: null }), null, ctx());
    expect(verdict.ruleId).toBe("self_captured");
    expect(bandPassesStop(verdict.band, "needs_you")).toBe(true);
  });

  test("urgent work never rests", () => {
    const verdict = bandItem(
      item({ status: "awaiting_review" }),
      arrival(),
      ctx(),
    );
    expect(applyRest(verdict, NOW - REST_AFTER_MS * 5, NOW)).toEqual(verdict);
  });
});

describe("demotion requires positive evidence", () => {
  test("a learned-down sender drops to the everything band", () => {
    const verdict = bandItem(
      item(),
      arrival(),
      ctx({ isLearnedDown: (key) => key === "jane@example.com" }),
    );
    expect(verdict.band).toBe(BAND_EVERYTHING);
    expect(verdict.ruleId).toBe("learned_down");
    expect(verdict.bandedBy).toBe("learned");
    expect(bandPassesStop(verdict.band, "needs_you")).toBe(false);
  });

  test("an automated sender with nothing to action drops", () => {
    // The measured over-firing leg: 68 of one production day's 93 keeps were
    // `direct_human`, from HSBC, Uber and Temu.
    const verdict = bandItem(
      item(),
      arrival({
        senderAddress: "noreply@example.com",
        title: "Your weekly ride recap",
        snippet: "see where you went",
      }),
      ctx(),
    );
    expect(verdict.ruleId).toBe("automated_sender");
    expect(verdict.band).toBe(BAND_EVERYTHING);
  });

  test("MUTATION CHECK: an automated sender WITH something to action does not", () => {
    // Protects the `looksTransactional` carve-out. Approvals, expiring
    // credentials, payment failures and security notices arrive from exactly
    // these addresses — that is what they are for.
    const verdict = bandItem(
      item(),
      arrival({
        // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
        senderAddress: "noreply@notification.example.com",
        title: "Action required: verify your payment",
        snippet: "your transfer could not be completed",
      }),
      ctx(),
    );
    expect(verdict.band).not.toBe(BAND_EVERYTHING);
  });

  test("a person writing directly still needs you", () => {
    const verdict = bandItem(item(), arrival(), ctx());
    expect(verdict.ruleId).toBe("direct_person");
    expect(verdict.band).toBe(BAND_NEEDS_YOU);
  });

  test("Cue's own queue is held, but a parked item never is", () => {
    const holding = bandItem(
      item({ status: "queued", autoRunEligibility: "eligible" }),
      arrival({ ruleId: "other", decidedBy: "rule" }),
      ctx(),
    );
    expect(holding.ruleId).toBe("cue_is_holding");

    const parked = bandItem(
      item({ status: "queued", autoRunEligibility: "parked" }),
      arrival({ ruleId: "other", decidedBy: "rule" }),
      ctx(),
    );
    expect(parked.ruleId).not.toBe("cue_is_holding");
  });

  test("MUTATION CHECK: an item Cue is blocked on is never treated as holding", () => {
    // Protects the `awaitsTheOwner` early-out inside `cueIsHolding`. Without
    // it, an eligible item awaiting review would read as Cue's problem and
    // vanish from the default stop while literally waiting on the owner.
    const verdict = bandItem(
      item({ status: "awaiting_review", autoRunEligibility: "eligible" }),
      arrival(),
      ctx(),
    );
    expect(verdict.ruleId).toBe("awaiting_you");
    expect(verdict.band).toBe(BAND_URGENT);
  });
});

describe("the live floor", () => {
  test("awaiting the owner, due today, and a boosted mission all read urgent", () => {
    expect(
      liveFloor(item({ status: "awaiting_review" }), {
        now: NOW,
        boostedProjectIds: new Set(),
      })?.ruleId,
    ).toBe("awaiting_you");

    expect(
      liveFloor(item({ dueAt: NOW + DUE_SOON_MS - 1 }), {
        now: NOW,
        boostedProjectIds: new Set(),
      })?.ruleId,
    ).toBe("due_now");

    expect(
      liveFloor(item({ projectId: "proj-9" }), {
        now: NOW,
        boostedProjectIds: new Set(["proj-9"]),
      })?.ruleId,
    ).toBe("mission_boosted");
  });

  test("an approval that is still pending counts as awaiting the owner", () => {
    expect(
      liveFloor(item({ approvalStatus: "pending" }), {
        now: NOW,
        boostedProjectIds: new Set(),
      })?.ruleId,
    ).toBe("awaiting_you");
  });

  test("it returns null for ordinary work, so it can only ever raise", () => {
    expect(
      liveFloor(item(), { now: NOW, boostedProjectIds: new Set() }),
    ).toBeNull();
  });

  test("a mission boost outranks a sender the owner dismissed", () => {
    // Design's "bump a hot mission to Everything while it is live" has to mean
    // everything, including traffic from senders previously quieted.
    const verdict = bandItem(
      item({ projectId: "proj-9" }),
      arrival({ senderAddress: "noreply@example.com", title: "recap" }),
      ctx({
        boostedProjectIds: new Set(["proj-9"]),
        isLearnedDown: () => true,
      }),
    );
    expect(verdict.ruleId).toBe("mission_boosted");
    expect(verdict.band).toBe(BAND_URGENT);
  });
});

describe("the owner's own corrections", () => {
  test("a reversed filing is urgent and beats every demotion", () => {
    const verdict = bandItem(
      item(),
      arrival({
        reversedAt: NOW - 1000,
        disposition: "filed",
        decidedBy: "rule",
        ruleId: "list_mail",
        // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
        senderAddress: "email@market.example.com",
        title: "50% off everything",
      }),
      ctx({ isLearnedDown: () => true }),
    );
    expect(verdict.ruleId).toBe("owner_reversed");
    expect(verdict.band).toBe(BAND_URGENT);
  });
});

describe("rule bookkeeping", () => {
  test("every declared rule has a band, and no band is declared twice", () => {
    expect(new Set(VALVE_RULE_IDS).size).toBe(VALVE_RULE_IDS.length);
    for (const ruleId of VALVE_RULE_IDS) {
      expect(RULE_BANDS[ruleId]).toBeDefined();
    }
    expect(Object.keys(RULE_BANDS).sort()).toEqual([...VALVE_RULE_IDS].sort());
  });

  test("every rule the pure bander can reach is actually reachable", () => {
    // The direct answer to "check the rule distribution before trusting a
    // branch exists". A rule that no input can produce is dead code, and the
    // last safety floor in this daemon shipped with three such legs.
    //
    // Three rules are excluded and each is named, with the test that covers
    // it instead: `valve_error` is stamped by callers AROUND `bandItem`,
    // `already_seen` only by `applyRest`, and `sender_stream` only by
    // `collapseSenderStreams` — it is a statement about a batch, which no
    // per-item function can make. Each has its own reachability test below.
    const reachableHere = VALVE_RULE_IDS.filter(
      (id) =>
        id !== "valve_error" && id !== "already_seen" && id !== "sender_stream",
    );
    const cases: Array<[ValveRuleId, () => ValveRuleId]> = [
      [
        "owner_reversed",
        () => bandItem(item(), arrival({ reversedAt: NOW }), ctx()).ruleId,
      ],
      [
        "awaiting_you",
        () =>
          bandItem(item({ status: "awaiting_review" }), arrival(), ctx())
            .ruleId,
      ],
      [
        "due_now",
        () => bandItem(item({ dueAt: NOW }), arrival(), ctx()).ruleId,
      ],
      [
        "mission_boosted",
        () =>
          bandItem(
            item({ projectId: "p" }),
            arrival(),
            ctx({ boostedProjectIds: new Set(["p"]) }),
          ).ruleId,
      ],
      [
        "known_person",
        () => bandItem(item(), arrival({ decidedBy: "floor" }), ctx()).ruleId,
      ],
      [
        "gate_unsure",
        () =>
          bandItem(
            item(),
            arrival({ decidedBy: "fallback", ruleId: null }),
            ctx(),
          ).ruleId,
      ],
      [
        "named_work",
        () => bandItem(item(), arrival({ ruleId: "named_work" }), ctx()).ruleId,
      ],
      [
        "calendar_action",
        () =>
          bandItem(item(), arrival({ ruleId: "calendar_conflict" }), ctx())
            .ruleId,
      ],
      [
        "model_keep",
        () =>
          bandItem(
            item(),
            arrival({
              decidedBy: "model",
              ruleId: null,
              disposition: "surfaced",
            }),
            ctx(),
          ).ruleId,
      ],
      ["direct_person", () => bandItem(item(), arrival(), ctx()).ruleId],
      [
        "self_captured",
        () => bandItem(item({ arrivalId: null }), null, ctx()).ruleId,
      ],
      [
        "learned_down",
        () =>
          bandItem(item(), arrival(), ctx({ isLearnedDown: () => true }))
            .ruleId,
      ],
      [
        "automated_sender",
        () =>
          bandItem(
            item(),
            arrival({ senderAddress: "noreply@example.com", title: "recap" }),
            ctx(),
          ).ruleId,
      ],
      [
        "cue_is_holding",
        () =>
          bandItem(
            item({ autoRunEligibility: "eligible" }),
            arrival({ ruleId: "other" }),
            ctx(),
          ).ruleId,
      ],
    ];

    for (const [expected, produce] of cases) {
      expect(produce()).toBe(expected);
    }
    // And the list of cases covers every reachable rule — so adding a rule
    // without a way to reach it fails here rather than in production.
    expect(cases.map(([id]) => id).sort()).toEqual([...reachableHere].sort());
  });

  test("already_seen is reachable through applyRest", () => {
    const verdict = bandItem(item(), arrival(), ctx());
    const rested = applyRest(verdict, NOW - REST_AFTER_MS - 1, NOW);
    expect(rested.ruleId).toBe("already_seen");
    expect(rested.band).toBe(BAND_EVERYTHING);
  });

  test("an item that has never been shown does not rest", () => {
    const verdict = bandItem(item(), arrival(), ctx());
    expect(applyRest(verdict, null, NOW)).toEqual(verdict);
  });
});

describe("the sender-stream collapse", () => {
  function candidate(
    itemId: string,
    senderKey: string | null,
    occurredAt: number,
    over: Partial<StreamCandidate> = {},
  ): StreamCandidate {
    return {
      itemId,
      senderKey,
      band: BAND_NEEDS_YOU,
      ruleId: "direct_person",
      occurredAt,
      ...over,
    };
  }

  test("MUTATION CHECK: the newest from a sender is ALWAYS shown", () => {
    // The rule that makes this safe. Thinning a stream is legitimate;
    // silencing a source is not, and no count of messages may do it.
    const held = collapseSenderStreams([
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      candidate("a", "acct_cnp@notification.example.com", 300),
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      candidate("b", "acct_cnp@notification.example.com", 200),
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      candidate("c", "acct_cnp@notification.example.com", 100),
    ]);
    expect(held.has("a")).toBe(false);
    expect(held.has("b")).toBe(true);
    expect(held.has("c")).toBe(true);
    expect(held.get("b")).toContain("notification.example.com");
  });

  test("a person writing three times gets three items", () => {
    // Three emails from a person are three things they want.
    const held = collapseSenderStreams([
      candidate("a", "olga@example.com", 300),
      candidate("b", "olga@example.com", 200),
      candidate("c", "olga@example.com", 100),
    ]);
    expect(held.size).toBe(0);
  });

  test("urgent items and unjudged items never collapse", () => {
    const held = collapseSenderStreams([
      candidate("a", "noreply@example.com", 300, { band: BAND_URGENT }),
      candidate("b", "noreply@example.com", 200, { band: BAND_URGENT }),
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      candidate("c", "noreply@notify.example.com", 300, {
        ruleId: "gate_unsure",
      }),
      // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
      candidate("d", "noreply@notify.example.com", 200, {
        ruleId: "gate_unsure",
      }),
    ]);
    expect(held.size).toBe(0);
  });

  test("a single message from a machine is not a stream", () => {
    expect(
      collapseSenderStreams([candidate("a", "noreply@example.com", 100)]).size,
    ).toBe(0);
  });

  test("machine addresses are recognised by local part OR domain label", () => {
    // The measured gap: `isBulkSenderAddress` reads the local part, so four
    // bank senders whose local part was a product code and whose domain began
    // with a `notification.` label — 24 of one production day's 94 keeps —
    // were invisible to it.
    expect(isMachineAddress("noreply@example.com")).toBe(true);
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    expect(isMachineAddress("acct_cnp@notification.example.com")).toBe(true);
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    expect(isMachineAddress("no-reply@mail.example.com")).toBe(true);
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    expect(isMachineAddress("email@market.example.com")).toBe(true);
    // And a person is still a person.
    expect(isMachineAddress("olga@example.com")).toBe(false);
    expect(isMachineAddress("soumaya@example.org")).toBe(false);
    expect(isMachineAddress(null)).toBe(false);
  });

  test("MUTATION CHECK: a bare registrable domain is not a machine label", () => {
    // A domain must not read as bulk merely because its TLD or its
    // registrable name happens to be one of the labels. Only true subdomain
    // labels count, so a real correspondent at a two-label domain is safe.
    expect(isMachineAddress("hello@example.com")).toBe(false);
    // generic-examples:ignore-next-line — reason: the registrable name has to
    // BE a bulk label for this assertion to mean anything, which example.com
    // cannot express.
    // generic-examples:ignore-next-line — reason: the SUBDOMAIN is the subject of the assertion; a bare example.com cannot express a machine-mail domain label
    expect(isMachineAddress("jane@news.com")).toBe(false);
  });
});
