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
  BRIEF_WINDOW_HOURS,
  firstBriefSentence,
  firstBriefSub,
  isBriefWindow,
  isWeeklyWindow,
  pickRitualFace,
  quietSub,
  type RitualSlotInput,
  type RitualSubSegment,
  spell,
  weeklySentence,
  WEEKLY_WINDOW_HOURS,
} from "./ritual-slot";

/** 2026-08-16 is a Sunday; 21 is the Friday, 22 the Saturday. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 7, day, hour, minute, 0);

const NOT_STARTED = { read: false, dismissed: false };

/** The whole sub-line, emphasis and all, as one readable string. */
const text = (segs: RitualSubSegment[] | null): string =>
  (segs ?? []).map((s) => s.text).join("");

function input(over: Partial<RitualSlotInput> = {}): RitualSlotInput {
  return {
    now: at(19, 7, 34), // Wednesday morning
    brief: { done: 4, needsYou: 1, by: "10:30" },
    weekly: { moved: 9, slipped: 2 },
    intake: { read: 41, yours: 12 },
    sources: 6,
    // The owner has met a brief before. The onboarding exception is its own
    // describe block below, so every other test here reads an ordinary morning.
    hasSeenBrief: true,
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
  test("the tiebreak is the general rule: the NARROWER window wins", () => {
    // Design generalised our Brief-before-11:00 special case. Stating the two
    // widths is what makes it a rule — moving a boundary moves the tiebreak
    // with it, instead of leaving a per-day case behind to disagree.
    expect(BRIEF_WINDOW_HOURS).toBeLessThan(WEEKLY_WINDOW_HOURS);
    expect(BRIEF_WINDOW_HOURS).toBe(11); // midnight → 11:00
    expect(WEEKLY_WINDOW_HOURS).toBe(60); // Friday noon → Monday
  });

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
      input({
        now: at(22, 8, 0),
        briefProgress: { read: true, dismissed: false },
      }),
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
    expect(
      pickRitualFace(input({ now: at(19, 7, 34), brief: null })),
    ).toBeNull();
  });

  test("in the weekly window with no weekly data — still nothing", () => {
    expect(
      pickRitualFace(input({ now: at(22, 15, 0), weekly: null })),
    ).toBeNull();
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
    }
  });
});

describe("R3 — the all-quiet face", () => {
  // Design's own correction: omit-rather-than-fake governs ABSENT data, not
  // UNEVENTFUL data. "Nothing happened" is a finding, and it renders.
  const quiet = (over: Partial<RitualSlotInput> = {}) =>
    pickRitualFace(input({ brief: { done: 0, needsYou: 0 }, ...over }));

  test("has no primary verb — the sentence IS the brief", () => {
    const face = quiet();
    expect(face?.state).toBe("open");
    if (face?.state !== "open") return;
    expect(face.cta).toBeNull();
    expect(face.note).toBe("Nothing to read this morning");
    expect(face.dismiss).toBe("Dismiss");
  });

  test("names what was watched — the quiet/broken distinction", () => {
    const face = quiet();
    if (face?.state !== "open") throw new Error("expected the open face");
    expect(text(face.sub)).toBe(
      "Nothing arrived, nothing needs you. Cue was watching — 6 sources, no movement.",
    );
    // The emphasis design draws sits on the clause that does the work.
    expect(face.sub?.find((s) => s.strong)?.text).toBe("Cue was watching");
    // It describes; it does not ask. No amber.
    expect(face.subTone).toBe("muted");
  });

  test("one source is one source", () => {
    expect(text(quietSub(1))).toContain("1 source, no movement.");
  });

  test("an unreadable watcher list drops the clause rather than claiming it", () => {
    // "Cue was watching" over a list we could not read is the exact false
    // reassurance the clause exists to prevent — and `?? []` there is how a
    // pending query becomes a confident "0 sources" on a healthy morning.
    const face = quiet({ intake: { read: 8, yours: 2 }, sources: null });
    if (face?.state !== "open") throw new Error("expected the open face");
    expect(text(face.sub)).toBe("Nothing arrived, nothing needs you.");
    expect(face.sub).toHaveLength(1);
  });

  test("an eventful morning keeps its verb", () => {
    const face = pickRitualFace(input());
    if (face?.state !== "open") throw new Error("expected the open face");
    expect(face.cta).toBe("Read it · 2 min");
    expect(face.note).toBeNull();
    expect(face.dismiss).toBe("Later");
  });
});

describe("R5 — suppressed, then introduced, then ordinary", () => {
  // Design overturned our suppression WITH a condition: a fresh instance with
  // nothing connected has no brief, so `EmptyOrbit` keeps the screen; the slot
  // returns on the first morning after a night with REAL INTAKE, which is a
  // different trigger from "not empty".
  const fresh = (over: Partial<RitualSlotInput> = {}) =>
    pickRitualFace(input({ hasSeenBrief: false, ...over }));

  test("nothing watched yet: the slot renders nothing, even with a brief payload", () => {
    // The brief endpoint answers on a brand-new instance — with zeros. That is
    // not a night's watching, and introducing Cue with "I've read no things"
    // is worse than saying nothing.
    expect(fresh({ intake: { read: 0, yours: 0 }, sources: 0 })).toBeNull();
  });

  test("intake unreadable: still nothing — the face is made of those figures", () => {
    expect(fresh({ intake: null })).toBeNull();
  });

  test("the first morning after real intake introduces itself", () => {
    const face = fresh();
    expect(face?.state).toBe("open");
    if (face?.state !== "open") return;
    expect(face.tone).toBe("first");
    expect(face.label).toBe("YOUR FIRST BRIEF");
    expect(face.sentence).toBe("One night in, and I've read 41 things.");
    expect(text(face.sub)).toBe(
      "Twelve looked like yours. This is what every morning looks like now.",
    );
    expect(face.sub?.find((s) => s.strong)?.text).toBe(
      "This is what every morning looks like now.",
    );
    expect(face.cta).toBe("Read it · 2 min");
  });

  test("the figures are composed, never written around", () => {
    expect(firstBriefSentence(41)).toBe(
      "One night in, and I've read 41 things.",
    );
    expect(firstBriefSentence(1)).toBe(
      "One night in, and I've read one thing.",
    );
    expect(text(firstBriefSub(1))).toStartWith("One looked like yours.");
  });

  test("the introduction reports, it does not ask — no amber behind it", () => {
    const face = fresh({ brief: { done: 4, needsYou: 3, by: "10:30" } });
    if (face?.state !== "open") throw new Error("expected the open face");
    expect(face.subTone).toBe("muted");
    expect(face.needsYou).toBe(3);
  });

  test("ordinary faces after — one boolean, not a second state machine", () => {
    const face = pickRitualFace(input({ hasSeenBrief: true }));
    if (face?.state !== "open") throw new Error("expected the open face");
    expect(face.tone).toBe("ordinary");
    expect(face.label).toBe("WEDNESDAY · YOUR BRIEF");
  });

  test("a read first brief still collapses rather than re-introducing itself", () => {
    const face = fresh({ briefProgress: { read: true, dismissed: false } });
    expect(face?.state).toBe("collapsed");
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
    // Dismissing the all-quiet face collapses it the same way — "Dismiss" is
    // the same act as "Later" wearing the word the absent verb frees up.
    const afterQuiet = pickRitualFace(
      input({
        brief: { done: 0, needsYou: 0 },
        briefProgress: { read: false, dismissed: true },
      }),
    );
    expect(afterQuiet?.state).toBe("collapsed");
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
    expect(briefSentence({ done: 0, needsYou: 0 })).toBe(
      "All quiet overnight.",
    );
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
        {
          id: "1",
          title: "a",
          state: "review",
          kind: "work_item",
          completedAt: "",
        },
        {
          id: "2",
          title: "b",
          state: "done",
          kind: "work_item",
          completedAt: "",
        },
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
    const source = await daemonComposer();
    expect(source).toContain('input.ask?.kind === "approval"');
    expect(source).toContain('input.ask?.kind === "review" && review === 0');
    expect(source).toContain(
      'input.overnight.filter((o) => o.state === "done")',
    );
  });

  test("and now it is the same SENTENCE, not just the same number", async () => {
    // Design's N2: the push becomes the sentence. The two doors no longer
    // merely agree on a count — they say the same words in the same order, so
    // an owner who reads the notification and an owner who opens Today have
    // been told the same thing. This asserts the daemon composes the three
    // shapes this file composes, with the same vocabulary.
    const source = await daemonComposer();
    expect(source).toContain("While you slept, Cue finished ${spell(done)}");
    expect(source).toContain('"Nothing finished overnight."');
    expect(source).toContain('"All quiet overnight."');
    expect(source).toContain('"One needs you"');
    expect(source).toContain("${cap(spell(needsYou))} need you");
    expect(source).toContain("before ${input.by}");
    // The shared number vocabulary. Words to twelve, numerals past it — a
    // serif sentence does not open with a numeral, on either side of the wire.
    for (const word of WORDS_IN_ORDER) expect(source).toContain(`"${word}"`);
  });
});

/** The daemon-side composer, read as text. A mirror check, not an import. */
async function daemonComposer(): Promise<string> {
  return Bun.file(
    new URL(
      "../../../../../assistant/src/notifications/morning-brief-push.ts",
      import.meta.url,
    ).pathname,
  ).text();
}

const WORDS_IN_ORDER = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

describe("no state colour is spent on a ritual being due", () => {
  test("the weekly face carries no needs-you count at all", () => {
    const face = pickRitualFace(input({ now: at(22, 15, 0) }));
    expect(face?.state).toBe("open");
    if (face?.state === "open") expect(face.needsYou).toBe(0);
  });

  test("the brief's amber is the needs-you number, not the invitation", () => {
    const nothingWaiting = pickRitualFace(
      input({ brief: { done: 4, needsYou: 0 } }),
    );
    if (nothingWaiting?.state === "open") {
      expect(nothingWaiting.needsYou).toBe(0);
      expect(nothingWaiting.sub).toBeNull();
      expect(nothingWaiting.subTone).toBe("muted");
    }
  });

  test("only the needs-you line is amber; every other sub-line describes", () => {
    const asking = pickRitualFace(input());
    if (asking?.state === "open") expect(asking.subTone).toBe("amber");
    const weekly = pickRitualFace(input({ now: at(22, 15, 0) }));
    if (weekly?.state === "open") expect(weekly.subTone).toBe("muted");
  });
});
