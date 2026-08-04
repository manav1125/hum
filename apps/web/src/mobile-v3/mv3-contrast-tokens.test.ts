/**
 * The contrast rule, computed instead of remembered — and now the NAMING
 * rule, enforced instead of documented.
 *
 * Design has logged NINE recurrences of one failure class on this project.
 * Its note on the eighth is why this file exists:
 *
 *   "Eight recurrences of the same shape means the remaining fix is
 *    structural, not vigilance: name the tokens for their ground and role so
 *    the wrong value can't be typed into the right slot."
 *
 * The first version of this test matched literal `#fff` next to a bright
 * token. It caught four shipped violations on its first run — and then an
 * agent building the approval sheet measured the live button at **3.76:1** and
 * found the hole: the ink was `var(--mv3-amber-btn-text)`, a TOKEN that
 * resolves to white. A string match cannot see through a variable, so the
 * guard sailed straight past the ninth recurrence while reporting green.
 *
 * The second version resolved the token layer and computed WCAG. That closed
 * the indirection hole and left two others, both of which were hiding live
 * failures when v35 arrived:
 *
 *  1. **It only read `src/mobile-v3/`.** The tokens are consumed from
 *     `pages/projects/`, `domains/settings/`, `domains/guardrails/` and a
 *     dozen more. `pages/projects/mv3-projects.tsx` was painting white on
 *     `var(--mv3-amber)` — #B4770F, 3.76:1, the identical shape — outside the
 *     directory the guard happened to walk. A guard's blind spot is wherever
 *     the token layer reaches and the glob does not.
 *  2. **It judged only flat colours.** `linear-gradient(160deg, #4E7CEC,
 *     #3560CC)` under white was hand-typed at sixteen call sites and its light
 *     stop measures 3.88:1 at every one. A gradient is a ground; it has to
 *     clear its ink at EVERY stop, not at whichever one someone eyeballed.
 *
 * So this version reads every file that references the layer, judges gradients
 * stop by stop, and — the part v35 actually asked for — enforces the NAMES:
 *
 *   · a `-fill` / `-glyph` value may never land in an ink slot
 *   · an `-on-fill` value may never land in a ground slot
 *   · `-on-light` ink may never sit on a dark ground, or `-on-dark` on light
 *   · `-on-light` / `-on-dark` may never be redefined by a theme
 *
 * That last set is what makes the class structurally dead rather than merely
 * currently-absent. Contrast maths catches a wrong value; only the name rules
 * catch a right value in the wrong slot — the case where the number passes
 * today and stops passing the moment the theme, the ground, or the copy size
 * moves underneath it. Both halves have to hold, so both are tested.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

const MV3_ROOT = join(import.meta.dir);
/** `apps/web/src` — everything the token layer can reach. */
const SRC_ROOT = join(MV3_ROOT, "..");
const CSS = readFileSync(join(MV3_ROOT, "mv3.css"), "utf8");

/** WCAG AA for body text. Design's floor, and the product's. */
const FLOOR = 4.5;

// ---------------------------------------------------------------------------
// The token layer, resolved
// ---------------------------------------------------------------------------

function block(startPattern: RegExp): string {
  const m = CSS.match(startPattern);
  if (!m || m.index == null) return "";
  const from = CSS.indexOf("{", m.index);
  const to = CSS.indexOf("}", from);
  return CSS.slice(from, to);
}

function tokensIn(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--mv3-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.set(m[1], m[2].trim());
  return out;
}

const LIGHT_BLOCK = block(/^:root/m);
const DARK_BLOCK = block(/\[data-theme="dark"\]/);
const LIGHT = tokensIn(LIGHT_BLOCK);
const DARK = new Map(LIGHT);
for (const [k, v] of tokensIn(DARK_BLOCK)) DARK.set(k, v);

/** Follow `var(--x)` chains to a literal, or null when it is not a flat colour. */
function resolve(
  value: string,
  tokens: Map<string, string>,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  const trimmed = value.trim();
  const varMatch = trimmed.match(/^var\(\s*(--mv3-[a-z0-9-]+)\s*(?:,[^)]*)?\)$/);
  if (varMatch) {
    const next = tokens.get(varMatch[1]);
    return next ? resolve(next, tokens, depth + 1) : null;
  }
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^white$/i.test(trimmed)) return "#ffffff";
  if (/^black$/i.test(trimmed)) return "#000000";
  // rgba(), color-mix(): not a flat colour, so not judged here.
  return null;
}

/**
 * A gradient is a ground. Return every stop it paints, so the ink can be
 * judged against the worst of them rather than the convenient one.
 */
function gradientStops(
  value: string,
  tokens: Map<string, string>,
  depth = 0,
): string[] {
  if (depth > 8) return [];
  const trimmed = value.trim();
  const varMatch = trimmed.match(/^var\(\s*(--mv3-[a-z0-9-]+)\s*(?:,[^)]*)?\)$/);
  if (varMatch) {
    const next = tokens.get(varMatch[1]);
    return next ? gradientStops(next, tokens, depth + 1) : [];
  }
  if (!/gradient\(/i.test(trimmed)) return [];
  const stops: string[] = [];
  for (const raw of trimmed.match(/#[0-9a-f]{3,6}\b/gi) ?? []) {
    const flat = resolve(raw, tokens);
    if (flat) stops.push(flat);
  }
  return stops;
}

function luminance(hex: string): number {
  const channel = (n: number) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(hex.slice(1, 3), 16));
  const g = channel(parseInt(hex.slice(3, 5), 16));
  const b = channel(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Is this ground dark? The midpoint between the two canvases, not a guess. */
function isDarkGround(hex: string): boolean {
  return luminance(hex) < 0.18;
}

// ---------------------------------------------------------------------------
// The sources — everywhere the layer reaches, not one directory
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "generated", "__snapshots__"]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

/** Only files that actually reference the layer — the rest cannot break it. */
const FILES = sourceFiles(SRC_ROOT).filter(
  (f) => f !== join(MV3_ROOT, "mv3.css") && readFileSync(f, "utf8").includes("--mv3-"),
);

const show = (file: string) => relative(SRC_ROOT, file);

// ---------------------------------------------------------------------------
// Slots: which property a value landed in decides whether its NAME is legal
// ---------------------------------------------------------------------------

/** Properties that paint TYPE. Only ink tokens belong here. */
const INK_PROPS = new Set([
  "color",
  "caretcolor",
  "textdecorationcolor",
  "webkittextfillcolor",
  "-webkit-text-fill-color",
  // The design-library semantic rebinds mv3 surfaces perform: these carry
  // type wherever the reused desktop components render.
  "--content-default",
  "--content-secondary",
  "--content-tertiary",
  "--content-inset",
]);

/** Properties that paint a GROUND. Only fill tokens belong here. */
const GROUND_PROPS = new Set([
  "background",
  "backgroundcolor",
  "backgroundimage",
  "--surface-base",
  "--surface-lift",
  "--surface-overlay",
  "--primary-base",
]);

/**
 * The property a value was assigned to.
 *
 * Scans back for the nearest `identifier:`. A ternary's `:` is preceded by a
 * quote or brace rather than an identifier, so it is skipped without needing
 * to parse the expression — which matters, because most of the interesting
 * call sites are `cond ? "var(--a)" : "var(--b)"`.
 */
function propertyBefore(source: string, at: number): string | null {
  const window = source.slice(Math.max(0, at - 400), at);
  const re = /(?:^|[\s{,(])(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) last = m[1];
  return last ? last.toLowerCase() : null;
}

/**
 * Every (token, slot) placement in a file.
 *
 * This is the name check's whole input: it does not care what the value is,
 * only whether a token whose name states its role landed in a slot that role
 * forbids. That is the check contrast maths structurally cannot make.
 */
function placements(source: string): Array<{ token: string; prop: string }> {
  const out: Array<{ token: string; prop: string }> = [];
  const re = /var\(\s*(--mv3-[a-z0-9-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const prop = propertyBefore(source, m.index);
    if (prop) out.push({ token: m[1], prop });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ground/ink pairs belonging to ONE control
// ---------------------------------------------------------------------------

/**
 * Scoped to a single balanced style object, not a character window. The first
 * attempt used a 500-character window and produced 27 hits, most of them a
 * background from one element paired with text from the next — including a
 * ring stroke read as a text colour. A guard that cries wolf gets switched
 * off, and a switched-off guard is how this class survived nine rounds.
 */
function groundInkPairs(source: string): Array<{ bg: string; fg: string }> {
  const out: Array<{ bg: string; fg: string }> = [];
  // Walk each `style={{` / `style: {` and take the balanced object after it.
  const re = /style\s*[=:]\s*\{\{?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const from = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const objectText = source.slice(from, i + 1);
    // Nested objects (pseudo-selectors, media queries) belong to other
    // elements; strip them so only this control's own declarations remain.
    const flat = objectText.replace(/\{[^{}]*\}/g, (inner) =>
      inner === objectText ? inner : " ",
    );
    const bg = flat.match(/background(?:Color|Image)?\s*:\s*["'`]?([^,;"'`}\n]+)/);
    const fg = flat.match(/(?:^|[^a-zA-Z-])color\s*:\s*["'`]?([^,;"'`}\n]+)/);
    if (bg && fg) out.push({ bg: bg[1].trim(), fg: fg[1].trim() });
  }
  return out;
}

/**
 * The same pairing for plain CSS rule bodies — `.css` files and the CSS
 * template literals mv3 surfaces inject to retint reused components. The
 * approval card's amber ground lived in one of these.
 */
function cssRulePairs(source: string): Array<{ bg: string; fg: string }> {
  const out: Array<{ bg: string; fg: string }> = [];
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = m[1];
    const bg = body.match(/(?:^|[;\s])background(?:-color|-image)?\s*:\s*([^;]+)/);
    const fg = body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/);
    if (!bg || !fg) continue;
    const clean = (s: string) => s.replace(/!important/g, "").trim();
    out.push({ bg: clean(bg[1]), fg: clean(fg[1]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names that are gone, and the files that could not be migrated with them
// ---------------------------------------------------------------------------

/**
 * Retired names → what replaced them.
 *
 * `--mv3-faint` is still DEFINED (as an alias of the muted stop) so that the
 * files below keep rendering, and — because the alias moved the value — they
 * are actually FIXED by this change without being edited: they were painting
 * #8D99A5 at 2.62:1 and now paint the muted stop. They are listed here only
 * so no NEW use can be added.
 */
const RETIRED: Record<string, string> = {
  "--mv3-faint": "--mv3-muted for type, --mv3-dim-glyph for decoration",
  "--mv3-amber-btn-bg": "--mv3-amber-fill",
  "--mv3-amber-btn-text": "--mv3-amber-on-fill",
  "--mv3-accent-on-fill-legacy": "--mv3-accent-fill",
};

/**
 * Areas owned by other live sessions during the v35 token migration, which
 * this pass was not allowed to edit. Follow-ups, not exemptions.
 *
 * These are directory PREFIXES rather than a list of files, and that is a
 * deliberate second try. The exact-file version failed within the hour: a
 * session working in `mobile-v3/library/` added `uploads-section.tsx` while
 * this was being written, and an allowlist asserted by exact equality turns
 * every new file in someone else's directory into a broken build for
 * everyone. A guard that punishes work it cannot see gets switched off, and a
 * switched-off guard is how this class survived nine rounds.
 *
 * The trade is stated plainly: inside these two directories a retired name
 * still renders (correctly — the alias moved the value), and the guard only
 * reports it. Everywhere else it fails the build. Each prefix is asserted to
 * be STILL DIRTY, so once its owner migrates, this entry has to be deleted
 * rather than quietly outliving its reason.
 */
const UNMIGRATED_AREAS = [
  "mobile-v3/library/",
  "domains/onboarding/",
];

/** The hand-typed gradient, still present in two areas owned elsewhere. */
const UNMIGRATED_GRADIENT_AREAS = [
  "domains/chat/voice/",
  "domains/onboarding/",
];

const inArea = (file: string, areas: string[]) =>
  areas.some((a) => file.startsWith(a));

/**
 * Judge one ground-named ink usage. Legal only over a ground declared on the
 * same control that resolves to the SAME literal in both themes and matches
 * the polarity the token's name states.
 */
function offendersFor(
  source: string,
  token: string,
  polarity: string,
  file: string,
  out: string[],
): void {
  const pairs = [...groundInkPairs(source), ...cssRulePairs(source)];
  const owning = pairs.filter((p) => p.fg.includes(token));
  if (owning.length === 0) {
    out.push(
      `${file}: var(${token}) as ink with no ground of its own — that is the ambient canvas, which follows the theme.`,
    );
    return;
  }
  for (const { bg } of owning) {
    const light = resolve(bg, LIGHT);
    const dark = resolve(bg, DARK);
    if (!light || !dark) {
      out.push(`${file}: var(${token}) over ${bg} — ground is not a flat colour.`);
      continue;
    }
    if (light !== dark) {
      out.push(
        `${file}: var(${token}) over ${bg} — that ground moves between themes (${light} / ${dark}).`,
      );
      continue;
    }
    if (isDarkGround(light) !== (polarity === "dark")) {
      out.push(
        `${file}: var(${token}) over ${light} — that ink names the ${polarity} ground.`,
      );
    }
  }
}

describe("mobile-v3 contrast", () => {
  test("the token layer parsed — a silent zero would pass forever", () => {
    // The failure mode of a lint-by-test is a glob or a parse that quietly
    // matches nothing while the suite reports green. Which is, exactly, the
    // bug class this file is about.
    expect(LIGHT.size).toBeGreaterThan(30);
    expect(DARK.size).toBeGreaterThan(30);
    expect(resolve("var(--mv3-amber-on-fill)", LIGHT)).toBe("#ffffff");
    expect(resolve("var(--mv3-amber-on-fill)", DARK)).toBe("#211e16");
    // Two links of indirection: the alias → the ground-named leg → a literal.
    expect(resolve("var(--mv3-muted)", LIGHT)).toBe("#5a6672");
    expect(resolve("var(--mv3-muted)", DARK)).toBe("#9a9aa8");
    // The scan reaches past this directory — the hole that hid #B4770F under
    // white in pages/projects for as long as the guard read only mobile-v3.
    expect(FILES.length).toBeGreaterThan(60);
    expect(FILES.some((f) => show(f).startsWith("pages/projects/"))).toBe(true);
    expect(FILES.some((f) => show(f).startsWith("domains/"))).toBe(true);
  });

  test("contrast maths is right before it is trusted", () => {
    // Anchors, so a broken formula fails here rather than by passing
    // everything downstream.
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 1);
    // The exact pairing that shipped, and the number design measured.
    expect(contrast("#ffffff", "#b4770f")).toBeCloseTo(3.76, 1);
    // And its fix.
    expect(contrast("#ffffff", "#8a5a08")).toBeGreaterThan(FLOOR);
    // Gradients are read stop by stop, worst first.
    const stops = gradientStops("var(--mv3-accent-fill-gradient)", LIGHT);
    expect(stops.length).toBe(2);
    expect(Math.min(...stops.map((s) => contrast(s, "#ffffff")))).toBeGreaterThan(
      FLOOR,
    );
  });

  test("ground-named tokens carry their ground's value, in both themes", () => {
    // v35: "--muted-on-light / --muted-on-dark … so the wrong value can't be
    // typed into the right slot." The name is only load-bearing if the value
    // behind it is fixed, so this is the contract the names promise.
    for (const [theme, tokens] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      expect(`${theme}:${resolve("var(--mv3-muted-on-light)", tokens)}`).toBe(
        `${theme}:#5a6672`,
      );
      expect(`${theme}:${resolve("var(--mv3-muted-on-dark)", tokens)}`).toBe(
        `${theme}:#9a9aa8`,
      );
    }
    // …and each clears the floor on the ground it is named for.
    expect(contrast("#5a6672", "#f2f3f7")).toBeGreaterThan(FLOOR);
    expect(contrast("#5a6672", "#ffffff")).toBeGreaterThan(FLOOR);
    expect(contrast("#9a9aa8", "#0a0c12")).toBeGreaterThan(FLOOR);
    expect(contrast("#9a9aa8", "#1c202c")).toBeGreaterThan(FLOOR);
    // The dim decoration stop is NOT a text value on either canvas. This is
    // the number that makes `--mv3-faint`'s retirement non-negotiable.
    expect(contrast("#8d99a5", "#f2f3f7")).toBeLessThan(3);
  });

  test("every text leg clears the floor on the grounds it is read on", () => {
    // The gap this closes was found by rendering, not by reading. A text leg
    // is usually written with no background beside it — `color:
    // var(--mv3-accent-text)` on a bare span — so the ground/ink pair test
    // has nothing to pair it with, and where a ground IS declared it is
    // typically the rgba() card, which resolves to no flat colour. Between
    // those two, `--mv3-accent-text` sat at 4.28:1 in dark under a comment
    // asserting the legs measured "5.1–8.4:1". Prose is not a measurement.
    //
    // Every mv3 surface is one of two grounds, so they can simply be named:
    // the canvas, and the card composited over it. That makes the check
    // unconditional — it does not wait for a call site to declare anything.
    const GROUNDS = {
      light: { canvas: "#f2f3f7", card: "#ffffff" },
      // --mv3-card is rgba(28,32,44,.72) over --mv3-bg #0a0c12.
      dark: { canvas: "#0a0c12", card: "#151a24" },
    } as const;
    const offenders: string[] = [];
    for (const [theme, tokens] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      for (const name of tokens.keys()) {
        if (!/(-text|^--mv3-muted)$/.test(name)) continue;
        const ink = resolve(`var(${name})`, tokens);
        if (!ink) continue;
        for (const [where, ground] of Object.entries(GROUNDS[theme])) {
          const ratio = contrast(ground, ink);
          if (ratio < FLOOR) {
            offenders.push(
              `[${theme}] ${name} (${ink}) on the ${where} ${ground} = ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      `A text leg below 4.5:1 on a ground it is actually read on. Text legs
are written without a background beside them, so this is the only place the
number gets checked.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("a theme may not redefine a token that names its ground", () => {
    // `--mv3-muted-on-dark` means one thing everywhere or it means nothing.
    // If a future theme block redefines it, the name stops being a promise
    // and the whole scheme degrades back to "remember which one to use".
    const redefined = [...tokensIn(DARK_BLOCK).keys()].filter((k) =>
      /-on-(light|dark)$/.test(k),
    );
    expect(
      redefined,
      `These name their own ground, so a theme cannot change them. Redefine
the theme-following alias (--mv3-muted) instead.\n${redefined.join("\n")}`,
    ).toEqual([]);
  });

  test("every fill has an ink beside it, and the pair clears 4.5:1", () => {
    // Both halves of a control move together — the amber button shipped at
    // 3.76:1 because its ground and its ink lived in tokens nobody read
    // side by side.
    const offenders: string[] = [];
    for (const name of LIGHT.keys()) {
      const m = name.match(/^(--mv3-[a-z]+)-fill$/);
      if (!m) continue;
      const ink = `${m[1]}-on-fill`;
      if (!LIGHT.has(ink)) {
        offenders.push(`${name} has no ${ink}`);
        continue;
      }
      for (const [theme, tokens] of [
        ["light", LIGHT],
        ["dark", DARK],
      ] as const) {
        const ground = resolve(`var(${name})`, tokens);
        const inkValue = resolve(`var(${ink})`, tokens);
        if (!ground || !inkValue) continue;
        const ratio = contrast(ground, inkValue);
        if (ratio < FLOOR) {
          offenders.push(`[${theme}] ${name} under ${ink} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    // And the gradient grounds, at every stop.
    for (const name of LIGHT.keys()) {
      const m = name.match(/^(--mv3-[a-z]+)-fill-gradient$/);
      if (!m) continue;
      const ink = resolve(`var(${m[1]}-on-fill)`, LIGHT);
      if (!ink) continue;
      for (const stop of gradientStops(`var(${name})`, LIGHT)) {
        const ratio = contrast(stop, ink);
        if (ratio < FLOOR) {
          offenders.push(`${name} stop ${stop} under ink = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("every control's ink clears 4.5:1 on its own ground, in both themes", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const pairs = [...groundInkPairs(source), ...cssRulePairs(source)];
      for (const { bg, fg } of pairs) {
        for (const [theme, tokens] of [
          ["light", LIGHT],
          ["dark", DARK],
        ] as const) {
          const ink = resolve(fg, tokens);
          if (!ink) continue;
          // A gradient ground is judged at every stop; a flat one, directly.
          const grounds = gradientStops(bg, tokens);
          const flat = resolve(bg, tokens);
          if (flat) grounds.push(flat);
          // Unresolvable means rgba/color-mix — not judged, because a guess
          // here would be worse than the gap.
          for (const ground of grounds) {
            const ratio = contrast(ground, ink);
            if (ratio < FLOOR) {
              offenders.push(
                `${show(file)} [${theme}] ${ground} under ${fg} = ${ratio.toFixed(2)}:1`,
              );
            }
          }
        }
      }
    }
    expect(
      offenders,
      `Ink below 4.5:1 on its own ground. A coloured control carrying light
text takes the -fill leg as its BACKGROUND and the matching -on-fill as its
ink; small copy takes the -text leg. Both halves of a control move
together.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("a value may not be typed into a slot its name forbids", () => {
    // The rule contrast maths cannot express. `--mv3-violet-fill` as a
    // `color:` on a white card measures 6.93:1 and is still wrong: it is a
    // GROUND, and the day it is used as one under that same ink the pair
    // inverts. v35 asked for names that make this unspellable; this is where
    // "unspellable" is actually enforced.
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const { token, prop } of placements(source)) {
        // `-on-fill` ends in "-fill" too, so ink is tested for FIRST and
        // excluded from the ground test. (The first draft of this rule did
        // not, and reported all nineteen correct inks as grounds — a guard
        // whose own name-matching is sloppy is the thing it exists to stop.)
        const isInkToken = /-on-fill$/.test(token);
        const isGroundToken =
          !isInkToken && /-(fill|glyph|fill-gradient)$/.test(token);
        if (isGroundToken && INK_PROPS.has(prop)) {
          offenders.push(
            `${show(file)}: ${prop}: var(${token}) — that is a GROUND. Ink takes the -on-fill or -text leg.`,
          );
        }
        if (isInkToken && GROUND_PROPS.has(prop)) {
          offenders.push(
            `${show(file)}: ${prop}: var(${token}) — that is INK. A ground takes the -fill leg.`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("ground-named ink is only used over a ground that cannot move", () => {
    // `--mv3-muted-on-dark` over a light card reads as a smudge, and the
    // point of the name is that this is caught as a NAMING error at the call
    // site, before anyone computes anything.
    //
    // The strict form matters more than the obvious one. These two tokens
    // exist for grounds that DO NOT follow the theme — a permanently white
    // card, a permanently dark scrim. Over a theme-following ground they are
    // wrong in one theme by construction, whichever one you picked, because
    // the ground moves and the ink cannot. So the legal case is narrow: the
    // ground must be declared on the same control, resolve identically in
    // both themes, and match the polarity in the name. Anything else —
    // including no declared ground at all, which means the ambient canvas —
    // is the error. Every other surface wants `--mv3-muted`, the alias.
    //
    // (The first draft of this test only compared polarities when a ground
    // happened to be declared, so `color: var(--mv3-muted-on-dark)` on a bare
    // span sailed through. A mutation caught it. The rule has to name the
    // condition it is really asserting, not the one that is easy to compute.)
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const { token, prop } of placements(source)) {
        const named = token.match(/-on-(light|dark)$/);
        if (!named || !INK_PROPS.has(prop)) continue;
        offendersFor(source, token, named[1], show(file), offenders);
      }
    }
    expect(
      offenders,
      `Ground-named ink over a ground that can move. Use --mv3-muted (it
already resolves to the right stop per theme); reserve -on-light / -on-dark
for grounds that are the same colour in both themes.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("retired names are gone, except in the files logged as follow-ups", () => {
    const stragglers = new Map<string, string[]>();
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const [dead, replacement] of Object.entries(RETIRED)) {
        if (!new RegExp(`var\\(\\s*${dead}\\b`).test(source)) continue;
        const list = stragglers.get(show(file)) ?? [];
        list.push(`${dead} → ${replacement}`);
        stragglers.set(show(file), list);
      }
    }
    const unexpected = [...stragglers.entries()]
      .filter(([f]) => !inArea(f, UNMIGRATED_AREAS))
      .map(([f, uses]) => `${f}: ${uses.join(", ")}`);
    expect(
      unexpected,
      `Retired token names. These were renamed for their ground and role in
the v35 pass; the old spellings describe the wrong slot.\n${unexpected.join("\n")}`,
    ).toEqual([]);

    // Each exempted area must still contain at least one straggler, so the
    // exemption cannot outlive its reason. When one of these starts failing,
    // its owner has finished the migration — delete the entry, and when the
    // list is empty delete `--mv3-faint` from mv3.css too.
    const stale = UNMIGRATED_AREAS.filter(
      (area) => ![...stragglers.keys()].some((f) => f.startsWith(area)),
    );
    expect(
      stale,
      `These areas are clean now — remove them from UNMIGRATED_AREAS so the
guard covers them.\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("the primary gradient is a token, not a literal anyone can retype", () => {
    // Sixteen hand-copied copies of one gradient, all at 3.88:1 under white.
    // No rename protects a literal — only naming it once does.
    const raw: string[] = [];
    for (const file of FILES) {
      if (!/#4E7CEC/i.test(readFileSync(file, "utf8"))) continue;
      raw.push(show(file));
    }
    const unexpected = raw.filter((f) => !inArea(f, UNMIGRATED_GRADIENT_AREAS));
    expect(
      unexpected,
      `Hand-typed accent gradient. Use var(--mv3-accent-fill-gradient), whose
stops all clear 4.5:1 under --mv3-accent-on-fill.\n${unexpected.join("\n")}`,
    ).toEqual([]);
    const stale = UNMIGRATED_GRADIENT_AREAS.filter(
      (area) => !raw.some((f) => f.startsWith(area)),
    );
    expect(
      stale,
      `Clean now — remove from UNMIGRATED_GRADIENT_AREAS.\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("the ground-only greys never appear as text", () => {
    // Design names these as ground and hairline values only. They have no
    // legitimate `color:` use at any size, on any ground. #8D99A5 is mv3's
    // own member of the set — it was `--mv3-faint`, and it was type.
    const never = ["#5b5b68", "#8a8a7e", "#a8a89c", "#8d99a5"];
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const re = /(?:^|[^a-zA-Z-])color\s*:\s*["'`]?([^,;"'`}\n]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const v = m[1].trim().toLowerCase();
        if (never.some((hex) => v.includes(hex))) {
          offenders.push(`${show(file)}: color: ${v}`);
        }
      }
    }
    expect(
      offenders,
      `Ground/hairline colours used as text. Use --mv3-muted, which already
carries the right value for each theme.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
