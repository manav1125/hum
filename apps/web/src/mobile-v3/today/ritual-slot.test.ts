/**
 * The ritual slot's rules, pinned at a stated clock.
 *
 * Two of these are the reason the component exists at all, so they are the two
 * that get the most tests:
 *
 *   **Never both at once.** Saturday morning is the overlap design drew — the
 *   brief's window and the weekly's window are both open — and the frame is
 *   labelled `SATURDAY · YOUR BRIEF`. If this ever returns two faces, or the
 *   weekly one on a Saturday at 08:00, the component has stopped being one
 *   component.
 *
 *   **Absent, not empty.** A slot that renders with nothing in it is the exact
 *   failure "omit rather than fake" guards against, and it is invisible in a
 *   screenshot of a busy account — so it is asserted here, at every way of
 *   having no data: outside the windows, mid-read, and after a failed read.
 */

import { describe, expect, test } from "bun:test";

import {
  briefFactsFrom,
  briefNeedsYouLine,
  briefSentence,
  isBriefWindow,
  isWeeklyWindow,
  pickRitualFace,
  type RitualSlotInput,
  spell,
  weeklySentence,
} from "./ritual-slot";

/** 2026-08-16 is a Sunday; 21 is the Friday, 22 the Saturday. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 7, day, hour, minute, 0);

const NOT_STARTED = { read: false, dismissed: false };

function input(over: Partial<RitualSlotInput> = {}): RitualSlotInput {
  return {
    now: at(19, 7, 34), // Wednesday morning
    brief: { done: 4, needsYou: 1, by: "10:30" },
    weekly: { moved: 9, slipped: 2 },
    briefProgress: NOT_STARTED,
    weeklyProgress: NOT_STARTED,
    briefHref: "/assistant/brief",
    weeklyHref: "/assistant/weekly",
    ...over,
  };
}

describe("the windows", () => {
  test("the brief owns the morning and stops at 11", () => {
    expect(isBriefWindow(at(19, 7, 34))).toBe(true);
    expect(isBriefWindow(at(19, 10, 59))).toBe(true);
    expect(isBriefWindow(at(19, 11, 0))).toBe(false);
    expect(isBriefWindow(at(19, 16, 20))).toBe(false);
  });

  test("the weekly opens Friday at noon and holds the weekend", () => {
    expect(isWeeklyWindow(at(21, 11, 59))).toBe(false); // Friday morning
    expect(isWeeklyWindow(at(21, 12, 0))).toBe(true); // Friday noon
    expect(isWeeklyWindow(at(22, 8, 0))).toBe(true); // Saturday
    expect(isWeeklyWindow(at(23, 21, 0))).toBe(true); // Sunday night
    expect(isWeeklyWindow(at(24, 9, 0))).toBe(false); // Monday
  });
});

describe("never both at once", () => {
  test("Friday morning is the brief; Friday noon swaps to the weekly", () => {
    const morning = pickRitualFace(input({ now: at(21, 8, 0) }));
    expect(morning?.kind).toBe("brief");

    const noon = pickRitualFace(input({ now: at(21, 12, 30) }));
    expect(noon?.kind).toBe("weekly");
  });

  test("Saturday morning — both windows open — still shows the brief", () => {
    const face = pickRitualFace(input({ now: at(22, 8, 0) }));
    expect(face?.kind).toBe("brief");
    expect(face?.state).toBe("open");
    if (face?.state === "open") {
      expect(face.label).toBe("SATURDAY · YOUR BRIEF");
    }
  });

  test("Saturday afternoon, the brief window closed, hands over to the weekly", () => {
    const face = pickRitualFace(input({ now: at(22, 15, 0) }));
    expect(face?.kind).toBe("weekly");
  });

  test("a read brief does NOT promote the weekly into the morning slot", () => {
    // The brief collapses; it does not vacate. Otherwise reading the brief on
    // a Saturday morning would silently produce the other ritual, and the two
    // faces would be one tap apart — which is "both at once" over time.
    const face = pickRitualFace(
      input({ now: at(22, 8, 0), briefProgress: { read: true, dismissed: false } }),
    );
    expect(face?.kind).toBe("brief");
    expect(face?.state).toBe("collapsed");
  });
});

describe("absent, not empty", () => {
  test("nothing due — a Wednesday afternoon — renders nothing", () => {
    expect(pickRitualFace(input({ now: at(19, 14, 0) }))).toBeNull();
  });

  test("in the window but the brief could not be read — still nothing", () => {
    expect(pickRitualFace(input({ now: at(19, 7, 34), brief: null }))).toBeNull();
  });

  test("in the weekly window with no weekly data — still nothing", () => {
    expect(pickRitualFace(input({ now: at(22, 15, 0), weekly: null }))).toBeNull();
  });

  test("a quiet night is data, and still opens the slot", () => {
    // The push goes out on a quiet night ("All quiet overnight"), so the slot
    // must too — otherwise the two doors disagree about whether there was one.
    const face = pickRitualFace(
      input({ now: at(19, 7, 34), brief: { done: 0, needsYou: 0 } }),
    );
    expect(face?.state).toBe("open");
    if (face?.state === "open") {
      expect(face.sentence).toBe("All quiet overnight.");
      expect(face.sub).toBeNull();
    }
  });
});

describe("collapsing", () => {
  test('"Later" collapses to one row that still opens the surface', () => {
    const face = pickRitualFace(
      input({ briefProgress: { read: false, dismissed: true } }),
    );
    expect(face).toEqual({
      state: "collapsed",
      kind: "brief",
      label: "TODAY'S BRIEF",
      cta: "Read it ›",
      href: "/assistant/brief",
    });
  });

  test("a read weekly collapses to its own row", () => {
    const face = pickRitualFace(
      input({
        now: at(22, 15, 0),
        weeklyProgress: { read: true, dismissed: false },
      }),
    );
    expect(face?.state).toBe("collapsed");
    expect(face?.cta).toBe("Look back ›");
  });
});

describe("the copy is composed from the counts, never chosen", () => {
  test("the brief's sentence follows the push's three shapes", () => {
    expect(briefSentence({ done: 4, needsYou: 1 })).toBe(
      "While you slept, Cue finished four things.",
    );
    expect(briefSentence({ done: 1, needsYou: 0 })).toBe(
      "While you slept, Cue finished one thing.",
    );
    expect(briefSentence({ done: 0, needsYou: 2 })).toBe(
      "Nothing finished overnight.",
    );
    expect(briefSentence({ done: 0, needsYou: 0 })).toBe("All quiet overnight.");
  });

  test("the amber line states a deadline only when there is one", () => {
    expect(briefNeedsYouLine({ needsYou: 1, by: "10:30" })).toBe(
      "One needs you before 10:30.",
    );
    expect(briefNeedsYouLine({ needsYou: 1 })).toBe("One needs you.");
    expect(briefNeedsYouLine({ needsYou: 3 })).toBe("Three need you.");
    expect(briefNeedsYouLine({ needsYou: 0, by: "10:30" })).toBeNull();
  });

  test("the weekly states both halves, including the good zero", () => {
    expect(weeklySentence({ moved: 9, slipped: 2 })).toBe(
      "Nine things moved. Two slipped.",
    );
    expect(weeklySentence({ moved: 9, slipped: 0 })).toBe(
      "Nine things moved. Nothing slipped.",
    );
    expect(weeklySentence({ moved: 0, slipped: 1 })).toBe(
      "Nothing moved. One slipped.",
    );
    expect(weeklySentence({ moved: 0, slipped: 0 })).toBe("A quiet week.");
  });

  test("numbers past twelve stop being words", () => {
    expect(spell(12)).toBe("twelve");
    expect(spell(13)).toBe("13");
    expect(spell(-1)).toBe("no");
  });
});

describe("the push and the slot are one door", () => {
  test("the slot's needs-you count is the push's, on the same payload", () => {
    // The exact case the push had to fix: a review-kind ask older than the
    // overnight window, with nothing in the window. Counting only the window
    // would print "All quiet" over work that is genuinely waiting.
    const facts = briefFactsFrom({
      generatedAt: "",
      since: "",
      overnight: [],
      ask: { id: "a", kind: "review", title: "Sign off", actions: [] },
      day: [],
      calendarAvailable: false,
    });
    expect(facts).toEqual({ done: 0, needsYou: 1 });

    // An approval adds to the review count rather than replacing it.
    const both = briefFactsFrom({
      generatedAt: "",
      since: "",
      overnight: [
        { id: "1", title: "a", state: "review", kind: "work_item", completedAt: "" },
        { id: "2", title: "b", state: "done", kind: "work_item", completedAt: "" },
      ],
      ask: { id: "a", kind: "approval", title: "Pay", actions: [] },
      day: [],
      calendarAvailable: false,
    });
    expect(both).toEqual({ done: 1, needsYou: 2 });
  });

  test("the deadline comes off the day, and only when the day has one", () => {
    const base = {
      generatedAt: "",
      since: "",
      overnight: [],
      ask: null,
      calendarAvailable: true,
    };
    const allDayOnly = briefFactsFrom({
      ...base,
      day: [{ title: "Public holiday", kind: "event" as const }],
    });
    expect(allDayOnly?.by).toBeUndefined();

    const timed = briefFactsFrom({
      ...base,
      day: [
        { title: "Public holiday", kind: "event" as const },
        {
          title: "Standup",
          kind: "event" as const,
          time: new Date(2026, 7, 19, 10, 30).toISOString(),
        },
      ],
    });
    // Locale decides 12h vs 24h — the assertion is that it is THAT time, and
    // formatted by the same helper the Brief surface itself uses.
    expect(timed?.by).toContain("10:30");
  });

  test("that rule is still the daemon's rule", async () => {
    // A mirror, not a source. `composeMorningBriefCopy` owns the definition of
    // "needs your OK"; if the daemon's rule moves, this fails rather than the
    // card and the notification quietly disagreeing on a number in front of
    // the owner.
    const source = await Bun.file(
      new URL(
        "../../../../../assistant/src/notifications/morning-brief-push.ts",
        import.meta.url,
      ).pathname,
    ).text();
    expect(source).toContain('input.ask?.kind === "approval"');
    expect(source).toContain('input.ask?.kind === "review" && review === 0');
    expect(source).toContain('input.overnight.filter((o) => o.state === "done")');
  });
});

describe("no state colour is spent on a ritual being due", () => {
  test("the weekly face carries no needs-you count at all", () => {
    const face = pickRitualFace(input({ now: at(22, 15, 0) }));
    expect(face?.state).toBe("open");
    if (face?.state === "open") expect(face.needsYou).toBe(0);
  });

  test("the brief's amber is the needs-you number, not the invitation", () => {
    const quiet = pickRitualFace(
      input({ brief: { done: 4, needsYou: 0 } }),
    );
    if (quiet?.state === "open") {
      expect(quiet.needsYou).toBe(0);
      expect(quiet.sub).toBeNull();
    }
  });
});
