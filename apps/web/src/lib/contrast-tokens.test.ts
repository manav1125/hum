/**
 * Design addendum A1 — the small-text contrast fix, light theme only.
 *
 * The accent/state hues are tuned for fills, strokes, glyph marks and display
 * type; below 16px several of them fall under the 4.5:1 floor on the light
 * canvas. Design's answer was a token swap rather than a minimum type size, so
 * every role now carries a TEXT leg that is a darker stop of the same hue.
 *
 * This test pins the three places those legs live — the design-library
 * `tokens.css`, the app's `--mv1-*` layer, and the mobile-v3 `--mv3-*` layer —
 * plus the `C` palette every serif-HQ surface consumes. It exists because a
 * text leg that silently drifts back toward its fill value is invisible in
 * review: the page still renders, it just stops being readable.
 *
 * It also pins the DARK legs to their fill values. Addendum A1 is light-only;
 * on the ink canvases the bright values already clear the floor, so a call
 * site that moves from a fill leg to a text leg must be a no-op in dark. If
 * someone "helpfully" darkens the dark leg, this fails.
 */
import { readFileSync } from "node:fs";

import { WORK_STATE_META, type WorkLoopState } from "@vellumai/design-library";
import { describe, expect, test } from "bun:test";

import { C } from "@/lib/hq-theme";

const ROOT = new URL("../../", import.meta.url).pathname;
const LIB = new URL("../../../../packages/design-library/src/", import.meta.url)
  .pathname;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The declarations inside the first CSS block whose selector list matches. */
function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  return css.slice(open, close);
}

/** Value of `--name` inside a block, lowercased and trimmed. */
function decl(scope: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(scope);
  expect(m, `--${name} is not declared in this block`).not.toBeNull();
  return (m as RegExpExecArray)[1].trim().toLowerCase();
}

const tokensCss = read(`${LIB}tokens.css`);
const indexCss = read(`${ROOT}src/index.css`);
const mv3Css = read(`${ROOT}src/mobile-v3/mv3.css`);

describe("addendum A1 — design-library state tokens", () => {
  const light = block(tokensCss, ':root,\n[data-theme="light"]');
  const dark = block(tokensCss, '[data-theme="dark"] {');
  const velvet = block(tokensCss, '[data-theme="velvet"] {');

  // The exact stops design specified. Not "a bit darker" — these values.
  test.each([
    ["accent-cue-text", "#2b53c4"],
    ["accent-cue-violet-text", "#453c9e"],
    ["state-capture-text", "#2b53c4"],
    ["state-running-text", "#2b53c4"],
    ["state-needsyou-text", "#8a5a08"],
    ["state-review-text", "#453c9e"],
    ["state-done-text", "#277e41"], // already 4.6:1 — deliberately unchanged
    ["state-failure-text", "#a63a2f"],
    ["accent-life-text", "#0a6a6a"],
  ])("light %s is %s", (name, value) => {
    expect(decl(light, name)).toBe(value);
  });

  // Both legs exist for every role — a surface can always name what it means.
  // The two brand accents are declared once in the shared `:root` block (they
  // are theme-independent), so their fill leg is looked up file-wide.
  test.each([
    ["accent-cue", "accent-cue-text"],
    ["accent-cue-violet", "accent-cue-violet-text"],
  ])("%s ships alongside %s in light", (fill, text) => {
    expect(decl(tokensCss, fill)).toMatch(/^#[0-9a-f]{6}$/);
    expect(decl(light, text)).toMatch(/^#[0-9a-f]{6}$/);
  });

  test.each([
    ["accent-life", "accent-life-text"],
    ["state-capture", "state-capture-text"],
    ["state-running", "state-running-text"],
    ["state-needsyou", "state-needsyou-text"],
    ["state-review", "state-review-text"],
    ["state-done", "state-done-text"],
    ["state-failure", "state-failure-text"],
  ])("%s ships alongside %s in light", (fill, text) => {
    expect(decl(light, fill)).toMatch(/^#[0-9a-f]{6}$/);
    expect(decl(light, text)).toMatch(/^#[0-9a-f]{6}$/);
  });

  // Dark is untouched: each text leg equals its own fill leg.
  test.each([
    ["accent-life", "accent-life-text"],
    ["state-capture", "state-capture-text"],
    ["state-running", "state-running-text"],
    ["state-needsyou", "state-needsyou-text"],
    ["state-review", "state-review-text"],
    ["state-done", "state-done-text"],
    ["state-failure", "state-failure-text"],
  ])("dark + velvet keep %s === %s", (fill, text) => {
    expect(decl(dark, text)).toBe(decl(dark, fill));
    expect(decl(velvet, text)).toBe(decl(velvet, fill));
  });
});

describe("addendum A1 — app --mv1-* layer", () => {
  const light = block(indexCss, ":root {\n  --mv1-ink");
  const dark = block(indexCss, '[data-theme="dark"],\n[data-theme="velvet"] {');

  test.each([
    ["mv1-blue-text", "#2b53c4"],
    ["mv1-violet-text", "#453c9e"],
    ["mv1-amber-text", "#8a5a08"],
    ["mv1-teal-text", "#0a6a6a"],
    ["mv1-green-text", "#277e41"],
    ["mv1-red-text", "#a63a2f"],
  ])("light %s is %s", (name, value) => {
    expect(decl(light, name)).toBe(value);
  });

  test.each([
    ["mv1-blue", "mv1-blue-text"],
    ["mv1-violet", "mv1-violet-text"],
    ["mv1-amber", "mv1-amber-text"],
    ["mv1-teal", "mv1-teal-text"],
    ["mv1-green", "mv1-green-text"],
    ["mv1-red", "mv1-red-text"],
  ])("dark keeps %s === %s", (fill, text) => {
    expect(decl(dark, text)).toBe(decl(dark, fill));
  });
});

describe("addendum A1 — mobile-v3 --mv3-* layer", () => {
  const light = block(mv3Css, ":root {\n  /* SF Pro");
  const dark = block(mv3Css, '[data-theme="dark"],\n[data-theme="velvet"] {');

  test.each([
    ["mv3-accent-text", "#2b53c4"],
    ["mv3-amber-text", "#8a5a08"],
    ["mv3-violet-text", "#453c9e"],
    ["mv3-green-text", "#277e41"],
    ["mv3-teal-text", "#0a6a6a"],
    ["mv3-fail-text", "#a63a2f"],
  ])("light %s is %s", (name, value) => {
    expect(decl(light, name)).toBe(value);
  });

  // The fail row kept its `-text` name, so the FILL leg is the new token; both
  // must exist or the ✕ glyph loses its brightness.
  test("light keeps the failure fill leg alongside its text leg", () => {
    expect(decl(light, "mv3-fail")).toBe("#c24e42");
  });

  test.each([
    ["mv3-accent", "mv3-accent-text"],
    ["mv3-amber", "mv3-amber-text"],
    ["mv3-violet", "mv3-violet-text"],
    ["mv3-green", "mv3-green-text"],
    ["mv3-teal", "mv3-teal-text"],
  ])("dark keeps %s === %s", (fill, text) => {
    expect(decl(dark, text)).toBe(decl(dark, fill));
  });
});

describe("addendum A1 — the work-loop state model", () => {
  const states: WorkLoopState[] = [
    "capture",
    "running",
    "needsyou",
    "review",
    "done",
    "failure",
  ];

  // Every state names both legs, and neither is a raw hex — the model points
  // at tokens so a theme swap can never leave a surface on a stale colour.
  test.each(states)("%s carries an accent leg and a text leg", (state) => {
    const meta = WORK_STATE_META[state];
    expect(meta.accentVar).toBe(`var(--state-${state})`);
    expect(meta.textVar).toBe(`var(--state-${state}-text)`);
  });
});

describe("addendum A1 — the shared serif-HQ C palette", () => {
  // Every fill leg has a text leg, and the text leg points at the -text var
  // rather than re-hardcoding a hex (which would break theme switching).
  test.each([
    ["blue", "blueText", "--mv1-blue-text"],
    ["violet", "violetText", "--mv1-violet-text"],
    ["amber", "amberText", "--mv1-amber-text"],
    ["teal", "tealText", "--mv1-teal-text"],
    ["green", "greenText", "--mv1-green-text"],
    ["red", "redText", "--mv1-red-text"],
  ] as const)("C.%s pairs with C.%s", (fill, text, cssVar) => {
    expect(C[fill]).toStartWith("var(--mv1-");
    expect(C[text]).toBe(`var(${cssVar})`);
  });
});
