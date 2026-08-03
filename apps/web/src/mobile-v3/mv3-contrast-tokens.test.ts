/**
 * The contrast rule, enforced instead of remembered.
 *
 * Design has now logged EIGHT recurrences of one failure class across this
 * project, and its note on the eighth is the reason this file exists:
 *
 *   "Eight recurrences of the same shape means the remaining fix is
 *    structural, not vigilance: name the tokens for their ground and role so
 *    the wrong value can't be typed into the right slot."
 *
 * The seventh landed inside the pack that was drawn to demonstrate the fix,
 * on the very chevrons the frame existed to show. That is what a rule enforced
 * by attention looks like at scale, and it is the same lesson this codebase
 * learned about tool descriptions: a description is not enforcement. The DENY
 * has to live where the wrong thing is done.
 *
 * The shape, every time: **a bright fill leg used where text has to be read.**
 * Either a bright hue as small text on a dark ground, or white text sitting on
 * a bright hue. Both measure in the 3.x:1 range; both look fine to whoever
 * typed them.
 *
 * So: the `-on-fill` tokens are the ground under white text, the `-text`
 * tokens are small copy, and the bare fill legs belong to glyphs, borders,
 * rings, progress strokes and display type at 16px and up. This test reads the
 * real `mobile-v3` sources and fails when a fill leg reappears in a text slot.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const MV3_ROOT = join(import.meta.dir);

/**
 * Bright fill values that must never carry text.
 *
 * Sourced from design's table (BRIEF-FOR-CODE §7) plus the two the phone had
 * already shipped. Compared case-insensitively — `#7F77DD` and `#7f77dd` are
 * the same mistake.
 */
const FILL_ONLY_HEXES = [
  "#7f77dd", // violet fill — shipped under white text at 3.76:1
  "#3d6ee8", // accent fill
  "#b4770f", // needs-you fill
  "#0e8c8c", // life/time fill
  "#c24e42", // error fill
  "#534ab7", // review fill (bright leg; the -on-fill leg is the same value
  //             as a GROUND, which is why the slot matters and not the value)
];

/**
 * Values design named as ground/hairline only — never text at any size, on
 * any ground. These have no legitimate `color:` use.
 */
const NEVER_TEXT_HEXES = ["#5b5b68", "#8a8a7e", "#a8a89c"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    // The token layer DEFINES these values; it is the one place they belong.
    if (entry === "mv3.css") continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    acc.push(full);
  }
  return acc;
}

/** Every `color: "..."` / `color:"..."` / CSS `color:` value in a file. */
function colorValues(source: string): string[] {
  const out: string[] = [];
  // JSX style objects (`color: "#fff"`) and CSS declarations (`color: #fff;`).
  const re = /(?:^|[^a-zA-Z-])color\s*:\s*["'`]?([^,;"'`}\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1].trim().toLowerCase());
  return out;
}

const FILES = sourceFiles(MV3_ROOT);

describe("mobile-v3 contrast tokens", () => {
  test("the sweep actually reads files — a silent zero would pass forever", () => {
    // The failure mode of a lint-by-test is that the glob quietly matches
    // nothing and the suite goes green while enforcing not one thing. Which
    // is, exactly, the bug class this whole file is about.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.endsWith(".tsx"))).toBe(true);
  });

  test("no bright fill leg is used as a text colour", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const value of colorValues(source)) {
        for (const hex of FILL_ONLY_HEXES) {
          if (value.includes(hex)) {
            offenders.push(`${file.replace(MV3_ROOT, "")}: color: ${value}`);
          }
        }
      }
    }
    // The message names the fix, because a bare list of hexes teaches nobody
    // which token to reach for instead.
    expect(
      offenders,
      `Bright fill legs used as text. Small copy takes the -text leg
(--mv3-accent-text / --mv3-amber-text / --mv3-violet-text / --mv3-teal-text);
white text on a coloured control takes the -on-fill leg as its BACKGROUND.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the ground-only greys never appear as text", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      for (const value of colorValues(source)) {
        for (const hex of NEVER_TEXT_HEXES) {
          if (value.includes(hex)) {
            offenders.push(`${file.replace(MV3_ROOT, "")}: color: ${value}`);
          }
        }
      }
    }
    expect(
      offenders,
      `Ground/hairline colours used as text. Use --mv3-muted, which already
carries the right value for each theme.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("white text never sits on a bright fill", () => {
    // The other half of the class, and the one that shipped: a control whose
    // BACKGROUND is a bright leg while its text is white. `-on-fill` exists
    // precisely for this slot.
    const offenders: string[] = [];
    const bgRe =
      /background\s*:\s*["'`]?\s*var\(--mv3-(violet-fill|accent|amber|teal|fail)\)/g;
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = bgRe.exec(source)) !== null) {
        // Look at the declaration block that follows: white text within the
        // next few lines means this is a text context.
        const after = source.slice(m.index, m.index + 400);
        if (/color\s*:\s*["'`]?\s*(#fff|#ffffff|white)/i.test(after)) {
          offenders.push(`${file.replace(MV3_ROOT, "")}: --mv3-${m[1]} under white text`);
        }
      }
    }
    expect(
      offenders,
      `A coloured fill carrying white text is a text context and takes the
-on-fill leg (--mv3-violet-on-fill / --mv3-accent-on-fill / etc.) as its
background.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
