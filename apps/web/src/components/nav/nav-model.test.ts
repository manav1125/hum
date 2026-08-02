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
  DEEPER_NAV,
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

describe("deeper surfaces", () => {
  test("the five the design names, in order", () => {
    expect(DEEPER_NAV.map((d) => d.label)).toEqual([
      "Agents",
      "Rhythms",
      "People",
      "What Cue does",
      "Trust & guardrails",
    ]);
  });

  test("every deeper surface points at a route that exists in the registry", () => {
    const known = new Set<string>([
      routes.hqAgents,
      routes.automations,
      routes.people,
      routes.explore,
      routes.guardrails,
    ]);
    for (const destination of DEEPER_NAV) {
      expect(known.has(destination.to)).toBe(true);
    }
  });

  test("no deeper surface duplicates a primary destination", () => {
    const primary = new Set(PRIMARY_NAV.map((d) => d.to));
    for (const destination of DEEPER_NAV) {
      expect(primary.has(destination.to)).toBe(false);
    }
  });
});
