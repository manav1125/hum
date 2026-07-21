/**
 * Playbook store CRUD + match-scoping (WS-F).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listMatchablePlaybooks,
  listPlaybooks,
  markPlaybookFired,
  unbindPlaybooksFromWatcher,
  updatePlaybook,
} from "../playbook-store.js";

initializeDb();

beforeEach(() => {
  getDb().run("DELETE FROM playbooks");
});

describe("playbook CRUD", () => {
  test("round-trips all fields", () => {
    const p = createPlaybook({
      name: "CEO emails",
      triggerText: "from:ceo",
      action: "flag urgent and draft a reply",
      channel: "gmail",
      autonomyLevel: "draft",
      priority: 5,
    });
    const got = getPlaybook(p.id);
    expect(got).not.toBeNull();
    expect(got?.name).toBe("CEO emails");
    expect(got?.triggerText).toBe("from:ceo");
    expect(got?.channel).toBe("gmail");
    expect(got?.autonomyLevel).toBe("draft");
    expect(got?.priority).toBe(5);
    expect(got?.enabled).toBe(true);
    expect(got?.watcherId).toBeNull();
    expect(got?.lastFiredAt).toBeNull();
  });

  test("defaults channel to '*' and autonomy to 'draft'", () => {
    const p = createPlaybook({
      name: "any",
      triggerText: "invoice",
      action: "file it",
    });
    expect(p.channel).toBe("*");
    expect(p.autonomyLevel).toBe("draft");
  });

  test("invalid autonomy coerces to draft", () => {
    const p = createPlaybook({
      name: "x",
      triggerText: "y",
      action: "z",
      // @ts-expect-error deliberately invalid
      autonomyLevel: "bogus",
    });
    expect(p.autonomyLevel).toBe("draft");
  });

  test("list orders by priority desc then creation", () => {
    createPlaybook({ name: "low", triggerText: "a", action: "x", priority: 1 });
    createPlaybook({
      name: "high",
      triggerText: "b",
      action: "x",
      priority: 9,
    });
    createPlaybook({ name: "mid", triggerText: "c", action: "x", priority: 5 });
    const names = listPlaybooks().map((p) => p.name);
    expect(names).toEqual(["high", "mid", "low"]);
  });

  test("update mutates only provided fields", () => {
    const p = createPlaybook({
      name: "orig",
      triggerText: "t",
      action: "a",
      priority: 1,
    });
    const updated = updatePlaybook(p.id, { priority: 8, enabled: false });
    expect(updated?.priority).toBe(8);
    expect(updated?.enabled).toBe(false);
    expect(updated?.name).toBe("orig");
    expect(updated?.triggerText).toBe("t");
  });

  test("delete removes the row", () => {
    const p = createPlaybook({ name: "x", triggerText: "t", action: "a" });
    expect(deletePlaybook(p.id)).toBe(true);
    expect(getPlaybook(p.id)).toBeNull();
    expect(deletePlaybook(p.id)).toBe(false);
  });

  test("markPlaybookFired stamps last-fired", () => {
    const p = createPlaybook({ name: "x", triggerText: "t", action: "a" });
    markPlaybookFired(p.id, 12345);
    expect(getPlaybook(p.id)?.lastFiredAt).toBe(12345);
  });
});

describe("listMatchablePlaybooks scoping", () => {
  test("channel '*' matches any channel; specific channel is exact", () => {
    createPlaybook({
      name: "any",
      triggerText: "t",
      action: "a",
      channel: "*",
    });
    createPlaybook({
      name: "gmail-only",
      triggerText: "t",
      action: "a",
      channel: "gmail",
    });
    const forGmail = listMatchablePlaybooks({ channel: "gmail" }).map(
      (p) => p.name,
    );
    expect(forGmail).toContain("any");
    expect(forGmail).toContain("gmail-only");

    const forSlack = listMatchablePlaybooks({ channel: "slack" }).map(
      (p) => p.name,
    );
    expect(forSlack).toContain("any");
    expect(forSlack).not.toContain("gmail-only");
  });

  test("watcher-bound playbooks only match their watcher", () => {
    createPlaybook({
      name: "bound",
      triggerText: "t",
      action: "a",
      channel: "*",
      watcherId: "w-1",
    });
    const forW1 = listMatchablePlaybooks({
      channel: "gmail",
      watcherId: "w-1",
    }).map((p) => p.name);
    expect(forW1).toContain("bound");

    const forW2 = listMatchablePlaybooks({
      channel: "gmail",
      watcherId: "w-2",
    }).map((p) => p.name);
    expect(forW2).not.toContain("bound");

    const forNone = listMatchablePlaybooks({ channel: "gmail" }).map(
      (p) => p.name,
    );
    expect(forNone).not.toContain("bound");
  });

  test("disabled playbooks are excluded", () => {
    const p = createPlaybook({ name: "off", triggerText: "t", action: "a" });
    updatePlaybook(p.id, { enabled: false });
    expect(listMatchablePlaybooks({ channel: "gmail" })).toHaveLength(0);
  });
});

describe("unbindPlaybooksFromWatcher", () => {
  test("orphans bound playbooks back to channel-wide", () => {
    createPlaybook({
      name: "bound",
      triggerText: "t",
      action: "a",
      watcherId: "w-9",
    });
    expect(unbindPlaybooksFromWatcher("w-9")).toBe(1);
    const p = listPlaybooks()[0];
    expect(p?.watcherId).toBeNull();
  });
});
