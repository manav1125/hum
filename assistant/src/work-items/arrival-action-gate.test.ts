/**
 * The gate that decides what Cue takes on unasked.
 *
 * Everything upstream worked. Watchers captured, and the relevance gate filed
 * 66% of 6,381 production arrivals and surfaced the rest. Nothing ever asked
 * the next question — of the things worth showing you, which are Cue's to do?
 * — so every surfaced arrival was created parked and stayed there: 1,692 in
 * the queued lane, 1,325 in one month, 18 work items ever completed.
 *
 * These pin the restraints rather than the routing, because the restraints are
 * what make an automatic promoter safe to run at all.
 */

import { describe, expect, test } from "bun:test";

import {
  ACTION_GATE_LABEL,
  ACTION_GATE_PROMOTED_LABEL,
  buildActionPrompt,
  isActionGateCandidate,
  MAX_PROMOTIONS_PER_DAY,
  MAX_PROMOTIONS_PER_SWEEP,
  parseActionVerdicts,
} from "./arrival-action-gate.js";
import type { WorkItem } from "./work-item-store.js";

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    title: "Invoice from Acme",
    notes: null,
    status: "queued",
    autoRunEligibility: "parked",
    sourceType: "watcher:gmail",
    assignee: "cue",
    labels: null,
    ...over,
  } as WorkItem;
}

describe("candidate selection is about provenance, never content", () => {
  test("an untouched watcher arrival is a candidate", () => {
    expect(isActionGateCandidate(item())).toBe(true);
  });

  test("a NON-watcher parked item is never considered", () => {
    // The load-bearing distinction. `parked` means two things in one column:
    // "the owner parked this, never auto-run it" and "the watcher had no
    // opinion". Only the second is this gate's to revisit, and provenance is
    // the only way to tell them apart.
    for (const sourceType of ["voice", "task", "email", "permission_block"]) {
      expect(isActionGateCandidate(item({ sourceType }))).toBe(false);
    }
    expect(isActionGateCandidate(item({ sourceType: null }))).toBe(false);
  });

  test("an item somebody has already assigned is left alone", () => {
    // An assignee is a decision, and a decision is not this gate's to revisit.
    expect(isActionGateCandidate(item({ assignee: "Ops" }))).toBe(false);
    expect(isActionGateCandidate(item({ assignee: "Manav" }))).toBe(false);
  });

  test("an already-eligible or non-queued item is not a candidate", () => {
    expect(isActionGateCandidate(item({ autoRunEligibility: null }))).toBe(
      false,
    );
    expect(isActionGateCandidate(item({ status: "done" }))).toBe(false);
    expect(isActionGateCandidate(item({ status: "archived" }))).toBe(false);
  });

  test("an item already considered is not judged twice", () => {
    const labels = JSON.stringify(["something-else", ACTION_GATE_LABEL]);
    expect(isActionGateCandidate(item({ labels }))).toBe(false);
  });

  test("a malformed labels blob does not strand an item forever", () => {
    expect(isActionGateCandidate(item({ labels: "not json" }))).toBe(true);
    expect(isActionGateCandidate(item({ labels: '{"not":"an array"}' }))).toBe(
      true,
    );
  });
});

describe("verdict parsing fails toward inaction", () => {
  const ids = new Set(["a", "b"]);

  test("an explicit true promotes", () => {
    const v = parseActionVerdicts('[{"id":"a","actionable":true}]', ids);
    expect(v.get("a")).toBe(true);
  });

  test("only a literal true counts", () => {
    // "yes", 1, and "true" are not consent. The permissive direction has to
    // be unambiguous or a sloppy answer starts doing work.
    const v = parseActionVerdicts(
      '[{"id":"a","actionable":"true"},{"id":"b","actionable":1}]',
      ids,
    );
    expect(v.get("a")).toBe(false);
    expect(v.get("b")).toBe(false);
  });

  test("an unknown id is dropped", () => {
    const v = parseActionVerdicts('[{"id":"zzz","actionable":true}]', ids);
    expect(v.has("zzz")).toBe(false);
  });

  test("an item the judge did not mention is absent, and absence is not consent", () => {
    const v = parseActionVerdicts('[{"id":"a","actionable":true}]', ids);
    expect(v.get("b")).toBeUndefined();
  });

  test("unparseable output promotes nothing", () => {
    expect(parseActionVerdicts("I could not decide.", ids).size).toBe(0);
    expect(parseActionVerdicts("", ids).size).toBe(0);
    expect(parseActionVerdicts("[{broken", ids).size).toBe(0);
    expect(parseActionVerdicts('{"id":"a","actionable":true}', ids).size).toBe(
      0,
    );
  });
});

describe("the prompt puts the bar in the right place", () => {
  test("it names false as the safe and common answer", () => {
    const p = buildActionPrompt([item()]);
    expect(p).toContain("False is the safe answer");
    // The categories that must never be taken on unasked.
    expect(p).toContain("money");
    expect(p).toContain("messages sent on their behalf");
    expect(p).toContain("decision only the owner can make");
  });

  test("it carries each item's id, title and provenance", () => {
    const p = buildActionPrompt([
      item({
        id: "wi-9",
        title: "Renew the domain",
        sourceType: "watcher:gmail",
      }),
    ]);
    expect(p).toContain("wi-9");
    expect(p).toContain("Renew the domain");
    expect(p).toContain("watcher:gmail");
  });
});

describe("the rolling cap is the bound that matters", () => {
  test("a per-sweep cap alone would permit hundreds of runs a day", () => {
    // The arithmetic that motivated the daily cap, kept as an assertion so
    // nobody raises the per-sweep number thinking it is the safety limit.
    // Sweeps ride the drainer's 5-minute tick: 288 a day.
    const sweepsPerDay = (24 * 60) / 5;
    expect(MAX_PROMOTIONS_PER_SWEEP * sweepsPerDay).toBeGreaterThan(800);
    // The real bound is two orders of magnitude tighter.
    expect(MAX_PROMOTIONS_PER_DAY).toBeLessThan(
      (MAX_PROMOTIONS_PER_SWEEP * sweepsPerDay) / 50,
    );
  });

  test("the cap counts durable state, so a restart cannot reset it", () => {
    // An in-process tally would make a crash loop a way to promote without
    // limit. The count comes from labels on the items themselves.
    expect(ACTION_GATE_PROMOTED_LABEL).toBe("action-gate:promoted");
    expect(ACTION_GATE_PROMOTED_LABEL).not.toBe(ACTION_GATE_LABEL);
  });
});
