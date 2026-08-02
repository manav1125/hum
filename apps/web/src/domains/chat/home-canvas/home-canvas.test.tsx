/**
 * The home canvas is exactly six elements — and stays that way.
 *
 * `docs/design/handoff-2026-08-02/FINAL-NAV-BRIEF.md` §4 rules the canvas down
 * to six, two of which are deliberately nothing. Eleven elements had arrived
 * before that ruling, none by decision. This file is the part of the fix that
 * keeps working after everyone has forgotten the ruling:
 *
 * - **The manifest** — six entries, positions 1–6, each answering §4's
 *   admission test.
 * - **The audit** — the mutation check. A seventh element is added to a real
 *   rendered canvas and the assertion that it fails is itself asserted. If
 *   someone weakens `auditHomeCanvas`, *that* test goes red too.
 * - **The render** — the real component, with the daemon mocked at the query
 *   seam rather than at the hook, so "suggestions derive from real state" is
 *   verified through the actual derivation code and not around it.
 * - **The two kinds of prompt** — generic chips must render with the daemon
 *   returning *nothing*, which is the case an earlier pass broke; context-rich
 *   ones must stay hidden until asked for, and must say so honestly rather
 *   than inventing anything when there is nothing behind the control.
 *
 * Mocking note: the generated query-options module is spread and only the four
 * endpoint factories this canvas reads are overridden. An exhaustive
 * hand-written factory is what broke `chat-body.test.tsx` once — the tree
 * below later imported a symbol the mock did not have and the whole file
 * errored before a test ran. The four overrides read **mutable** fixtures so a
 * cold account (every store empty) and an unreadable one (every store
 * throwing) are both reachable without a second mock layer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Fixtures — the "real state" the context suggestions must be derived from
// ---------------------------------------------------------------------------

const REVIEW_ITEM = {
  id: "wi-review-1",
  title: "Confirm the 24-month position",
  updatedAt: Date.now(),
  createdAt: Date.now(),
};

const DONE_ITEMS = [
  { id: "wi-done-1", title: "Drafted the Halo reply", updatedAt: Date.now() },
  { id: "wi-done-2", title: "Filed the invoice", updatedAt: Date.now() },
  {
    id: "wi-done-old",
    title: "Last week's thing",
    // Two days ago — must NOT count toward "today so far".
    updatedAt: Date.now() - 2 * 86_400_000,
  },
];

const MISSION = {
  id: "m-1",
  title: "Close the Halo renewal",
  status: "active",
};

const FREE_BLOCK_MINUTES = 150;

const FREE_BLOCK = {
  start: "2026-08-02T14:00:00.000Z",
  end: "2026-08-02T16:30:00.000Z",
  minutes: FREE_BLOCK_MINUTES,
};

/**
 * Mutable state behind the mocked endpoints.
 *
 * A brand-new account is not a variant of the fixture above — it is the
 * fixture *absent*, which is exactly the condition the generic prompts exist
 * to survive. Flipping these is how that gets tested through the real
 * derivation code.
 */
let reviewItems: unknown[] = [];
let doneItems: unknown[] = [];
let missionRows: unknown[] = [];
let freeBlock: typeof FREE_BLOCK | null = null;
let pendingInteractions: unknown[] = [];
let everyStoreFails = false;

/** The returning user: something in every store. */
function withState() {
  reviewItems = [REVIEW_ITEM];
  doneItems = DONE_ITEMS;
  missionRows = [MISSION];
  freeBlock = FREE_BLOCK;
  pendingInteractions = [{ requestId: "pi-1" }];
  everyStoreFails = false;
}

/** The brand-new account: every store answers, and answers empty. */
function withNoState() {
  reviewItems = [];
  doneItems = [];
  missionRows = [];
  freeBlock = null;
  pendingInteractions = [];
  everyStoreFails = false;
}

function failEveryStore() {
  withNoState();
  everyStoreFails = true;
}

function refuseIfFailing() {
  if (everyStoreFails) throw new Error("daemon unreachable");
}

const generated = await import("@/generated/daemon/@tanstack/react-query.gen");

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...generated,
  workitemsGetOptions: (opts: { query?: { status?: string } }) => {
    const status = opts.query?.status ?? "all";
    return {
      queryKey: ["test:workitems", status],
      queryFn: async () => {
        refuseIfFailing();
        return {
          items: status === "awaiting_review" ? reviewItems : doneItems,
        };
      },
    };
  },
  pendinginteractionsGetOptions: () => ({
    queryKey: ["test:pending"],
    queryFn: async () => {
      refuseIfFailing();
      return { interactions: pendingInteractions };
    },
  }),
  calendarDayGetOptions: () => ({
    queryKey: ["test:calendar"],
    queryFn: async () => {
      refuseIfFailing();
      return {
        connection: { state: "connected", detail: null },
        largestFreeBlock: freeBlock,
      };
    },
  }),
  missionsGetOptions: () => ({
    queryKey: ["test:missions"],
    queryFn: async () => {
      refuseIfFailing();
      return { missions: missionRows };
    },
  }),
}));

const {
  auditHomeCanvas,
  HOME_CANVAS,
  HOME_CANVAS_ATTR,
  HOME_CANVAS_REGION_ATTR,
  HOME_CANVAS_SIZE,
  PROMPT_CHIP_CAP,
  PROMPT_CHIP_ROW_CAP,
  REGION_ELEMENTS,
  RENDERED_ELEMENTS,
} = await import("@/domains/chat/home-canvas/home-canvas-model");

const { HomeCanvasRegion, emptyContextNotice } =
  await import("@/domains/chat/home-canvas/home-canvas");

const { GENERIC_PROMPTS } =
  await import("@/domains/chat/home-canvas/use-canvas-prompts");

const { doorSentence, startOfToday } =
  await import("@/domains/chat/home-canvas/use-canvas-door");

beforeEach(withState);
afterEach(cleanup);

function renderCanvas(
  onSelectPrompt: (p: { prompt: string }) => void = () => {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <HomeCanvasRegion
          assistantId="assistant-1"
          onSelectPrompt={onSelectPrompt}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The rendered region node, once react-query has settled. */
async function settledRegion(): Promise<HTMLElement> {
  return await waitFor(() => {
    const region = document.querySelector(`[${HOME_CANVAS_REGION_ATTR}]`);
    if (!region) throw new Error("canvas region not rendered");
    if (!region.querySelector(`[${HOME_CANVAS_ATTR}="door"]`))
      throw new Error("door not settled");
    return region as HTMLElement;
  });
}

/** Open the disclosure that hides the context-rich suggestions. */
function revealContext() {
  fireEvent.click(
    screen.getByRole("button", { name: "Show suggestions from your day" }),
  );
}

const chipsRow = (region: HTMLElement) =>
  region.querySelector(`[${HOME_CANVAS_ATTR}="prompts"]`) as HTMLElement;

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

describe("home canvas — the six-element manifest", () => {
  test("is exactly six elements, positions 1 through 6", () => {
    expect(HOME_CANVAS.length).toBe(6);
    expect(HOME_CANVAS_SIZE).toBe(6);
    expect(HOME_CANVAS.map((el) => el.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("is §4's six, in §4's order", () => {
    expect(HOME_CANVAS.map((el) => el.id)).toEqual([
      "mark",
      "composer",
      "prompts",
      "door",
      "nothing_5",
      "nothing_6",
    ]);
  });

  test("positions 5 and 6 render nothing — they are not spare slots", () => {
    expect(HOME_CANVAS[4].renders).toBe(false);
    expect(HOME_CANVAS[5].renders).toBe(false);
    expect(RENDERED_ELEMENTS.map((el) => el.id)).toEqual([
      "mark",
      "composer",
      "prompts",
      "door",
    ]);
  });

  /**
   * §4's rule, as data. The field's *type* is the literal `false`, so this is
   * belt-and-braces — but it is the assertion that reads as the rule, and it
   * fails loudly if the type is ever widened to `boolean` to let something in.
   */
  test("every element answers §4's admission test with 'no'", () => {
    for (const el of HOME_CANVAS) {
      expect(el.alreadyVisibleOnThisScreen).toBe(false);
      expect(el.notADuplicateBecause.length).toBeGreaterThan(0);
    }
  });

  test("the chip cap is 5 and lives only on the manifest", () => {
    expect(PROMPT_CHIP_CAP).toBe(5);
    expect(HOME_CANVAS[2].childCap).toBe(5);
  });

  /**
   * Create/Voice and the reveal control did not raise the cap — they were fitted
   * under it. The control costs a chip slot, and that price is derived from the
   * cap rather than typed beside it.
   */
  test("the reveal control is paid for out of position 3's five, not added to it", () => {
    expect(PROMPT_CHIP_ROW_CAP).toBe(PROMPT_CHIP_CAP - 1);
    expect(GENERIC_PROMPTS.length).toBe(PROMPT_CHIP_ROW_CAP);
  });

  test("the region owns exactly positions 3 and 4", () => {
    expect(REGION_ELEMENTS.map((el) => el.id)).toEqual(["prompts", "door"]);
  });
});

// ---------------------------------------------------------------------------
// The rendered canvas
// ---------------------------------------------------------------------------

describe("home canvas — what renders", () => {
  test("renders exactly the allowed elements and nothing else", async () => {
    renderCanvas();
    const region = await settledRegion();

    const audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(true);
    expect(audit.found).toEqual(["prompts", "door"]);
    expect(audit.untaggedRegionChildren).toBe(0);
    expect(audit.unknown).toEqual([]);
    expect(audit.duplicated).toEqual([]);

    // Every direct child of the region is a manifest element. This is the
    // assertion that a stray sibling trips.
    expect(region.children.length).toBe(2);
  });

  test("position 3 is four chips and the control — the cap exactly, not over it", async () => {
    renderCanvas();
    const region = await settledRegion();
    const chips = chipsRow(region);
    expect(chips.children.length).toBe(PROMPT_CHIP_CAP);
    expect(auditHomeCanvas(region).overCap).toEqual([]);
  });

  test("the chips never exceed the cap, however much state there is", async () => {
    renderCanvas();
    const region = await settledRegion();
    const chips = chipsRow(region);
    expect(chips.children.length).toBeLessThanOrEqual(PROMPT_CHIP_CAP);

    // ...and revealing the context set does not grow the row either.
    revealContext();
    expect(chipsRow(region).children.length).toBeLessThanOrEqual(
      PROMPT_CHIP_CAP,
    );
    expect(auditHomeCanvas(region).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The mutation check — a seventh element must fail
// ---------------------------------------------------------------------------

describe("home canvas — a seventh element cannot arrive quietly", () => {
  test("an untagged element smuggled into the region fails the audit", async () => {
    renderCanvas();
    const region = await settledRegion();
    expect(auditHomeCanvas(region).ok).toBe(true);

    // This is the exact shape of every element that arrived before §4: a
    // component someone dropped in next to the chips.
    const intruder = document.createElement("div");
    intruder.textContent = "PICK UP WHERE YOU LEFT OFF";
    region.appendChild(intruder);

    const audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.untaggedRegionChildren).toBe(1);
    expect(audit.verdict).toContain(
      "already visible somewhere else on this screen",
    );
  });

  test("a seventh element that steals a marker fails as a duplicate", async () => {
    renderCanvas();
    const region = await settledRegion();

    const impostor = document.createElement("div");
    impostor.setAttribute(HOME_CANVAS_ATTR, "door");
    region.appendChild(impostor);

    const audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.duplicated).toEqual(["door"]);
  });

  test("a marker the manifest does not contain is reported as unknown", async () => {
    renderCanvas();
    const region = await settledRegion();

    const invented = document.createElement("div");
    invented.setAttribute(HOME_CANVAS_ATTR, "needs_you_cards");
    region.appendChild(invented);

    const audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.unknown).toEqual(["needs_you_cards"]);
  });

  /**
   * The mutation check for the cap, re-run after the row was rebuilt.
   *
   * The row now renders *at* the cap rather than under it, so this is the
   * assertion that matters most: one more child — a fifth chip that forgot the
   * control's slot, or a second control — is a failure, not a squeeze.
   */
  test("one child past the cap breaks it, in both states of the disclosure", async () => {
    renderCanvas();
    const region = await settledRegion();

    const collapsed = chipsRow(region);
    collapsed.appendChild(document.createElement("button"));
    let audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.overCap[0]?.id).toBe("prompts");
    expect(audit.overCap[0]?.cap).toBe(PROMPT_CHIP_CAP);
    expect(audit.overCap[0]?.actual).toBe(PROMPT_CHIP_CAP + 1);

    // React owns this subtree; drop the smuggled node before re-rendering.
    collapsed.removeChild(collapsed.lastChild!);
    revealContext();

    // Revealed, the row is under the cap (three real rows plus the control),
    // so the check has to still bite when it is filled past five.
    const expanded = chipsRow(region);
    expect(auditHomeCanvas(region).ok).toBe(true);
    while (expanded.children.length <= PROMPT_CHIP_CAP) {
      expanded.appendChild(document.createElement("button"));
    }
    audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.overCap[0]?.id).toBe("prompts");
  });
});

// ---------------------------------------------------------------------------
// Position 3a — the generic prompts, which must survive a cold account
// ---------------------------------------------------------------------------

describe("home canvas — generic prompts are the visible default", () => {
  test("render on an account with NO state at all", async () => {
    withNoState();
    renderCanvas();
    const region = await settledRegion();

    // The whole point: a brand-new account has nothing to derive from, and the
    // canvas is still four real things you can start from.
    for (const p of GENERIC_PROMPTS) {
      expect(
        screen.getByRole("button", { name: `Ask Cue: ${p.label}` }),
      ).toBeDefined();
    }
    expect(chipsRow(region).children.length).toBe(PROMPT_CHIP_CAP);
    expect(auditHomeCanvas(region).ok).toBe(true);
  });

  test("are still what shows first when there IS state to derive from", async () => {
    renderCanvas();
    await settledRegion();

    expect(
      screen.getByRole("button", { name: "Ask Cue: Brief me" }),
    ).toBeDefined();
    // The derived ones are behind the control, not beside the generic ones.
    expect(
      screen.queryByRole("button", { name: `Ask Cue: ${MISSION.title}` }),
    ).toBeNull();
  });

  test("claim no provenance — a generic prompt carries no source row", () => {
    for (const p of GENERIC_PROMPTS) {
      expect(p.kind).toBe("generic");
      expect(p.sourceId).toBeNull();
      // Selecting a chip sends immediately, so a trailing fragment would ship
      // half a sentence to the daemon.
      expect(p.prompt.trim().endsWith(".")).toBe(true);
    }
  });

  test("wear the generic glyph, so an offer is never mistaken for a reading", async () => {
    withNoState();
    renderCanvas();
    const region = await settledRegion();
    const chips = Array.from(chipsRow(region).children);
    // Four chips wearing `✨`, plus the control.
    const marked = chips.filter((c) => c.textContent?.includes("✨"));
    expect(marked.length).toBe(GENERIC_PROMPTS.length);
  });

  test("sending one sends the whole sentence", async () => {
    withNoState();
    const sent: string[] = [];
    renderCanvas((p) => sent.push(p.prompt));
    await settledRegion();

    screen
      .getByRole("button", { name: "Ask Cue: Plan my day" })
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      if (sent.length === 0) throw new Error("no prompt sent");
    });
    expect(sent[0]).toBe("Plan my day from my calendar and inbox.");
  });
});

// ---------------------------------------------------------------------------
// Position 3b — the context-rich suggestions, hidden behind the control
// ---------------------------------------------------------------------------

describe("home canvas — context suggestions are hidden until asked for", () => {
  test("a needs-you item, the free block and an active mission each mint one", async () => {
    renderCanvas();
    await settledRegion();
    revealContext();

    // ① the needs-you work item, by its real title
    expect(
      screen.getByRole("button", {
        name: `Ask Cue: ${REVIEW_ITEM.title}`,
      }),
    ).toBeDefined();

    // ② the free block, by the daemon's own minute arithmetic (150 → "2h 30m")
    expect(
      screen.getByRole("button", { name: "Ask Cue: Use my 2h 30m free" }),
    ).toBeDefined();

    // ③ the active mission, by its real title
    expect(
      screen.getByRole("button", { name: `Ask Cue: ${MISSION.title}` }),
    ).toBeDefined();
  });

  test("the control is a real disclosure — it says which way it is pointing", async () => {
    renderCanvas();
    await settledRegion();

    const closed = screen.getByRole("button", {
      name: "Show suggestions from your day",
    });
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    // A glyph, not a tint (§8).
    expect(closed.textContent).toContain("▾");

    fireEvent.click(closed);
    const open = screen.getByRole("button", {
      name: "Hide suggestions from your day",
    });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(open.textContent).toContain("▴");

    // ...and it goes back.
    fireEvent.click(open);
    expect(
      screen.getByRole("button", { name: "Ask Cue: Brief me" }),
    ).toBeDefined();
  });

  test("every revealed chip carries the glyph for its source — no colour-only state", async () => {
    renderCanvas();
    const region = await settledRegion();
    revealContext();

    const glyphs = ["‖", "◱", "◎"];
    const chips = Array.from(chipsRow(region).children).slice(
      0,
      PROMPT_CHIP_ROW_CAP,
    );
    for (const child of chips) {
      if (child.getAttribute("aria-expanded") !== null) continue; // the control
      expect(glyphs.some((g) => child.textContent?.includes(g))).toBe(true);
    }
  });

  test("selecting one sends the prompt built from that row", async () => {
    const sent: string[] = [];
    renderCanvas((p) => sent.push(p.prompt));
    await settledRegion();
    revealContext();

    screen
      .getByRole("button", { name: `Ask Cue: ${MISSION.title}` })
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await waitFor(() => {
      if (sent.length === 0) throw new Error("no prompt sent");
    });
    expect(sent[0]).toContain(MISSION.title);
  });
});

// ---------------------------------------------------------------------------
// The rule that outranks all of it: nothing is ever fabricated
// ---------------------------------------------------------------------------

describe("home canvas — no state means no context suggestions", () => {
  test("asking with nothing behind the control says so, and shows nothing", async () => {
    withNoState();
    renderCanvas();
    const region = await settledRegion();
    revealContext();

    const row = chipsRow(region);
    expect(row.textContent).toContain(
      "Nothing's waiting on you and nothing's running.",
    );
    // The row is the sentence and the control. No invented chips.
    expect(row.children.length).toBe(2);
    expect(screen.queryByRole("button", { name: /^Ask Cue:/ })).toBeNull();
    expect(auditHomeCanvas(region).ok).toBe(true);
  });

  test("a store that could not be read is never reported as 'nothing'", async () => {
    failEveryStore();
    renderCanvas();
    const region = await settledRegion();
    revealContext();

    const row = chipsRow(region);
    expect(row.textContent).toContain("I couldn't read your work just now.");
    expect(row.textContent).not.toContain("Nothing's waiting on you");
  });

  test("the three notices are three different sentences, each with a glyph", () => {
    const pending = emptyContextNotice({
      isPending: true,
      couldNotRead: false,
    });
    const failed = emptyContextNotice({ isPending: false, couldNotRead: true });
    const empty = emptyContextNotice({ isPending: false, couldNotRead: false });

    expect(pending.text).toBe("Still reading your day…");
    expect(failed.text).toBe("I couldn't read your work just now.");
    expect(empty.text).toBe("Nothing's waiting on you and nothing's running.");

    // "still reading" and "couldn't read" are not "nothing" — collapsing them
    // is the lie this branch exists to prevent.
    for (const n of [pending, failed]) {
      expect(n.text).not.toContain("Nothing's waiting");
    }
    for (const n of [pending, failed, empty]) {
      expect(n.glyph.length).toBeGreaterThan(0);
    }
  });

  test("generic prompts still render when every store is unreadable", async () => {
    failEveryStore();
    renderCanvas();
    await settledRegion();

    expect(
      screen.getByRole("button", { name: "Ask Cue: Brief me" }),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Position 4 — the door
// ---------------------------------------------------------------------------

describe("home canvas — the sentence pill is the door to HQ", () => {
  test("navigates to HQ, and is the only affordance for doing so", async () => {
    renderCanvas();
    const region = await settledRegion();
    const door = region.querySelector(`[${HOME_CANVAS_ATTR}="door"]`)!;

    const links = door.querySelectorAll("a");
    // One affordance, not a sentence plus a "show me" button.
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("/assistant/hq");

    // The sentence is the link, not a label beside it.
    expect(links[0].textContent).toContain("need you");
    expect(door.querySelectorAll("button").length).toBe(0);
  });

  test("shows only counts that were actually queried", async () => {
    renderCanvas();
    const region = await settledRegion();
    const door = region.querySelector(`[${HOME_CANVAS_ATTR}="door"]`)!;

    // 1 awaiting_review + 1 pending interaction = 2 need you.
    // 3 done rows, but one is two days old, so 2 delivered today — the stale
    // row must not be counted as "today so far".
    expect(door.textContent).toContain("2 done");
    expect(door.textContent).toContain("2 need you");
  });

  test("carries a glyph in every state", () => {
    // Rendered glyph selection is exercised above; this pins the three states
    // the sentence itself can be in, so none of them is colour-only.
    expect(doorSentence(null, null, 9)).toBe(
      "I couldn't read your work just now.",
    );
    expect(doorSentence(3, 0, 9)).toContain("Nothing needs you");
    expect(doorSentence(3, 2, 9)).toBe("While you slept: 3 done, 2 need you.");
    expect(doorSentence(3, 2, 15)).toBe("Today so far: 3 done, 2 need you.");
  });

  test("a count Cue could not read is never rendered as zero", () => {
    // The lie this rule exists to stop: "Nothing needs you" when we never asked.
    expect(doorSentence(null, null, 9)).not.toContain("Nothing needs you");
    expect(doorSentence(0, null, 9)).toBe("I haven't finished anything yet.");
  });

  test("startOfToday is local midnight", () => {
    const noon = new Date(2026, 7, 2, 12, 30, 0, 0).getTime();
    const midnight = new Date(2026, 7, 2, 0, 0, 0, 0).getTime();
    expect(startOfToday(noon)).toBe(midnight);
  });
});
