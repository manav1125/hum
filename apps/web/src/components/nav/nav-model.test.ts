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
  CUE_NAV,
  MOBILE_TAB_ORDER,
  PEOPLE_ROW_MIN_MEMORIES,
  PRIMARY_NAV,
  SIDEBAR_DESTINATIONS,
  WORK_VIEWS,
  YOUR_CUE_DOOR,
  activePrimaryKey,
  primaryDestination,
  readWorkView,
  shouldShowPeopleRow,
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

describe("the sidebar's Tier-2 rows are one column", () => {
  // The bug: v20 laid these out as a two-column grid to fit six rows in, and
  // the live app rendered "Watching" as "Wat…". Design's ruling — a grid reads
  // as a keypad, breaks vertical scanning, truncates labels — is enforced here
  // structurally rather than in CSS: with two entries there is nothing to pair
  // off into columns, and a third would have to argue for itself.
  test("exactly two rows survive — People and Library", () => {
    expect(SIDEBAR_DESTINATIONS.map((d) => d.key)).toEqual([
      "people",
      "library",
    ]);
  });

  test("both pass the admission test: the data accumulates on its own", () => {
    // Agents, Skills, Rhythms and Watching do not — you go to those to change
    // something, which makes them leaves inside Your Cue.
    for (const destination of SIDEBAR_DESTINATIONS) {
      expect(destination.to.startsWith("/assistant/")).toBe(true);
    }
    expect(SIDEBAR_DESTINATIONS.map((d) => d.to)).toEqual([
      routes.people,
      routes.library.root,
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

describe("the People gate", () => {
  // Design would not promote People on the strength of the code existing:
  // "A prominent destination with 2 rows teaches people the slot is
  // worthless." The live instance has 2 contacts and 0 memories.

  test("the live instance's numbers — 2 contacts, 0 memories — keep it hidden", () => {
    expect(shouldShowPeopleRow({ contactCount: 2, memoryCount: 0 })).toBe(
      false,
    );
  });

  test("contacts without memories are not enough — that is the 697 no-op case", () => {
    // Contact extraction ran 697 times, completed every time, and wrote
    // nothing. Gating on contact count alone would have shown the row through
    // all of it.
    expect(shouldShowPeopleRow({ contactCount: 214, memoryCount: 0 })).toBe(
      false,
    );
  });

  test("memories without contacts are not enough either", () => {
    expect(shouldShowPeopleRow({ contactCount: 0, memoryCount: 9 })).toBe(
      false,
    );
  });

  test("one real memory against a real contact promotes the row", () => {
    expect(
      shouldShowPeopleRow({
        contactCount: 2,
        memoryCount: PEOPLE_ROW_MIN_MEMORIES,
      }),
    ).toBe(true);
  });

  test("no signal is not evidence — a failed or pending read hides the row", () => {
    // Withholding the row costs a click. Showing an empty one costs trust in
    // every other row beside it.
    expect(shouldShowPeopleRow(null)).toBe(false);
    expect(shouldShowPeopleRow(undefined)).toBe(false);
  });

  test("the bar is one memory — the failure guarded against is silence, not scale", () => {
    expect(PEOPLE_ROW_MIN_MEMORIES).toBe(1);
  });
});

describe("Your Cue is the one door", () => {
  test("the door lands on a route in the registry", () => {
    expect(YOUR_CUE_DOOR.to).toBe(routes.yourCue);
  });

  test.each([
    routes.identity,
    routes.skills,
    routes.memory,
    routes.guardrails,
    routes.hqAgents,
    routes.workspace,
    routes.connectors,
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
  ])("%s does NOT light the door", (pathname) => {
    expect(YOUR_CUE_DOOR.match(pathname)).toBe(false);
  });

  test("the door is not one of the sidebar destinations", () => {
    const targets = new Set(SIDEBAR_DESTINATIONS.map((d) => d.to));
    expect(targets.has(YOUR_CUE_DOOR.to)).toBe(false);
  });
});

describe("CUE_NAV survives only for the phone's ◍ menu", () => {
  // Deliberately unchanged: `mobile-v3/overflow-menu.tsx` renders it and the
  // phone follows the v3 native spec, which this round did not review.
  // Restructuring it here would have silently redesigned a surface nobody
  // looked at.
  test("still the six the phone's menu expects", () => {
    expect(CUE_NAV.map((d) => d.label)).toEqual([
      "Agents",
      "Skills",
      "Rhythms",
      "Memory",
      "Library",
      "Watching",
    ]);
  });

  test("its unbuilt row still admits it rather than pointing at a lookalike", () => {
    const watching = CUE_NAV.find((d) => d.key === "watching");
    expect(watching?.to).toBeNull();
    expect(watching?.unavailableReason?.length).toBeGreaterThan(0);
  });
});
