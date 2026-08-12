/**
 * The navigation model's contract.
 *
 * The bug this file exists to prevent is not a broken link — it is the two
 * platforms quietly describing different information models. v10's model was
 * drawn phone-only, so the desktop rail still said "Missions" while the phone
 * had already moved to "Work", and nothing in the codebase objected. These
 * tests make that condition fail loudly.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  MOBILE_DRAWER_DESTINATION_KEYS,
  MOBILE_TAB_ORDER,
  PRIMARY_NAV,
  SIDEBAR_DESTINATIONS,
  WORK_VIEWS,
  YOUR_CUE_DOOR,
  activePrimaryKey,
  primaryDestination,
  readWorkView,
  tabLabel,
  type PrimaryNavKey,
  type WorkView,
} from "./nav-model";
import { YOUR_CUE_LEAVES } from "./your-cue-model";
import { routes } from "@/utils/routes";

describe("the two platforms agree", () => {
  test("the phone's tabs and the desktop rail carry the SAME three destinations", () => {
    expect([...MOBILE_TAB_ORDER].sort()).toEqual(
      PRIMARY_NAV.map((d) => d.key).sort(),
    );
  });

  test("there are exactly three primary destinations", () => {
    // Five phone tabs is what squeezed the actual work; three is the design.
    expect(PRIMARY_NAV).toHaveLength(3);
    expect(MOBILE_TAB_ORDER).toHaveLength(3);
  });

  test("the mark is the phone's CENTRE tab, not a floating no-op", () => {
    expect(MOBILE_TAB_ORDER[1]).toBe("talk");
  });

  test("every phone tab key resolves to a real destination with a label and a route", () => {
    for (const key of MOBILE_TAB_ORDER) {
      const destination = primaryDestination(key);
      expect(destination.label.length).toBeGreaterThan(0);
      expect(destination.to.startsWith("/")).toBe(true);
    }
  });

  test("labels are identical across platforms — they come from one place", () => {
    expect(PRIMARY_NAV.map((d) => d.label).sort()).toEqual([
      "HQ",
      "Talk to Cue",
      "Work",
    ]);
  });

  test("the phone's shorter labels are declared, not computed at the call site", () => {
    // v24's final frames print `Today` under the phone's first glyph and the
    // mark's label is `Cue`; the rail keeps `HQ` and `Talk to Cue`, which are
    // the words a wide row has space for. One declaration either way — the
    // tab bar used to carry an inline ternary nobody could read from here.
    expect(
      MOBILE_TAB_ORDER.map((k) => tabLabel(primaryDestination(k))),
    ).toEqual(["Today", "Cue", "Work"]);
  });
});

describe("what each destination claims", () => {
  test.each([
    ["/assistant/hq", "hq"],
    ["/assistant/hq/setup", "hq"],
    ["/assistant/home", "hq"],
    ["/assistant/mission-control", "hq"],
    ["/assistant/activity", "hq"],
    ["/assistant/next-moves", "hq"],
    ["/assistant/dashboard", "hq"],
    ["/assistant/projects", "work"],
    ["/assistant/projects/proj-1", "work"],
    ["/assistant/work", "work"],
    ["/assistant/work/wi-1/live", "work"],
    ["/assistant", "talk"],
    ["/assistant/conversations", "talk"],
    ["/assistant/conversations/abc", "talk"],
  ] as [string, PrimaryNavKey][])("%s lights %s", (pathname, expected) => {
    expect(activePrimaryKey(pathname)).toBe(expected);
  });

  test("the agent org chart is a deeper surface — it does NOT light HQ", () => {
    // Lighting HQ two levels into the roster would claim the user is on the
    // landing deck when they are not.
    expect(activePrimaryKey("/assistant/hq/agents")).toBeNull();
  });

  test("no two destinations claim the same path", () => {
    const paths = [
      "/assistant",
      "/assistant/hq",
      "/assistant/projects",
      "/assistant/work",
      "/assistant/conversations",
      "/assistant/settings",
    ];
    for (const path of paths) {
      const claimants = PRIMARY_NAV.filter((d) => d.match(path));
      expect(claimants.length).toBeLessThanOrEqual(1);
    }
  });

  test("settings is nobody's primary destination", () => {
    expect(activePrimaryKey("/assistant/settings/general")).toBeNull();
  });
});

describe("Work's views are views, not destinations", () => {
  test("both views live on the ONE Work path", () => {
    for (const view of WORK_VIEWS) {
      expect(view.to.startsWith(routes.projects)).toBe(true);
    }
  });

  test("Things, Everything and Library, in that order", () => {
    expect(WORK_VIEWS.map((v) => v.key)).toEqual([
      "things",
      "everything",
      "library",
    ]);
  });

  test("both views light the Work tab — switching view never changes tab", () => {
    for (const view of WORK_VIEWS) {
      const pathname = view.to.split("?")[0]!;
      expect(activePrimaryKey(pathname)).toBe("work");
    }
  });

  test.each([
    ["?view=everything", "everything"],
    ["?view=things", "things"],
    ["", "things"],
    ["?view=", "things"],
    // A malformed value must land on a real screen, never a blank one.
    ["?view=nonsense", "things"],
    ["?other=everything", "things"],
  ] as [string, WorkView][])("readWorkView(%p) is %p", (search, expected) => {
    expect(readWorkView(search)).toBe(expected);
  });

  test("readWorkView accepts URLSearchParams as well as a string", () => {
    expect(readWorkView(new URLSearchParams("view=everything"))).toBe(
      "everything",
    );
  });

  test("every view is readable back off its own URL", () => {
    // A view that exists in the segmented control but not in the parser is a
    // segment that renders the WRONG page — silently, and only for that one.
    // The parser is derived from this list for exactly that reason.
    for (const view of WORK_VIEWS) {
      expect(readWorkView(view.to.slice(view.to.indexOf("?")))).toBe(view.key);
    }
  });
});

describe("the sidebar's Tier-2 rows are one column", () => {
  // The bug: v20 laid these out as a two-column grid and the live app rendered
  // "Watching" as "Wat…". Design's ruling — a grid reads as a keypad, breaks
  // vertical scanning, truncates labels — is enforced here structurally rather
  // than in CSS. The SET has grown twice by owner decision over the original
  // accumulation test: Apps (2026-08-10), then Connectors/Skills/Agents
  // (2026-08-11, "key places to understand the breadth of the product"). Apps
  // is flag-gated dark; the other three are ungated product-surface rows.
  test("the six rows, in order — People, Library, Apps, Connectors, Skills, Agents", () => {
    expect(SIDEBAR_DESTINATIONS.map((d) => d.key)).toEqual([
      "people",
      "library",
      "apps",
      "connectors",
      "skills",
      "agents",
    ]);
  });

  test("only Apps is flag-gated — every other row is ungated", () => {
    expect(SIDEBAR_DESTINATIONS.map((d) => d.flag ?? null)).toEqual([
      null,
      null,
      "ventureverseApps",
      null,
      null,
      null,
    ]);
  });

  test("every row lands on an assistant route", () => {
    for (const destination of SIDEBAR_DESTINATIONS) {
      expect(destination.to.startsWith("/assistant/")).toBe(true);
    }
    expect(SIDEBAR_DESTINATIONS.map((d) => d.to)).toEqual([
      routes.people,
      routes.library.root,
      routes.ventureverseApps.root,
      routes.connectors,
      routes.skills,
      routes.hqAgents,
    ]);
  });

  test("no sidebar row duplicates a primary destination", () => {
    const primary = new Set(PRIMARY_NAV.map((d) => d.to));
    for (const destination of SIDEBAR_DESTINATIONS) {
      expect(primary.has(destination.to)).toBe(false);
    }
  });

  test("no two rows share a destination — one door per place", () => {
    const targets = SIDEBAR_DESTINATIONS.map((d) => d.to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe("People is ungated — the owner overruled design", () => {
  // Design's ruling was: promote People only when contact memories are
  // non-zero and growing week-over-week. The owner overruled it directly —
  // *"people is still buried and should be out near library as we want to
  // surface that ... it's nice for people to think this is a crm / people
  // system that will learn and grow."*
  //
  // These tests exist so the gate cannot come back by accident. It was
  // DELETED, not stubbed: a predicate that exists but never closes is worse
  // than none, because the next reader assumes it works.

  test("the module exports no People gate at all", async () => {
    const model = await import("./nav-model");
    expect("shouldShowPeopleRow" in model).toBe(false);
    expect("PEOPLE_ROW_MIN_MEMORIES" in model).toBe(false);
    expect("PeopleSignal" in model).toBe(false);
  });

  test("People sits beside Library, People first, per the final brief", () => {
    // The brief's block is `👤 People / ▦ Library`; the owner-added rows (Apps,
    // then Connectors/Skills/Agents) join BELOW the pair, never between them.
    expect(SIDEBAR_DESTINATIONS.map((d) => d.key)).toEqual([
      "people",
      "library",
      "apps",
      "connectors",
      "skills",
      "agents",
    ]);
  });

  test("People lands on the standalone surface, not the old Memory tab", () => {
    const people = SIDEBAR_DESTINATIONS.find((d) => d.key === "people");
    expect(people?.to).toBe(routes.people);
    expect(people?.to).not.toBe(routes.memoryPeople);
  });

  test("the People row lights on its own surface and its children", () => {
    const people = SIDEBAR_DESTINATIONS.find((d) => d.key === "people");
    expect(people?.match(routes.people)).toBe(true);
    expect(people?.match(`${routes.people}/abc`)).toBe(true);
    expect(people?.match(routes.library.root)).toBe(false);
  });
});

describe("Your Cue is the one door", () => {
  test("the door lands on a route in the registry", () => {
    expect(YOUR_CUE_DOOR.to).toBe(routes.yourCue);
  });

  test.each([
    routes.identity,
    routes.memory,
    routes.guardrails,
    routes.workspace,
    routes.channels,
    routes.agentNetwork,
    routes.cueLive,
    routes.automations,
    // Settings was absorbed — every one of its URLs lights the same door.
    routes.settings.general,
    routes.settings.ai,
    routes.settings.budget,
    routes.settings.privacy,
    routes.settings.brand,
    routes.settings.schedules,
    routes.settings.archive,
  ])("%s lights the door", (pathname) => {
    expect(YOUR_CUE_DOOR.match(pathname)).toBe(true);
  });

  test.each([
    "/assistant",
    "/assistant/hq",
    "/assistant/projects",
    "/assistant/people",
    "/assistant/library",
    "/assistant/conversations/abc",
    // Promoted to Tier-2 rail rows (2026-08-11) — their own row lights, not the
    // door. See SIDEBAR_DESTINATIONS / YOUR_CUE_LEAF_PATHS.
    routes.connectors,
    routes.skills,
    routes.hqAgents,
  ])("%s does NOT light the door", (pathname) => {
    expect(YOUR_CUE_DOOR.match(pathname)).toBe(false);
  });

  test("the door is not one of the sidebar destinations", () => {
    const targets = new Set(SIDEBAR_DESTINATIONS.map((d) => d.to));
    expect(targets.has(YOUR_CUE_DOOR.to)).toBe(false);
  });
});

describe("CUE_NAV is gone, and stays gone", () => {
  /**
   * The retired desktop model (Agents · Skills · Rhythms · Memory · Library ·
   * Watching). Its own docstring asked to be deleted "when the phone's ◍ menu
   * is next revisited" — v23 C6 revisited it, so this is that.
   *
   * The test is a grep rather than a type check on purpose: TypeScript can
   * only tell you the symbol is missing from the files that import it, and the
   * whole failure mode here was a constant nobody imported *on desktop* while
   * one phone file kept it alive for two rounds.
   */
  test("no source file mentions it", () => {
    const root = join(import.meta.dir, "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "generated") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        // This file names it in prose, which is the point of the test.
        if (full.endsWith("nav-model.test.ts")) continue;
        // Comments are stripped first: the name survives in prose that
        // explains the deletion, and a docstring is not a reader.
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        if (code.includes("CUE_NAV")) {
          hits.push(full.replace(root, ""));
        }
      }
    };
    walk(root);
    expect(
      hits,
      `CUE_NAV is the retired desktop nav model. Read \`your-cue-model.ts\`
(configuration leaves) or \`SIDEBAR_DESTINATIONS\` (what accumulates)
instead.\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * Every rail row needs a door on a phone.
 *
 * The rail is desktop-only — `chat-layout` renders `AssistantSideMenu` in the
 * `!isMobile` branch and `Mv3ChatsIndex` in the mobile one — so a row added to
 * `SIDEBAR_DESTINATIONS` reaches a phone only if something else carries it.
 * `apps` was added to the rail with no leaf behind it and was consequently
 * unreachable on mobile: the owner installed a TestFlight build containing the
 * native overlay that renders an embedded app, and had no way to open one.
 *
 * This is the second unreachable destination on this branch — see
 * `your-cue-reachable.test.tsx`, which drives the real chrome for Your Cue's
 * door. That one proves a specific door works; this one proves no row is
 * *missing* a door, which is the failure that keeps recurring.
 */
describe("every rail row is reachable on a phone", () => {
  /**
   * Rows whose phone door is something other than the drawer, and what it is.
   * Anything not listed here and not in the drawer list is unreachable — the
   * table has to be maintained deliberately, which is the point.
   */
  const DOOR_ELSEWHERE: Record<string, string> = {
    talk: "primary mobile tab (◉)",
    hq: "primary mobile tab (HQ)",
    people: "a mobile surface in its own right",
    library: "a mobile surface in its own right",
    connectors: "Your Cue leaf, reached via the avatar",
    skills: "Your Cue leaf, reached via the avatar",
    agents: "Your Cue leaf, reached via the avatar",
  };

  test("a row with no door elsewhere must be carried by the drawer", () => {
    const unreachable = SIDEBAR_DESTINATIONS.map((d) => d.key)
      .filter((key) => !(key in DOOR_ELSEWHERE))
      .filter((key) => !MOBILE_DRAWER_DESTINATION_KEYS.includes(key));
    expect(
      unreachable,
      `These rail rows have no way to be opened on a phone. Either add the key
to \`MOBILE_DRAWER_DESTINATION_KEYS\` and render it in \`Mv3ChatsIndex\`, or
give it a Your Cue leaf and record that in \`DOOR_ELSEWHERE\`.
Unreachable: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  test("the rows claimed as Your Cue leaves really are leaves", () => {
    // Without this the table above could claim a door that does not exist —
    // which is exactly how `apps` came to be believed reachable.
    const leafKeys = new Set(YOUR_CUE_LEAVES.map((l) => l.key));
    for (const key of ["connectors", "skills", "agents"]) {
      expect(leafKeys.has(key), `${key} is not a Your Cue leaf`).toBe(true);
    }
  });

  test("MUTATION CHECK: apps is NOT a Your Cue leaf", () => {
    // If it ever becomes one, the drawer row is a second path to one
    // destination — the duplication this nav round exists to remove — and
    // should be deleted rather than left as a convenience.
    const leafKeys = new Set(YOUR_CUE_LEAVES.map((l) => l.key));
    expect(leafKeys.has("apps")).toBe(false);
    expect(MOBILE_DRAWER_DESTINATION_KEYS).toContain("apps");
  });
});
