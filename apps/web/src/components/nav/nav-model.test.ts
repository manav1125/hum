/**
 * The navigation model's contract.
 *
 * The bug this file exists to prevent is not a broken link — it is the two
 * platforms quietly describing different information models. v10's model was
 * drawn phone-only, so the desktop rail still said "Missions" while the phone
 * had already moved to "Work", and nothing in the codebase objected. These
 * tests make that condition fail loudly.
 */

import { describe, expect, test } from "bun:test";

import {
  CUE_GROUP_CAP,
  CUE_NAV,
  MOBILE_TAB_ORDER,
  PRIMARY_NAV,
  WORK_VIEWS,
  activePrimaryKey,
  primaryDestination,
  readWorkView,
  type PrimaryNavKey,
  type WorkView,
} from "./nav-model";
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

describe("Work's two views are views, not destinations", () => {
  test("both views live on the ONE Work path", () => {
    for (const view of WORK_VIEWS) {
      expect(view.to.startsWith(routes.projects)).toBe(true);
    }
  });

  test("Things and Everything, in that order", () => {
    expect(WORK_VIEWS.map((v) => v.key)).toEqual(["things", "everything"]);
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
});

describe("the CUE group is closed at six", () => {
  // This is the test the whole pass exists for. The rail carried THIRTEEN
  // entries; a heading above them would not have helped, because a heading has
  // no arity. Adding a seventh row must fail here so the author has to decide
  // which of the six it displaces.
  test("exactly six — a seventh must displace one, not extend the list", () => {
    expect(CUE_NAV).toHaveLength(CUE_GROUP_CAP);
    expect(CUE_GROUP_CAP).toBe(6);
  });

  test("the six the design names, in order", () => {
    expect(CUE_NAV.map((d) => d.label)).toEqual([
      "Agents",
      "Skills",
      "Rhythms",
      "Memory",
      "Library",
      "Watching",
    ]);
  });

  test("Agents and Skills are adjacent — an agent's capabilities ARE its skills", () => {
    const keys = CUE_NAV.map((d) => d.key);
    expect(keys.indexOf("skills") - keys.indexOf("agents")).toBe(1);
  });

  test("every row with a destination points at a route in the registry", () => {
    const known = new Set<string>([
      routes.hqAgents,
      routes.skills,
      routes.automations,
      routes.memory,
      routes.library.root,
    ]);
    for (const destination of CUE_NAV) {
      if (destination.to === null) continue;
      expect(known.has(destination.to)).toBe(true);
    }
  });

  test("Agents points at the org chart, NOT the /assistant/agents redirect", () => {
    // `routes.agentsAtWork` is a `<Navigate to={routes.hq}>`. A row labelled
    // Agents that lands you on HQ is the exact failure this pass was told to
    // avoid: an entry that lies about where it goes.
    const agents = CUE_NAV.find((d) => d.key === "agents");
    expect(agents?.to).toBe(routes.hqAgents);
    expect(agents?.to).not.toBe(routes.agentsAtWork);
  });

  test("a row with no surface admits it instead of pointing somewhere plausible", () => {
    // Watching is specified (v17 E3) and unbuilt. `to: null` + a reason is the
    // honest state; aiming it at Channels & Agents would have looked finished
    // and been wrong — that surface is where a source is CONNECTED, not what
    // Cue did with what arrived.
    for (const destination of CUE_NAV) {
      if (destination.to !== null) continue;
      expect(destination.unavailableReason?.length).toBeGreaterThan(0);
      expect(destination.match("/assistant/channels")).toBe(false);
    }
  });

  test("no CUE row duplicates a primary destination", () => {
    const primary = new Set(PRIMARY_NAV.map((d) => d.to));
    for (const destination of CUE_NAV) {
      if (destination.to === null) continue;
      expect(primary.has(destination.to)).toBe(false);
    }
  });

  test("no two CUE rows share a destination — one door per place", () => {
    const targets = CUE_NAV.map((d) => d.to).filter(
      (to): to is string => to !== null,
    );
    expect(new Set(targets).size).toBe(targets.length);
  });
});
