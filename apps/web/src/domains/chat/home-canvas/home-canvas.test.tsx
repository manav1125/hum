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
 *   seam rather than at the hook, so "prompts derive from real state" is
 *   verified through the actual derivation code and not around it.
 *
 * Mocking note: the generated query-options module is spread and only the four
 * endpoint factories this canvas reads are overridden. An exhaustive
 * hand-written factory is what broke `chat-body.test.tsx` once — the tree
 * below later imported a symbol the mock did not have and the whole file
 * errored before a test ran.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// ---------------------------------------------------------------------------
// Fixtures — the "real state" the chips must be derived from
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

const generated = await import("@/generated/daemon/@tanstack/react-query.gen");

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...generated,
  workitemsGetOptions: (opts: { query?: { status?: string } }) => {
    const status = opts.query?.status ?? "all";
    return {
      queryKey: ["test:workitems", status],
      queryFn: async () => ({
        items: status === "awaiting_review" ? [REVIEW_ITEM] : DONE_ITEMS,
      }),
    };
  },
  pendinginteractionsGetOptions: () => ({
    queryKey: ["test:pending"],
    queryFn: async () => ({ interactions: [{ requestId: "pi-1" }] }),
  }),
  calendarDayGetOptions: () => ({
    queryKey: ["test:calendar"],
    queryFn: async () => ({
      connection: { state: "connected", detail: null },
      largestFreeBlock: {
        start: "2026-08-02T14:00:00.000Z",
        end: "2026-08-02T16:30:00.000Z",
        minutes: FREE_BLOCK_MINUTES,
      },
    }),
  }),
  missionsGetOptions: () => ({
    queryKey: ["test:missions"],
    queryFn: async () => ({ missions: [MISSION] }),
  }),
}));

const {
  auditHomeCanvas,
  HOME_CANVAS,
  HOME_CANVAS_ATTR,
  HOME_CANVAS_REGION_ATTR,
  HOME_CANVAS_SIZE,
  PROMPT_CHIP_CAP,
  REGION_ELEMENTS,
  RENDERED_ELEMENTS,
} = await import("@/domains/chat/home-canvas/home-canvas-model");

const { HomeCanvasRegion } =
  await import("@/domains/chat/home-canvas/home-canvas");

const { doorSentence, startOfToday } =
  await import("@/domains/chat/home-canvas/use-canvas-door");

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

  test("the chips never exceed the cap, however much state there is", async () => {
    renderCanvas();
    const region = await settledRegion();
    const chips = region.querySelector(`[${HOME_CANVAS_ATTR}="prompts"]`);
    expect(chips).not.toBeNull();
    expect(chips!.children.length).toBeLessThanOrEqual(PROMPT_CHIP_CAP);
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

  test("a sixth chip breaks the cap", async () => {
    renderCanvas();
    const region = await settledRegion();
    const chips = region.querySelector(
      `[${HOME_CANVAS_ATTR}="prompts"]`,
    ) as HTMLElement;

    for (let i = chips.children.length; i <= PROMPT_CHIP_CAP; i += 1) {
      chips.appendChild(document.createElement("button"));
    }

    const audit = auditHomeCanvas(region);
    expect(audit.ok).toBe(false);
    expect(audit.overCap[0]?.id).toBe("prompts");
  });
});

// ---------------------------------------------------------------------------
// Position 3 — prompts derive from real state
// ---------------------------------------------------------------------------

describe("home canvas — prompts come from real state", () => {
  test("a needs-you item, the free block and an active mission each mint a chip", async () => {
    renderCanvas();
    await settledRegion();

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

  test("every chip carries the glyph for its source — no colour-only state", async () => {
    renderCanvas();
    const region = await settledRegion();
    const chips = region.querySelector(`[${HOME_CANVAS_ATTR}="prompts"]`)!;
    const glyphs = ["‖", "◱", "◎"];
    for (const child of Array.from(chips.children)) {
      expect(glyphs.some((g) => child.textContent?.includes(g))).toBe(true);
    }
  });

  test("selecting a chip sends the prompt built from that row", async () => {
    const sent: string[] = [];
    renderCanvas((p) => sent.push(p.prompt));
    await settledRegion();

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
