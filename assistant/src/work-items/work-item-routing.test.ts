/**
 * Routing work to the agent whose job it is.
 *
 * The roster was decorative. Production carried four agents — unpaused, with
 * tiers, charters and domains — and 1,827 of 1,839 work items assigned to
 * `cue`, the undifferentiated house assistant. Not one item ever reached a
 * named agent, and all 73 recorded acts belonged to `cue`. Nothing was broken
 * in the agents; nothing ever routed to them.
 *
 * Two properties matter more than the routing itself, and both are about
 * restraint: an invented name must be dropped exactly like a hallucinated
 * project id, and a deliberate assignment must never be overruled.
 */

import { describe, expect, test } from "bun:test";

import type { WorkItem } from "./work-item-store.js";
import {
  buildTriagePrompt,
  isUnclaimed,
  parseTriageResponse,
} from "./work-item-triage.js";

const AGENTS = [
  { name: "Ops", domain: "Operations", charter: "Keep the company running." },
  { name: "Growth", domain: "Growth", charter: "Pipeline and outreach." },
];

const ids = new Set(["p-1"]);
const names = new Set(["ops", "growth"]);

const item = { title: "Chase the Rasmal intro", notes: null } as WorkItem;

describe("routing: the prompt", () => {
  test("offers the roster with domain and charter", () => {
    const prompt = buildTriagePrompt(item, [], AGENTS);
    expect(prompt).toContain("Ops (Operations): Keep the company running.");
    expect(prompt).toContain("Growth (Growth): Pipeline and outreach.");
    expect(prompt).toContain('"assignee"');
    expect(prompt).toContain("Never invent a name");
  });

  test("says nothing about assignees when there is no roster", () => {
    // Asking for a field with no valid value invites an invented one.
    const prompt = buildTriagePrompt(item, [], []);
    expect(prompt).not.toContain("assignee");
    expect(prompt).not.toContain("Team available");
  });
});

describe("routing: the parser", () => {
  test("accepts a name from the roster", () => {
    const r = parseTriageResponse(
      '{"urgency":60,"tier":1,"assignee":"Growth"}',
      ids,
      Date.now(),
      names,
    );
    expect(r?.assignee).toBe("Growth");
  });

  test("matches case-insensitively, as the roster lookup does", () => {
    // `getAgentByAssignee` is case-insensitive, so "ops" must not resolve
    // differently here than it does at run time.
    const r = parseTriageResponse(
      '{"urgency":60,"tier":1,"assignee":"ops"}',
      ids,
      Date.now(),
      names,
    );
    expect(r?.assignee).toBe("ops");
  });

  test("drops an invented name", () => {
    // Same discipline as a hallucinated project id: the scorer may only pick
    // from what it was shown. A bogus assignee would strand the item on an
    // agent that does not exist.
    const r = parseTriageResponse(
      '{"urgency":60,"tier":1,"assignee":"Legal"}',
      ids,
      Date.now(),
      names,
    );
    expect(r?.assignee).toBeNull();
  });

  test("drops any assignee when no roster was offered", () => {
    const r = parseTriageResponse(
      '{"urgency":60,"tier":1,"assignee":"Ops"}',
      ids,
    );
    expect(r?.assignee).toBeNull();
  });

  test("a null or absent assignee is not an error", () => {
    expect(
      parseTriageResponse('{"urgency":60,"tier":1}', ids, Date.now(), names)
        ?.assignee,
    ).toBeNull();
    expect(
      parseTriageResponse(
        '{"urgency":60,"tier":1,"assignee":null}',
        ids,
        Date.now(),
        names,
      )?.assignee,
    ).toBeNull();
  });
});

describe("routing: who counts as unclaimed", () => {
  test('"cue" is the creation default, so it counts as unclaimed', () => {
    // The load-bearing case. 1,827 of 1,839 production rows carry "cue"
    // because createWorkItem defaults it, not because anyone chose it —
    // treating that as claimed would make routing a permanent no-op.
    expect(isUnclaimed("cue")).toBe(true);
    expect(isUnclaimed("Cue")).toBe(true);
    expect(isUnclaimed("  cue  ")).toBe(true);
    expect(isUnclaimed(null)).toBe(true);
    expect(isUnclaimed(undefined)).toBe(true);
    expect(isUnclaimed("")).toBe(true);
  });

  test("any real name is a decision and is left alone", () => {
    // A human's choice, or an earlier routing pass. Triage does not overrule
    // either — re-routing an item someone assigned is worse than not routing.
    expect(isUnclaimed("Ops")).toBe(false);
    expect(isUnclaimed("Manav")).toBe(false);
    expect(isUnclaimed("Growth")).toBe(false);
  });
});
