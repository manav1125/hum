/**
 * The ground/role layer — the values, the invariant, and the CSS half of the
 * lint.
 *
 * Design has logged ELEVEN recurrences of one failure class across eleven
 * design packs. Every instance is the same shape: *a value correct for one
 * ground or role applied to another.* The eleventh shipped inside the pack
 * whose own §4 rules on honest numbers — `#5B5B68` on a dark card, the exact
 * hex a prior ruling names as forbidden, two rows from two siblings using the
 * correct `#9A9AA8`.
 *
 *   "Eleven recurrences across eleven careful passes is not a discipline
 *    problem. Until a name carries its ground, the wrong value stays typeable
 *    into the right slot."
 *
 * So this file does not check that anyone remembered. It checks the two things
 * that make remembering unnecessary:
 *
 *  1. **The values behind the names**, recomputed against the grounds they are
 *     named for. A name is only load-bearing if the value behind it is fixed,
 *     so `--muted-on-dark` is asserted to be the dark stop AND to clear the
 *     floor on the dark grounds — and, just as importantly, `--muted-on-paper`
 *     is asserted to FAIL on a tint, because that failure is the entire reason
 *     the fourth ground exists.
 *
 *  2. **The CSS half of `local/no-on-token-as-ground`.** ESLint cannot see
 *     `.css` files, and the same inversion is spellable there. A lint with a
 *     file-type blind spot is the shape of guard this project has already been
 *     burned by twice: `pages/projects/` painted white on `--mv3-amber` for as
 *     long as the mv3 guard read only `src/mobile-v3/`.
 *
 * The ts/tsx half is `eslint-rules/no-on-token-as-ground.mjs`, with its own
 * unit tests. Both halves have to hold, so both are tested.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { C, ground } from "@/lib/hq-theme";

const SRC = new URL("../", import.meta.url).pathname;
const INDEX_CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** WCAG AA for body text. Design's floor, and the product's. */
const FLOOR = 4.5;

// ---------------------------------------------------------------------------
// Contrast, computed rather than quoted
// ---------------------------------------------------------------------------

function luminance(hex: string): number {
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(parseInt(hex.slice(5, 7), 16))
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// The layer, parsed out of index.css
// ---------------------------------------------------------------------------

/** Declarations of the first block whose selector text matches `anchor`. */
function block(css: string, anchor: string): string {
  const start = css.indexOf(anchor);
  expect(start, `no block anchored on ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("\n}", open));
}

function tokensIn(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().toLowerCase());
  }
  return out;
}

const LAYER = tokensIn(block(INDEX_CSS, ":root {\n  /* ── Muted text, per ground"));

/** The grounds each muted stop is named for, as they exist in the tree. */
const GROUNDS = {
  paper: ["#f4f3ef", "#faf7f2"],
  canvas: ["#f2f3f7", "#f4f6f9", "#ffffff"],
  dark: ["#0a0c12", "#1a2230", "#0f1620", "#11161f"],
  // Paper or canvas PLUS a wash: the deeper paper stop, and the three
  // `--mv1-*-wash` chip grounds. This is design's third ground.
  tint: ["#e8e6e0", "#dbe4fb", "#e2f0e7", "#fcf2f0"],
} as const;

// ---------------------------------------------------------------------------
// The sources the CSS lint reads
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "generated", "__snapshots__"]);

function cssFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, acc);
    else if (entry.endsWith(".css")) acc.push(full);
  }
  return acc;
}

const CSS_FILES = cssFiles(SRC);

describe("the ground/role layer", () => {
  test("the layer parsed — a silent zero would pass forever", () => {
    // The failure mode of a lint-by-test is a glob or a parse that quietly
    // matches nothing while the suite reports green. Which is, exactly, the
    // bug class this file is about.
    expect(LAYER.size).toBeGreaterThan(15);
    expect(CSS_FILES.length).toBeGreaterThan(1);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  test("the four muted stops are design's values, exactly", () => {
    // Not "a bit darker" — these values. Three are design's verbatim; the
    // fourth is derived below and shown to be necessary.
    expect(LAYER.get("--muted-on-paper")).toBe("#6b6b60");
    expect(LAYER.get("--muted-on-canvas")).toBe("#5a6672");
    expect(LAYER.get("--muted-on-dark")).toBe("#9a9aa8");
    expect(LAYER.get("--muted-on-tint")).toBe("#63635a");
  });

  test("each muted stop clears the floor on every ground it names", () => {
    const offenders: string[] = [];
    for (const [name, grounds] of Object.entries(GROUNDS)) {
      const ink = LAYER.get(`--muted-on-${name}`) as string;
      for (const g of grounds) {
        const ratio = contrast(ink, g);
        if (ratio < FLOOR) {
          offenders.push(`--muted-on-${name} (${ink}) on ${g} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("a tinted chip really is a third ground — the paper stop fails on it", () => {
    // This is the measurement the fourth token exists for, and the reason it
    // cannot be left to care: design measured `#6B6B60` at 4.35:1 on
    // paper-plus-a-wash while it passes at 4.85:1 on paper, and the two
    // grounds are visually near-identical in review.
    const paper = LAYER.get("--muted-on-paper") as string;
    expect(contrast(paper, "#f4f3ef")).toBeGreaterThan(FLOOR);
    const failing = GROUNDS.tint.filter((g) => contrast(paper, g) < FLOOR);
    expect(
      failing,
      `If this is empty, either the wash grounds moved or the paper stop did.
The fourth ground was added because the paper stop fails on a tint; a version
of this file where it does not is asserting nothing.`,
    ).not.toEqual([]);
    // And the tint stop is one step of the SAME hue, not a new colour — the
    // method every text leg in this codebase is derived by.
    expect(LAYER.get("--muted-on-tint")).toMatch(/^#6[0-3]6[0-3]5[0-9a-f]$/);
  });

  test("every -fill ships an -on-fill, and the pair clears the floor", () => {
    // The pairing is the point: whoever changes the ground sees the ink
    // beside it. The phone's Approve button shipped at 3.76:1 because its
    // ground and its ink lived in tokens nobody read side by side.
    const offenders: string[] = [];
    const fills = [...LAYER.keys()].filter((k) => /^--[a-z]+-fill$/.test(k));
    expect(fills.length).toBeGreaterThanOrEqual(7);
    for (const fill of fills) {
      const ink = fill.replace(/-fill$/, "-on-fill");
      if (!LAYER.has(ink)) {
        offenders.push(`${fill} has no ${ink}`);
        continue;
      }
      const ratio = contrast(LAYER.get(fill) as string, LAYER.get(ink) as string);
      if (ratio < FLOOR) {
        offenders.push(`${fill} under ${ink} = ${ratio.toFixed(2)}:1`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the fills are the TEXT stops, never the bright legs", () => {
    // Design's rule for grounds carrying white ink, stated as values:
    // "#2B53C4 · #534AB7 · #8A5A08 · #0A6A6A". A bright leg under white is
    // the exact defect that shipped at 3.76:1.
    expect(LAYER.get("--blue-fill")).toBe("#2b53c4");
    expect(LAYER.get("--violet-fill")).toBe("#534ab7");
    expect(LAYER.get("--amber-fill")).toBe("#8a5a08");
    expect(LAYER.get("--teal-fill")).toBe("#0a6a6a");
  });

  test("no theme may redefine a token that names its ground", () => {
    // Rule 1, and the one that makes the name a promise rather than a
    // reminder. `--muted-on-dark` means one thing everywhere or it means
    // nothing; a theme moves the `--muted` ALIAS instead.
    const themed = INDEX_CSS.split(/\[data-theme=/).slice(1);
    const redefined: string[] = [];
    for (const chunk of themed) {
      const body = chunk.slice(chunk.indexOf("{"), chunk.indexOf("\n}"));
      for (const key of tokensIn(body).keys()) {
        if (/^--muted-on-|-on-fill$/.test(key)) redefined.push(key);
      }
    }
    expect(
      redefined,
      `These name their own ground, so a theme cannot change them. Redefine
the theme-following alias (--muted) instead.\n${redefined.join("\n")}`,
    ).toEqual([]);
  });

  test("the alias swings with the theme, and the grounds can be declared", () => {
    expect(LAYER.get("--muted")).toBe("var(--muted-on-canvas)");
    const dark = block(INDEX_CSS, '[data-theme="dark"],\n[data-theme="velvet"] {\n  --muted');
    expect(tokensIn(dark).get("--muted")).toBe("var(--muted-on-dark)");
    // A surface declares its ground once; everything inside inherits.
    for (const on of ["paper", "canvas", "tint", "dark"] as const) {
      expect(INDEX_CSS).toContain(`[data-ground="${on}"]`);
      expect(ground(on)).toEqual({ "data-ground": on });
    }
  });

  test("the C palette points at the layer rather than re-spelling it", () => {
    // A palette that hardcodes hexes is a second source of truth, which is
    // how three surfaces ended up each declaring their own muted pair.
    // Indexed as a plain record: the palette's literal types would otherwise
    // make each lookup its own union, and the point here is the mapping.
    const palette: Record<string, string> = C;
    expect(palette.muted).toBe("var(--muted)");
    for (const on of ["Paper", "Canvas", "Tint", "Dark"] as const) {
      expect(palette[`mutedOn${on}`]).toBe(`var(--muted-on-${on.toLowerCase()})`);
    }
    for (const hue of ["blue", "violet", "amber", "teal", "green", "red"]) {
      expect(palette[`${hue}Fill`]).toBe(`var(--${hue}-fill)`);
      expect(palette[`${hue}OnFill`]).toBe(`var(--${hue}-on-fill)`);
    }
  });
});

// ---------------------------------------------------------------------------
// The CSS half of the lint
// ---------------------------------------------------------------------------

/** `background: …` and the semantic surface rebinds — the slots that PAINT. */
const GROUND_DECL =
  /(background(?:-color|-image)?|--surface-(?:base|lift|overlay)|--primary-base)\s*:\s*([^;{}]*)/gi;

/** `--x-on-y` in any prefix — app-level, `--mv1-*`, `--mv3-*` alike. */
const ON_TOKEN = /--[a-z0-9]+(?:-[a-z0-9]+)*-on-[a-z0-9]+(?:-[a-z0-9]+)*/gi;

/**
 * Comments are not code, and this scanner read them as such on its first run.
 *
 * `mv3.css` documents its own rule in prose — "an `-on-fill` in a
 * `background:` slot fails the guard" — and the declaration regex matched
 * that sentence, then ran its value capture across the next twelve comment
 * lines and reported the two token names it found there. Two false positives,
 * in the file that states the rule correctly.
 *
 * Worth stripping rather than tuning around, because of what a false positive
 * costs here specifically: this class survived eleven rounds, and the mv3
 * guard's own notes say it twice — "a guard that cries wolf gets switched off,
 * and a switched-off guard is how this class survived nine rounds."
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, " ");

describe("no -on- token may be painted as a ground (.css)", () => {
  test("the scanner matches the shape it is looking for", () => {
    // A guard whose own matching is broken reports green forever, which is
    // the failure mode this whole file exists to rule out.
    const sample = ".x{background:var(--blue-on-fill)}";
    const hits = [...sample.matchAll(GROUND_DECL)].flatMap(([, , v]) => [
      ...v.matchAll(ON_TOKEN),
    ]);
    expect(hits.map((h) => h[0])).toEqual(["--blue-on-fill"]);
    // And it does NOT fire on the correct spelling.
    const ok = ".x{background:var(--blue-fill);color:var(--blue-on-fill)}";
    const okHits = [...ok.matchAll(GROUND_DECL)].flatMap(([, , v]) => [
      ...v.matchAll(ON_TOKEN),
    ]);
    expect(okHits).toEqual([]);
    // Nor on a comment that merely describes the rule — mv3.css does, and it
    // produced this scanner's first two false positives.
    const prose = "/* an `-on-fill` in a `background:` slot fails the guard.\n * --violet-on-fill */";
    expect(stripComments(prose).trim()).toBe("");
  });

  test("no stylesheet inverts the pair", () => {
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const [, prop, value] of source.matchAll(GROUND_DECL)) {
        for (const [token] of value.matchAll(ON_TOKEN)) {
          offenders.push(`${relative(SRC, file)}: ${prop}: var(${token})`);
        }
      }
    }
    expect(
      offenders,
      `A '-on-' token names INK and the ground it sits on; painting it as a
ground inverts the pair. Use the matching '-fill' leg as the background and
keep the '-on-' leg as the ink on it.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
