/**
 * No template may instruct the model to invent a number.
 *
 * Found by the agent building the mobile Create flow, in the QBR deck's
 * prompt: *"Seed realistic placeholder figures where I haven't given
 * numbers."* A metrics dashboard carried the same instruction for its data.
 *
 * The word doing the damage is **realistic**. A bracketed `[revenue]` is a
 * placeholder; a plausible `$38.4K, up 18% MoM` is a fabrication that reads
 * exactly like a measurement, in a deck whose entire purpose is to be shown to
 * other people. Somebody takes that into a board meeting.
 *
 * This is the same failure class as the brand extraction that returned a
 * hardcoded palette and invented font names as though it had read them off a
 * real site — the owner caught that one himself. There the fabrication was in
 * the client; here it is in the prompt, which is worse, because the model
 * complies and the output carries no tell.
 *
 * `a no-op is not a success` and `never a fake number` are the two oldest
 * rules in this product. A template that asks for fake numbers violates the
 * second one by construction, so the guard belongs on the templates rather
 * than on anyone's memory of having read them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const CREATE_DIR = join(import.meta.dir);

/**
 * Phrasings that ask a model to produce values that will pass for measured.
 *
 * Deliberately narrow. "Placeholder" alone is fine and useful — a template's
 * job is scaffolding. What is banned is the pairing of a placeholder with an
 * instruction to make it convincing, and any instruction to invent figures,
 * data or metrics outright.
 */
const FABRICATION_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /realistic\s+(placeholder|sample|example)?\s*(figures?|numbers?|data|metrics?|values?)/i,
    why: "asks for invented values that will read as measured",
  },
  {
    re: /(seed|invent|make up|fabricate|generate)\s+(realistic|plausible|believable)/i,
    why: "asks the model to make invented content convincing",
  },
  {
    re: /plausible\s+(figures?|numbers?|data|metrics?)/i,
    why: "asks for invented values that will read as measured",
  },
];

function templateFiles(): string[] {
  return readdirSync(CREATE_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => join(CREATE_DIR, f));
}

describe("Create templates never ask for invented figures", () => {
  const files = templateFiles();

  test("the sweep reads real files — a silent zero would pass forever", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(
      files.some((f) => f.endsWith("create-form-templates.ts")),
      "the file the defect was found in must be in scope",
    ).toBe(true);
  });

  test("the patterns catch the string that shipped", () => {
    // Anchor the guard against the real defect, so a future loosening of the
    // regex fails here rather than by quietly matching nothing.
    const shipped =
      "Seed realistic placeholder figures where I haven't given numbers.";
    expect(FABRICATION_PATTERNS.some((p) => p.re.test(shipped))).toBe(true);

    const alsoShipped = "Seed realistic placeholder data I can replace.";
    expect(FABRICATION_PATTERNS.some((p) => p.re.test(alsoShipped))).toBe(true);

    // And does not fire on legitimate scaffolding language.
    const fine = "Use a bracketed placeholder I can spot at a glance.";
    expect(FABRICATION_PATTERNS.some((p) => p.re.test(fine))).toBe(false);
  });

  test("no template prompt asks for invented figures", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { re, why } of FABRICATION_PATTERNS) {
        const found = source.match(re);
        if (found) {
          offenders.push(
            `${file.replace(CREATE_DIR, "")}: "${found[0]}" — ${why}`,
          );
        }
      }
    }
    expect(
      offenders,
      `A template prompt asks the model to invent values. Say what to do with a
gap instead: a visible bracketed blank, and a list of what was not supplied.
An invented figure in a deck is indistinguishable from a measured one.
\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("the two templates that carried it now forbid it explicitly", () => {
    // Removing the instruction is not the same as replacing it. A prompt that
    // says nothing about gaps leaves the model to its own defaults, and its
    // default on a KPI scorecard is to fill the scorecard.
    const source = readFileSync(
      join(CREATE_DIR, "create-form-templates.ts"),
      "utf8",
    );
    expect(source).toContain("Never invent a figure");
    expect(source).toContain("Never invent data");
  });
});
