/**
 * The `☰ork` guard.
 *
 * `Mv3OverflowMenu` paints two fixed 34px buttons over the top corners of four
 * routes. Twice now a screen's own header has rendered its title underneath the
 * left one: HQ's date eyebrow read `☰DAY · 2 AUG`, and Work's large title read
 * `☰ork` — the second time AFTER a fix that moved the route predicate into
 * `corner-chrome.ts` so "no screen can forget". Work forgot anyway, because
 * Work renders a THIRD header (`WorkHeader`) that the fix never touched. Both
 * fixes were verified by looking at the screens someone remembered to look at.
 *
 * So this test does not look at screens. It walks, route by route, every screen
 * the corner chrome renders over, finds every header component those screens
 * render, and fails any header that does not take the clearance. Adding a route
 * to `MV3_OVERFLOW_SURFACES`, adding a view to an existing route, or growing a
 * new header on one of them all fail here until the header is wired.
 *
 * ## On measuring boxes
 *
 * happy-dom has no layout engine: `getBoundingClientRect()` is all zeros, so a
 * literal "do these two rectangles intersect on screen" assertion is not
 * available in this runner. What IS available is the geometry both sides
 * declare — the buttons' from `overflow-menu.tsx`, the headers' from
 * `cornerChromeProps` — so the intersection is computed from those declared
 * boxes instead. That is the same arithmetic the browser would do, minus the
 * browser. The static half of the test is what closes the gap: a header that
 * declares nothing has no box to check, and is failed for that alone.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

import {
  CORNER_CHROME_BAND,
  CORNER_CHROME_GAP,
  CORNER_CHROME_GUTTER,
  CORNER_CHROME_INSET,
  CORNER_CHROME_SIZE,
  CORNER_CHROME_TOP,
  MV3_OVERFLOW_SURFACES,
  cornerChromeProps,
  overflowVisible,
} from "./corner-chrome";
import { LargeTitleHeader } from "./large-title-header";
import { routes } from "@/utils/routes";

const SRC = new URL("..", import.meta.url).pathname;
const read = (rel: string) => Bun.file(`${SRC}${rel}`).text();

/* -------------------------------------------------------------------------- */
/* The route table                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every screen the corner chrome is painted over, by the pathname it answers.
 *
 * `screens` lists the files that render at that pathname — plural for Work,
 * whose three views (Things · Everything · Library) are a `?view=` query on ONE
 * path, so all three sit under the buttons. That plurality is exactly what the
 * last fix missed.
 */
const CHROME_ROUTES: Record<string, { screens: string[] }> = {
  [routes.hq]: { screens: ["pages/hq/hq-page.tsx"] },
  // `/home` only redirects to HQ; it renders no header of its own. It is listed
  // so the coverage check below stays exhaustive rather than special-cased.
  [routes.home]: { screens: [] },
  [routes.projects]: {
    screens: [
      "pages/projects/mv3-projects.tsx",
      "pages/projects/mv3-all-work.tsx",
      "pages/projects/mv3-work-library.tsx",
    ],
  },
  [routes.conversations]: {
    // `chats-index-page.tsx` is a thin route wrapper; the screen — and the
    // header — is `Mv3ChatsIndex`.
    screens: ["mobile-v3/chats/mv3-chats-index.tsx"],
  },
};

/**
 * Where each header component is defined. A header found in a screen but absent
 * here fails — the point is that a NEW header cannot appear on a chrome route
 * without someone landing in this file.
 */
const HEADER_SOURCES: Record<string, string> = {
  LargeTitleHeader: "mobile-v3/large-title-header.tsx",
  WorkHeader: "mobile-v3/work-kit.tsx",
  // HQ's header is not a component — `Mv3Today` renders its own hero row.
  Mv3Today: "mobile-v3/today/mv3-today.tsx",
};

/** Header-ish JSX tags rendered by a file: `<FooHeader`, plus `<Mv3Today`. */
function headersRenderedBy(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/<([A-Z][A-Za-z0-9]*Header)\b/g)) {
    found.add(m[1]!);
  }
  for (const m of source.matchAll(/<(Mv3Today)\b/g)) found.add(m[1]!);
  return [...found];
}

/* -------------------------------------------------------------------------- */
/* 1 · The chrome's own routes are all covered                                */
/* -------------------------------------------------------------------------- */

describe("corner chrome route coverage", () => {
  test("every route the buttons render on has a screen list", () => {
    expect(Object.keys(CHROME_ROUTES).sort()).toEqual(
      [...MV3_OVERFLOW_SURFACES].sort(),
    );
  });

  test("overflowVisible agrees with the table (exact match, no prefixes)", () => {
    for (const path of MV3_OVERFLOW_SURFACES) {
      expect(overflowVisible(path)).toBe(true);
      // A detail screen under the same prefix carries its own back chrome.
      expect(overflowVisible(`${path}/some-detail-id`)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2 · Every header on those routes takes the clearance                       */
/* -------------------------------------------------------------------------- */

describe("every header under the corner chrome clears it", () => {
  test("each chrome route's headers are known to this test", async () => {
    for (const [path, { screens }] of Object.entries(CHROME_ROUTES)) {
      if (screens.length === 0) continue; // `/home` is a redirect.
      const headers = new Set<string>();
      for (const screen of screens) {
        for (const h of headersRenderedBy(await read(screen))) headers.add(h);
      }
      expect(
        headers.size,
        `${path} renders no header this test knows about — if one of ` +
          `${screens.join(", ")} grew a header, add it to HEADER_SOURCES`,
      ).toBeGreaterThan(0);
      for (const header of headers) {
        expect(
          HEADER_SOURCES[header],
          `${header} is rendered on ${path} but is not in HEADER_SOURCES`,
        ).toBeDefined();
      }
    }
  });

  test("each of those headers asks corner-chrome for its clearance", async () => {
    // The assertion that would have caught `☰ork`: before the fix,
    // work-kit.tsx contained no reference to corner-chrome at all, while
    // rendering the title on a route the buttons are painted over.
    const onChromeRoutes = new Set<string>();
    for (const { screens } of Object.values(CHROME_ROUTES)) {
      for (const screen of screens) {
        for (const h of headersRenderedBy(await read(screen))) {
          onChromeRoutes.add(h);
        }
      }
    }
    expect(onChromeRoutes.size).toBeGreaterThan(0);
    for (const header of onChromeRoutes) {
      const file = HEADER_SOURCES[header]!;
      expect(
        await read(file),
        `${header} (${file}) renders under the corner chrome but never calls ` +
          `cornerChromeProps — its title will be painted on by the ☰ button`,
      ).toContain("cornerChromeProps(");
    }
  });

  test("Work's three views are all covered, not just the default one", async () => {
    // The specific shape of the miss: Things was the screen anyone opened, and
    // Everything / Library share its path and its header.
    const work = CHROME_ROUTES[routes.projects]!.screens;
    expect(work.length).toBe(3);
    for (const screen of work) {
      expect(headersRenderedBy(await read(screen))).toContain("WorkHeader");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3 · The declared boxes do not intersect                                    */
/* -------------------------------------------------------------------------- */

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Screen width used for the right-hand button. Any width works; 393 is a 16. */
const SCREEN_W = 393;

/** The two buttons, in px from the safe-area top / the screen's edges. */
const BUTTONS: Box[] = [
  {
    top: CORNER_CHROME_TOP,
    bottom: CORNER_CHROME_TOP + CORNER_CHROME_SIZE,
    left: CORNER_CHROME_GUTTER,
    right: CORNER_CHROME_GUTTER + CORNER_CHROME_SIZE,
  },
  {
    top: CORNER_CHROME_TOP,
    bottom: CORNER_CHROME_TOP + CORNER_CHROME_SIZE,
    left: SCREEN_W - CORNER_CHROME_GUTTER - CORNER_CHROME_SIZE,
    right: SCREEN_W - CORNER_CHROME_GUTTER,
  },
];

function intersects(a: Box, b: Box): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/**
 * Where a header's first line of content lands, given the clearance it declares
 * and the two things it cannot control: the gutter it is padded on, and the
 * spacer its screen puts above it (both Work views and HQ open with the same
 * `safe-area-inset-top + Npx` spacer).
 */
function contentBox(
  props: ReturnType<typeof cornerChromeProps>,
  { gutter, spacerTop }: { gutter: number; spacerTop: number },
): Box {
  const s = props.style;
  const top = spacerTop + Number(s.paddingTop ?? 0);
  return {
    top,
    // One line of a 23–29px title. Only the top edge decides the collision.
    bottom: top + 30,
    left: gutter + Number(s.paddingLeft ?? 0),
    right: SCREEN_W - gutter - Number(s.paddingRight ?? 0),
  };
}

describe("declared header boxes clear the declared button boxes", () => {
  test("WorkHeader's title row misses both buttons on /assistant/projects", () => {
    // Work's screens open with a `safe-area-inset-top + 8px` spacer, then the
    // header at an 18px gutter with a trailing filter chip on the title row —
    // i.e. the row runs edge to edge and cannot be inset into.
    const box = contentBox(cornerChromeProps(routes.projects, "band"), {
      gutter: 18,
      spacerTop: 8,
    });
    for (const button of BUTTONS) {
      expect(
        intersects(box, button),
        `Work's title box ${JSON.stringify(box)} overlaps ${JSON.stringify(button)}`,
      ).toBe(false);
    }
    // And it clears by holding the band open, not by insetting sideways.
    expect(box.top).toBeGreaterThanOrEqual(
      CORNER_CHROME_TOP + CORNER_CHROME_SIZE,
    );
  });

  test("a header that takes NO clearance does overlap — the guard has teeth", () => {
    const box = contentBox({ style: {} }, { gutter: 18, spacerTop: 8 });
    expect(intersects(box, BUTTONS[0]!)).toBe(true);
    expect(intersects(box, BUTTONS[1]!)).toBe(true);
  });

  test("a `row` header's inset content sits between the two buttons", () => {
    // HQ / the large title keep their eyebrow IN the band and inset instead.
    const box = contentBox(cornerChromeProps(routes.hq, "row"), {
      gutter: 22,
      spacerTop: 6,
    });
    for (const button of BUTTONS) {
      expect(intersects(box, button)).toBe(false);
    }
    expect(box.left).toBeGreaterThanOrEqual(
      CORNER_CHROME_GUTTER + CORNER_CHROME_SIZE + CORNER_CHROME_GAP,
    );
    expect(box.right).toBeLessThanOrEqual(
      SCREEN_W - CORNER_CHROME_GUTTER - CORNER_CHROME_SIZE - CORNER_CHROME_GAP,
    );
  });

  test("clearance is zero off the chrome's routes", () => {
    expect(cornerChromeProps(routes.people, "band").style).toEqual({});
    expect(cornerChromeProps(routes.people, "row").style).toEqual({});
    expect(
      cornerChromeProps(routes.people, "band")["data-corner-chrome"],
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 4 · The clearance actually reaches the DOM                                 */
/* -------------------------------------------------------------------------- */

describe("the clearance survives the render", () => {
  const renderAt = (path: string) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(LargeTitleHeader, { title: "Chats" }),
      ),
    );

  test("LargeTitleHeader marks and insets itself on a chrome route", () => {
    const html = renderAt(routes.conversations);
    expect(html).toContain('data-corner-chrome="row"');
    expect(html).toContain(`padding-left:${CORNER_CHROME_INSET}px`);
    expect(html).toContain(`padding-right:${CORNER_CHROME_INSET}px`);
    expect(html).toContain(`min-height:${CORNER_CHROME_BAND}px`);
  });

  test("…and takes none of it elsewhere", () => {
    const html = renderAt(routes.people);
    expect(html).not.toContain("data-corner-chrome");
    expect(html).not.toContain(`min-height:${CORNER_CHROME_BAND}px`);
  });
});
