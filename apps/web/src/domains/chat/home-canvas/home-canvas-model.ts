/**
 * The home canvas — **exactly six elements**, enforced rather than described.
 *
 * `docs/design/handoff-2026-08-02/FINAL-NAV-BRIEF.md` §4:
 *
 * ```
 * 1. the mark + one serif line
 * 2. the composer
 * 3. up to 5 prompt chips
 * 4. one sentence pill → points ↑ at the rail
 * 5. — nothing
 * 6. — nothing
 * ```
 *
 * ## Why this file exists
 *
 * The canvas had eleven elements before this module: two needs-you cards, a
 * third approval card, six capability pills, four daemon starter chips and a
 * four-card **PICK UP WHERE YOU LEFT OFF** row. None of them arrived by
 * decision — each arrived because nothing said no. Design's diagnosis (§4) is
 * that the rule was missing, not the discipline:
 *
 * > *Is this already visible somewhere else on this screen?*
 * > If yes, it doesn't go on the canvas.
 *
 * Needs-you was in the rail **and** in HQ; recent conversations were in the
 * sidebar three inches to the left. The canvas was rendering the sidebar's
 * contents twice.
 *
 * ## How the rule is enforced
 *
 * A constant with a comment is not enforcement — every previous cap in this
 * codebase was a comment and every one of them drifted. Four mechanisms, none
 * of which is a comment:
 *
 * 1. **The manifest is a six-tuple.** {@link ExactlySix} makes a seventh entry
 *    a *compile* error, not a review comment.
 * 2. **{@link HomeCanvasElement.alreadyVisibleOnThisScreen} is typed `false`.**
 *    §4's admission test is a field every element must answer, and the type
 *    only admits one answer. An element that duplicates the rail cannot be
 *    added without editing this type — which is the conspicuous edit.
 * 3. **Only a manifest id can be tagged.** {@link canvasElement} takes a
 *    {@link RenderedElementId}, which is *derived* from the tuple. There is no
 *    way to mint the DOM marker for an element the manifest does not contain.
 * 4. **{@link auditHomeCanvas} reads the rendered DOM**, not the source. It
 *    catches the loophole the first three miss — an untagged element smuggled
 *    in as a sibling — by counting the canvas region's direct children against
 *    the manifest. `home-canvas.test.tsx` fails on any mismatch, and
 *    `HomeCanvasRegion` runs the same audit in development.
 *
 * Positions 5 and 6 are in the manifest as `renders: false`. They are not
 * spare slots: they are the two elements design deliberately spent on nothing,
 * and holding them keeps "six" literal instead of "four, for now".
 *
 * ## Where later additions went, and why none of them is a seventh element
 *
 * Three affordances arrived after the ruling. Each belongs *to* an element
 * already in the six, not beside them — which is the only way to add anything
 * to this canvas:
 *
 * - **Create** and **Voice** are chips on the composer (position 2).
 *   v15's `README.md` line 64 — *"Create and Voice stay composer chips"* — is
 *   why they have no rail row, and §9.3 is why they are not pages: a thing you
 *   *ask for* (create, voice, research) is a composer chip. Position 2 is
 *   `childCap: null` because the composer is one object with its own
 *   internals; the audit does not count the buttons inside it and never did.
 * - **The reveal control** for context-rich suggestions is a child of position
 *   3, and it spends one of that element's five slots
 *   ({@link PROMPT_CHIP_ROW_CAP}). It is not free — four chips plus a control
 *   is the trade, and the cap is what forced the trade to be made.
 */

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/** Position on the canvas. A closed union — `position: 7` is a type error. */
export type HomeCanvasPosition = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Where an element physically renders.
 *
 * The canvas is one design object but not one React subtree: the composer
 * must stay at a *fixed position in the tree* across the empty→active
 * transition or React resets its state (focus, draft text, attachments), and
 * the greeting sits inside the scroll area above it. So positions 1 and 2 are
 * tagged where they already live and only positions 3–4 are rendered from the
 * manifest by {@link HomeCanvasRegion}.
 *
 * See [React — Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state).
 */
export type HomeCanvasZone = "hero" | "composer" | "below-composer";

export interface HomeCanvasElement {
  position: HomeCanvasPosition;
  id: string;
  /** §4's own words for this element. */
  brief: string;
  zone: HomeCanvasZone;
  /** `false` for the two positions §4 spends on nothing. */
  renders: boolean;
  /**
   * §4's admission test, answered per element instead of described once.
   *
   * **The type admits only `false`.** Needs-you (rail + HQ), recent
   * conversations (sidebar), delivered counts (HQ) and the approvals deck all
   * answer `true`, so none of them can be typed into this array. That is the
   * rule, expressed as something the compiler can refuse.
   */
  alreadyVisibleOnThisScreen: false;
  /**
   * Where this information *also* lives, and why the canvas is still not a
   * second rendering of it. Required prose: absorption is a claim about the
   * screen, so it gets written down next to the element making it.
   */
  notADuplicateBecause: string;
  /**
   * Cap on repeated children, or `null` when the element is singular.
   *
   * Read by the renderer, not just documented: {@link CanvasPrompts} slices on
   * this value and {@link auditHomeCanvas} asserts against it.
   */
  childCap: number | null;
}

const MANIFEST = [
  {
    position: 1,
    id: "mark",
    brief: "the mark + one serif line",
    zone: "hero",
    renders: true,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "The rail's wordmark is chrome. This is the one line that speaks, and it is the only place on the screen that does.",
    childCap: null,
  },
  {
    position: 2,
    id: "composer",
    brief: "the composer",
    zone: "composer",
    renders: true,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "Fixed furniture. §8 lists it as an invariant because it has been accidentally dropped twice. Create and Voice are labelled chips ON it (v15 README l.64) rather than elements beside it — §9.3: a thing you ask for is a composer chip, not a page.",
    childCap: null,
  },
  {
    position: 3,
    id: "prompts",
    brief: "up to 5 prompt chips",
    zone: "below-composer",
    renders: true,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "Two kinds under one cap. The generic chips are an offer, and nothing else on this screen offers a cold start. The context-rich ones name real state (a needs-you item, the free block, an active mission) but they are not a *listing* of it — they are the sentence you would have typed, and they sit behind a control so the canvas at rest is still four chips. The listing is HQ's job.",
    childCap: 5,
  },
  {
    position: 4,
    id: "door",
    brief: "one sentence pill → points ↑ at the rail",
    zone: "below-composer",
    renders: true,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "The delivery sentence lifts out of HQ and becomes the door — it is not shown twice on this screen, it moved. The sentence IS the door: no companion 'show me' button, because two affordances for one intent is the clutter being removed.",
    childCap: null,
  },
  {
    position: 5,
    id: "nothing_5",
    brief: "— nothing",
    zone: "below-composer",
    renders: false,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "Deliberately spent on nothing. Filling it is the edit this file exists to make conspicuous.",
    childCap: null,
  },
  {
    position: 6,
    id: "nothing_6",
    brief: "— nothing",
    zone: "below-composer",
    renders: false,
    alreadyVisibleOnThisScreen: false,
    notADuplicateBecause:
      "Deliberately spent on nothing. Filling it is the edit this file exists to make conspicuous.",
    childCap: null,
  },
] as const;

/**
 * Six. Not "about six".
 *
 * Resolving to `never` when the tuple is any other length is the whole trick:
 * the assignment below stops compiling the moment a seventh element is typed
 * into {@link MANIFEST}, before any test runs and before any reviewer has to
 * notice.
 */
type ExactlySix<T extends readonly unknown[]> = T["length"] extends 6
  ? T
  : never;

const SIX: ExactlySix<typeof MANIFEST> = MANIFEST;

/**
 * Shape check, kept separate from {@link SIX} so the literal types survive.
 *
 * This is where `alreadyVisibleOnThisScreen: true` fails: the field's declared
 * type is the literal `false`, so an element that duplicates the rail cannot
 * be assigned here however it is written.
 */
const _shape: readonly HomeCanvasElement[] = SIX;
void _shape;

/** The canvas, in position order. */
export const HOME_CANVAS = SIX;

/** How many elements the canvas has. Derived from the tuple, never typed. */
export const HOME_CANVAS_SIZE: 6 = HOME_CANVAS.length;

/**
 * The ids that actually reach the DOM — `Extract`ed from the tuple rather
 * than listed, so {@link canvasElement} cannot tag something the manifest does
 * not contain and cannot tag a position design spends on nothing.
 */
export type RenderedElementId = Extract<
  (typeof HOME_CANVAS)[number],
  { renders: true }
>["id"];

/** Every id, including the two that render nothing. */
export type HomeCanvasElementId = (typeof HOME_CANVAS)[number]["id"];

/**
 * The ids {@link HomeCanvasRegion} is allowed to draw.
 *
 * The region's renderer is a `Record` keyed on this, so TypeScript will not let
 * it omit an element **or** carry one the manifest does not place below the
 * composer. Same device as HQ's exhaustive `Record<LaneId, LaneSlot>`, for the
 * same reason: "a slot went silently absent" should be a compile error, not a
 * bug found three weeks later.
 */
export type RegionElementId = Extract<
  (typeof HOME_CANVAS)[number],
  { renders: true; zone: "below-composer" }
>["id"];

/** The elements that render, in position order. */
export const RENDERED_ELEMENTS = HOME_CANVAS.filter(
  (el): el is Extract<(typeof HOME_CANVAS)[number], { renders: true }> =>
    el.renders,
);

/** The elements {@link HomeCanvasRegion} owns — positions 3 and 4. */
export const REGION_ELEMENTS = RENDERED_ELEMENTS.filter(
  (el) => el.zone === "below-composer",
);

/** Look an element up by id. Throws rather than rendering an unnamed slot. */
export function canvasElementSpec(
  id: HomeCanvasElementId,
): (typeof HOME_CANVAS)[number] {
  const found = HOME_CANVAS.find((el) => el.id === id);
  if (!found) throw new Error(`Unknown home-canvas element: ${id}`);
  return found;
}

/**
 * Chips cap — read off position 3's `childCap` rather than declared again.
 *
 * §4 says "up to 5". Two numbers meaning one rule is how the deck's headline
 * came to disagree with the sidebar badge, so there is only ever one.
 */
export const PROMPT_CHIP_CAP: number =
  canvasElementSpec("prompts").childCap ?? 0;

/**
 * How many *chips* fit in position 3 — the cap, minus the reveal control.
 *
 * The control that hides the context-rich suggestions is a child of position 3
 * like any chip, so it costs one of the five. Derived rather than typed as `4`
 * for the same reason {@link PROMPT_CHIP_CAP} is derived: the moment two
 * numbers mean one rule, they disagree.
 *
 * This is the shape of the trade the cap forces. It is **not** a reason to
 * raise the cap — if a sixth thing ever wants to be here, something in the
 * five has to leave.
 */
export const PROMPT_CHIP_ROW_CAP: number = Math.max(0, PROMPT_CHIP_CAP - 1);

// ---------------------------------------------------------------------------
// The DOM marker
// ---------------------------------------------------------------------------

export const HOME_CANVAS_ATTR = "data-home-canvas";
export const HOME_CANVAS_REGION_ATTR = "data-home-canvas-region";

/**
 * The **only** way to mark an element as part of the canvas.
 *
 * Spread onto the element's root: `<div {...canvasElement("door")}>`. The
 * parameter type is derived from the manifest, so a seventh element has
 * nowhere to get a marker from — and without a marker
 * {@link auditHomeCanvas} counts it as an intruder.
 */
export function canvasElement(id: RenderedElementId): {
  [HOME_CANVAS_ATTR]: RenderedElementId;
} {
  return { [HOME_CANVAS_ATTR]: id };
}

/** Marks the container that owns positions 3–4. */
export function canvasRegion(): { [HOME_CANVAS_REGION_ATTR]: "true" } {
  return { [HOME_CANVAS_REGION_ATTR]: "true" };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface CanvasAudit {
  /** Marked ids, in DOM order. */
  found: string[];
  /** Marked ids that appear more than once. */
  duplicated: string[];
  /** Marked ids the manifest does not contain, or that render nothing. */
  unknown: string[];
  /** Direct children of the region carrying no marker — the smuggling path. */
  untaggedRegionChildren: number;
  /** Elements whose child count exceeds their `childCap`. */
  overCap: { id: string; cap: number; actual: number }[];
  ok: boolean;
  /** One sentence, used by both the dev guard and the test failure message. */
  verdict: string;
}

/**
 * Read a rendered subtree and say whether it is still the canvas §4 ruled on.
 *
 * Deliberately DOM-based. The type system can stop a seventh *manifest* entry;
 * only this can stop a seventh *element* — someone dropping `<NewBanner/>`
 * next to the chips without touching this file at all. That is exactly how the
 * previous five arrived.
 */
export function auditHomeCanvas(root: ParentNode): CanvasAudit {
  const marked = Array.from(root.querySelectorAll(`[${HOME_CANVAS_ATTR}]`));
  const found = marked.map((el) => el.getAttribute(HOME_CANVAS_ATTR) ?? "");

  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const id of found) {
    if (seen.has(id)) duplicated.push(id);
    seen.add(id);
  }

  const renderableIds = new Set<string>(RENDERED_ELEMENTS.map((el) => el.id));
  const unknown = found.filter((id) => !renderableIds.has(id));

  // `root` may BE the region (the dev guard passes its own node) or contain it
  // (the test passes a whole rendered screen). `querySelector` never matches
  // the element it is called on, so the self case has to be handled — missing
  // it made the audit silently pass on the one thing it exists to catch.
  const self = root as Partial<Element>;
  const region =
    typeof self.hasAttribute === "function" &&
    self.hasAttribute(HOME_CANVAS_REGION_ATTR)
      ? (root as Element)
      : root.querySelector(`[${HOME_CANVAS_REGION_ATTR}]`);
  let untaggedRegionChildren = 0;
  if (region) {
    for (const child of Array.from(region.children)) {
      if (!child.hasAttribute(HOME_CANVAS_ATTR)) untaggedRegionChildren += 1;
    }
  }

  const overCap: { id: string; cap: number; actual: number }[] = [];
  for (const el of RENDERED_ELEMENTS) {
    if (el.childCap == null) continue;
    const node = root.querySelector(`[${HOME_CANVAS_ATTR}="${el.id}"]`);
    if (!node) continue;
    const actual = node.children.length;
    if (actual > el.childCap)
      overCap.push({ id: el.id, cap: el.childCap, actual });
  }

  const problems: string[] = [];
  if (duplicated.length)
    problems.push(`rendered twice: ${duplicated.join(", ")}`);
  if (unknown.length)
    problems.push(`not in the six-element manifest: ${unknown.join(", ")}`);
  if (untaggedRegionChildren)
    problems.push(
      `${untaggedRegionChildren} untagged element(s) inside the canvas region`,
    );
  for (const o of overCap)
    problems.push(`${o.id} rendered ${o.actual} children, cap is ${o.cap}`);

  const ok = problems.length === 0;
  return {
    found,
    duplicated,
    unknown,
    untaggedRegionChildren,
    overCap,
    ok,
    verdict: ok
      ? `Home canvas is the ruled six (${found.length} rendered).`
      : `Home canvas has drifted from §4's six elements — ${problems.join("; ")}. ` +
        `Before adding anything, answer §4's test: is this already visible somewhere else on this screen?`,
  };
}
