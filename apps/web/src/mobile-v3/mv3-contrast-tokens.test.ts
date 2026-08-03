/**
 * The contrast rule, computed instead of remembered.
 *
 * Design has logged NINE recurrences of one failure class on this project, and
 * its note on the eighth is why this file exists:
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
 * That is the same defect the guard exists to catch, committed by the guard.
 * A check that can only see the spelling it expects is a check you have to
 * remember to spell correctly — which is vigilance again, wearing a test's
 * clothes.
 *
 * So this version resolves the token layer for both themes and computes WCAG
 * contrast. It cannot be fooled by indirection, it does not care what anyone
 * named anything, and it fails on the number rather than on the syntax.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const MV3_ROOT = join(import.meta.dir);
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

const LIGHT = tokensIn(block(/^:root/m));
const DARK = new Map(LIGHT);
for (const [k, v] of tokensIn(block(/\[data-theme="dark"\]/))) DARK.set(k, v);

/** Follow `var(--x)` chains to a literal, or null when it is not a flat colour. */
function resolve(
  value: string,
  tokens: Map<string, string>,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  const trimmed = value.trim();
  const varMatch = trimmed.match(/^var\(\s*(--mv3-[a-z0-9-]+)\s*\)$/);
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
  // rgba(), gradients, color-mix(): not a flat colour, so not judged here.
  return null;
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

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    acc.push(full);
  }
  return acc;
}

const FILES = sourceFiles(MV3_ROOT);

/**
 * Every (ground, ink) pair that belongs to ONE control.
 *
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
    const bg = flat.match(/background(?:Color)?\s*:\s*["'`]?([^,;"'`}\n]+)/);
    const fg = flat.match(/(?:^|[^a-zA-Z-])color\s*:\s*["'`]?([^,;"'`}\n]+)/);
    if (bg && fg) out.push({ bg: bg[1].trim(), fg: fg[1].trim() });
  }
  return out;
}

describe("mobile-v3 contrast", () => {
  test("the token layer parsed — a silent zero would pass forever", () => {
    // The failure mode of a lint-by-test is a glob or a parse that quietly
    // matches nothing while the suite reports green. Which is, exactly, the
    // bug class this file is about.
    expect(LIGHT.size).toBeGreaterThan(30);
    expect(DARK.size).toBeGreaterThan(30);
    expect(resolve("var(--mv3-amber-btn-text)", LIGHT)).toBe("#ffffff");
    expect(resolve("var(--mv3-amber-btn-text)", DARK)).toBe("#211e16");
    expect(FILES.length).toBeGreaterThan(20);
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
  });

  test("every control's ink clears 4.5:1 on its own ground, in both themes", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const { bg, fg } of groundInkPairs(source)) {
        for (const [theme, tokens] of [
          ["light", LIGHT],
          ["dark", DARK],
        ] as const) {
          const ground = resolve(bg, tokens);
          const ink = resolve(fg, tokens);
          // Unresolvable means rgba/gradient/color-mix — not judged, because a
          // guess here would be worse than the gap.
          if (!ground || !ink) continue;
          const ratio = contrast(ground, ink);
          if (ratio < FLOOR) {
            offenders.push(
              `${file.replace(MV3_ROOT, "")} [${theme}] ${bg} under ${fg} = ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      `Ink below 4.5:1 on its own ground. A coloured control carrying light
text takes the -on-fill or -btn-bg leg as its BACKGROUND; small copy takes the
-text leg. Both halves of a control move together.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the ground-only greys never appear as text", () => {
    // Design names these as ground and hairline values only. They have no
    // legitimate `color:` use at any size, on any ground.
    const never = ["#5b5b68", "#8a8a7e", "#a8a89c"];
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const re = /(?:^|[^a-zA-Z-])color\s*:\s*["'`]?([^,;"'`}\n]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        const v = m[1].trim().toLowerCase();
        if (never.some((hex) => v.includes(hex))) {
          offenders.push(`${file.replace(MV3_ROOT, "")}: color: ${v}`);
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
