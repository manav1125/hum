/**
 * Your Cue's contract.
 *
 * Two failures this file exists to prevent, both of which have already
 * happened once:
 *
 *   1. **Merging on label similarity.** Skills / Plugins / Marketplace /
 *      Connectors were collapsed into one tab because their names sound alike.
 *      Design calls that its own error. The rule it produced — *two things
 *      merge only if they share a lifecycle, not a label* — is asserted here.
 *   2. **A leaf that lies about where it goes.** Watching is specified and
 *      unbuilt. Pointing it at Automations or Channels would look finished and
 *      be wrong.
 */

import { describe, expect, test } from "bun:test";

import {
  YOUR_CUE_GROUPS,
  YOUR_CUE_LEAVES,
  YOUR_CUE_MEMORY_TABS,
  YOUR_CUE_SUBLEAVES,
  activeYourCueLeaf,
  isMemoryPath,
  isPreferencesPath,
  panelsForPath,
} from "./your-cue-model";
import { routes } from "@/utils/routes";

describe("the six groups", () => {
  test("six headings, each a question the leaves under it answer", () => {
    expect(YOUR_CUE_GROUPS.map((g) => g.title)).toEqual([
      "Who Cue is",
      "Who works for you",
      "How Cue reaches you",
      "What Cue knows & sees",
      "What it does alone",
      "Running Cue",
    ]);
  });

  test("every group has at least one leaf — no empty headings", () => {
    for (const group of YOUR_CUE_GROUPS) {
      expect(group.leaves.length).toBeGreaterThan(0);
    }
  });

  test("every leaf belongs to exactly one group", () => {
    const seen = new Set<string>();
    for (const group of YOUR_CUE_GROUPS) {
      for (const leaf of group.leaves) {
        expect(seen.has(leaf.key)).toBe(false);
        seen.add(leaf.key);
      }
    }
    expect(seen.size).toBe(YOUR_CUE_LEAVES.length);
  });
});

describe("four things that look alike and are not", () => {
  // Skills (learned/authored) · Plugins (installed, pinned to a commit) ·
  // Marketplace (browsed/installed) · Connectors (connected/authorised).
  // Four objects, four trust models.
  test.each(["skills", "plugins", "marketplace", "connectors"])(
    "%s is its own leaf",
    (key) => {
      expect(YOUR_CUE_LEAVES.some((leaf) => leaf.key === key)).toBe(true);
    },
  );

  test("all four sit under 'Who works for you' — related, not merged", () => {
    const group = YOUR_CUE_GROUPS.find((g) => g.key === "who-works-for-you");
    expect(group?.leaves.map((l) => l.key)).toEqual([
      "agents",
      "skills",
      "plugins",
      "marketplace",
      "connectors",
    ]);
  });

  test("they point at four different routes", () => {
    const targets = ["skills", "plugins", "marketplace", "connectors"].map(
      (key) => YOUR_CUE_LEAVES.find((leaf) => leaf.key === key)?.to,
    );
    expect(new Set(targets).size).toBe(4);
  });
});

describe("no second nav path to the same destination", () => {
  test("no two leaves share a route", () => {
    const targets = YOUR_CUE_LEAVES.map((l) => l.to).filter(
      (to): to is string => to !== null,
    );
    expect(new Set(targets).size).toBe(targets.length);
  });

  test("no sub-leaf duplicates a leaf", () => {
    const leafTargets = new Set(
      YOUR_CUE_LEAVES.map((l) => l.to).filter(
        (to): to is string => to !== null,
      ),
    );
    for (const sub of YOUR_CUE_SUBLEAVES) {
      expect(leafTargets.has(sub.to)).toBe(false);
    }
  });

  test("no two sub-leaves share a route", () => {
    const targets = YOUR_CUE_SUBLEAVES.map((s) => s.to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe("the four duplications resolve to exactly one page each", () => {
  test("connectors: one catalog leaf, and it is Connectors", () => {
    const catalogs = YOUR_CUE_LEAVES.filter(
      (leaf) =>
        leaf.to === routes.connectors ||
        leaf.to === routes.settings.integrations,
    );
    expect(catalogs.map((l) => l.key)).toEqual(["connectors"]);
  });

  test("autonomy policy: one leaf, and it is Guardrails", () => {
    // System access is a separate leaf on purpose — macOS grants are not
    // policy — but no leaf other than Guardrails owns checkpoints, scopes,
    // autonomy or trust rules.
    const guardrails = YOUR_CUE_LEAVES.find((l) => l.key === "guardrails");
    const systemAccess = YOUR_CUE_LEAVES.find((l) => l.key === "system-access");
    expect(guardrails?.to).toBe(routes.guardrails);
    expect(systemAccess?.to).toBe(routes.settings.privacy);
    expect(guardrails?.to).not.toBe(systemAccess?.to);
  });

  test("spend: one leaf, and it is Usage & spend", () => {
    const spend = YOUR_CUE_LEAVES.filter(
      (leaf) =>
        leaf.to === routes.settings.budget || leaf.to === routes.logs.usage,
    );
    expect(spend.map((l) => l.label)).toEqual(["Usage & spend"]);
  });

  test("files: Workspace is a leaf and Archive is not", () => {
    // Design's premise here did not survive the code — Archive is archived
    // CONVERSATIONS, Workspace is a file tree. They share no lifecycle, so by
    // design's own merging test they do not merge. Archive keeps its URL as a
    // Preferences sub-leaf rather than becoming a filter on a file browser it
    // has nothing to do with.
    expect(YOUR_CUE_LEAVES.some((l) => l.to === routes.workspace)).toBe(true);
    expect(YOUR_CUE_LEAVES.some((l) => l.to === routes.settings.archive)).toBe(
      false,
    );
    expect(
      YOUR_CUE_SUBLEAVES.some((s) => s.to === routes.settings.archive),
    ).toBe(true);
  });
});

describe("Connections is not a leaf", () => {
  test("no leaf points at the contacts workbench", () => {
    // It is per-person channel verification — guardian profile, verified Slack
    // id, revoke — and that data belongs on the person's row in People. It
    // stays reachable from Channels and from the channel-presence dots.
    expect(
      YOUR_CUE_LEAVES.some((leaf) => leaf.to === routes.contacts.root),
    ).toBe(false);
    expect(
      YOUR_CUE_SUBLEAVES.some((sub) => sub.to === routes.contacts.root),
    ).toBe(false);
  });
});

describe("a leaf with no surface admits it", () => {
  test("Watching has no destination and says why", () => {
    const watching = YOUR_CUE_LEAVES.find((leaf) => leaf.key === "watching");
    expect(watching?.to).toBeNull();
    expect(watching?.unavailableReason?.length).toBeGreaterThan(0);
  });

  test("Watching never claims a lookalike surface", () => {
    // Automations is where a watcher is CONFIGURED; Channels is where a source
    // is CONNECTED. Neither is "what flowed through it today".
    const watching = YOUR_CUE_LEAVES.find((leaf) => leaf.key === "watching");
    expect(watching?.match(routes.automations)).toBe(false);
    expect(watching?.match(routes.channels)).toBe(false);
    expect(watching?.match(routes.memory)).toBe(false);
  });

  test("it is the ONLY unbuilt leaf — everything else resolves", () => {
    const unbuilt = YOUR_CUE_LEAVES.filter((leaf) => leaf.to === null);
    expect(unbuilt.map((l) => l.key)).toEqual(["watching"]);
  });
});

describe("every leaf resolves to a real route", () => {
  test("each destination is an absolute /assistant path", () => {
    for (const leaf of YOUR_CUE_LEAVES) {
      if (leaf.to === null) continue;
      expect(leaf.to.startsWith("/assistant/")).toBe(true);
    }
  });

  test("each destination matches its own path", () => {
    for (const leaf of YOUR_CUE_LEAVES) {
      if (leaf.to === null) continue;
      expect(leaf.match(leaf.to)).toBe(true);
    }
  });

  test("Agents points at the org chart, not the /assistant/agents redirect", () => {
    // `routes.agentsAtWork` is a `<Navigate to={routes.hq}>`. A leaf labelled
    // Agents that lands you on HQ is an entry that lies about where it goes.
    const agents = YOUR_CUE_LEAVES.find((l) => l.key === "agents");
    expect(agents?.to).toBe(routes.hqAgents);
    expect(agents?.to).not.toBe(routes.agentsAtWork);
  });
});

describe("exactly one leaf lights at a time", () => {
  test.each([
    [routes.identity, "identity"],
    [routes.settings.brand, "brand"],
    [routes.hqAgents, "agents"],
    [routes.skills, "skills"],
    [routes.connectors, "connectors"],
    ["/assistant/connectors/slack", "connectors"],
    [routes.channels, "channels"],
    [routes.agentNetwork, "agent-network"],
    [routes.cueLive, "cue-live"],
    [routes.desktopControl, "cue-live"],
    [routes.memory, "memory"],
    [routes.settings.schedules, "schedules"],
    ["/assistant/settings/schedules/sch-1", "schedules"],
    [routes.automations, "automations"],
    [routes.guardrails, "guardrails"],
    [routes.trust, "guardrails"],
    [routes.settings.privacy, "system-access"],
    [routes.settings.ai, "models"],
    [routes.settings.budget, "usage"],
    [routes.workspace, "workspace"],
    [routes.settings.general, "preferences"],
    [routes.settings.notifications, "preferences"],
    [routes.settings.archive, "preferences"],
    [routes.settings.billing, "preferences"],
  ])("%s lights %s", (pathname, expectedKey) => {
    expect(activeYourCueLeaf(pathname)?.key).toBe(expectedKey);
  });

  test("the settings leaves do NOT also light Preferences", () => {
    // They live under `/assistant/settings/*`, so a naive prefix test would
    // light two rows at once.
    for (const path of [
      routes.settings.brand,
      routes.settings.schedules,
      routes.settings.privacy,
      routes.settings.ai,
      routes.settings.budget,
    ]) {
      const hits = YOUR_CUE_LEAVES.filter((leaf) => leaf.match(path));
      expect(hits).toHaveLength(1);
      expect(hits[0]?.key).not.toBe("preferences");
    }
  });
});

describe("the Preferences sub-row", () => {
  test("shows only on Preferences pages", () => {
    expect(isPreferencesPath(routes.settings.general)).toBe(true);
    expect(isPreferencesPath(routes.settings.sounds)).toBe(true);
    expect(isPreferencesPath(routes.settings.archive)).toBe(true);
    expect(isPreferencesPath(routes.settings.budget)).toBe(false);
    expect(isPreferencesPath(routes.guardrails)).toBe(false);
    expect(isPreferencesPath(routes.skills)).toBe(false);
  });

  test("the developer panels are marked as such", () => {
    const dev = YOUR_CUE_SUBLEAVES.filter((s) => s.developerOnly).map(
      (s) => s.key,
    );
    expect(dev).toEqual(["debug", "advanced", "developer"]);
  });
});

describe("People's interim home under Memory", () => {
  // Design's sequencing, verbatim: "ship it inside `Your Cue → Memory` as an
  // interim tab. Promote it to the sidebar when contact memories are non-zero
  // and growing." Only the sidebar-gate half shipped, so People existed
  // nowhere you could reach it.
  test("Memory carries exactly one tab, and it is People", () => {
    expect(YOUR_CUE_MEMORY_TABS.map((t) => t.key)).toEqual(["people"]);
    expect(YOUR_CUE_MEMORY_TABS[0]?.to).toBe("/assistant/memory/people");
  });

  test("the tab is a CHILD of the leaf, so Memory stays lit", () => {
    const memory = YOUR_CUE_LEAVES.find((leaf) => leaf.key === "memory");
    expect(memory?.match("/assistant/memory/people")).toBe(true);
    expect(activeYourCueLeaf("/assistant/memory/people")?.key).toBe("memory");
  });

  test("Memory itself is not listed as a tab — the leaf IS the first tab", () => {
    // The same rule that keeps General out of YOUR_CUE_SUBLEAVES. Two rows one
    // line apart pointing at the same page is the duplication this round
    // exists to remove.
    expect(YOUR_CUE_MEMORY_TABS.some((t) => t.to === "/assistant/memory")).toBe(
      false,
    );
  });

  test("the tab is not a nineteenth leaf", () => {
    expect(
      YOUR_CUE_LEAVES.some((l) => l.to === "/assistant/memory/people"),
    ).toBe(false);
  });

  test("no tab collides with a leaf or a Preferences panel", () => {
    const taken = new Set([
      ...YOUR_CUE_LEAVES.map((l) => l.to).filter(Boolean),
      ...YOUR_CUE_SUBLEAVES.map((s) => s.to),
    ]);
    for (const tab of YOUR_CUE_MEMORY_TABS) {
      expect(taken.has(tab.to)).toBe(false);
    }
  });
});

describe("one mechanism decides a leaf's sub-rows", () => {
  test("Preferences pages get the nine panels", () => {
    expect(panelsForPath("/assistant/settings/general")).toBe(
      YOUR_CUE_SUBLEAVES,
    );
    expect(isPreferencesPath("/assistant/settings/notifications")).toBe(true);
  });

  test("Memory pages get the Memory tabs", () => {
    expect(panelsForPath("/assistant/memory")).toBe(YOUR_CUE_MEMORY_TABS);
    expect(panelsForPath("/assistant/memory/people")).toBe(
      YOUR_CUE_MEMORY_TABS,
    );
    expect(isMemoryPath("/assistant/memory/people")).toBe(true);
  });

  test("every other leaf gets none", () => {
    for (const path of [
      "/assistant/identity",
      "/assistant/skills",
      "/assistant/guardrails",
      // A settings path that is a leaf in its OWN right must not borrow the
      // Preferences panels.
      "/assistant/settings/budget",
    ]) {
      expect(panelsForPath(path)).toHaveLength(0);
    }
  });
});
