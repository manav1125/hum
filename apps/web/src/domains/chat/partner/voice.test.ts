/**
 * Cue's voice, held in place.
 *
 * §6.2 is a copy spec, and copy specs rot silently — one "Please try again."
 * slips back in per sprint until the product sounds like a form again. This
 * scans the chat domain's own source for the failures the spec names, so a
 * regression is a red test rather than a slow drift.
 *
 * Scoped to `domains/chat` (what this surface owns) and to source, not tests.
 * The inspector is developer tooling with its own register and is excluded.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHAT_ROOT = join(import.meta.dir, "..");

function chatSources(): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  for (const rel of new Glob("**/*.{ts,tsx}").scanSync(CHAT_ROOT)) {
    if (rel.includes(".test.") || rel.includes(".stories.")) continue;
    if (rel.startsWith("inspector/")) continue;
    files.push({ path: rel, text: readFileSync(join(CHAT_ROOT, rel), "utf8") });
  }
  return files;
}

/** Report every offending file so one run fixes the whole class. */
function offenders(pattern: RegExp): string[] {
  return chatSources()
    .filter((file) => pattern.test(file.text))
    .map((file) => file.path);
}

describe("Cue's voice", () => {
  test("finds enough source to be worth checking", () => {
    // A silent zero-file scan would make every assertion below vacuous.
    expect(chatSources().length).toBeGreaterThan(100);
  });

  test("never grovels", () => {
    // "Please try again." is the tell. "Try again?" says the same thing.
    expect(offenders(/Please try again/)).toEqual([]);
  });

  test("never enthusiastic about its own work", () => {
    // Praise from a tool about its own output is the tell that nobody's there.
    expect(
      offenders(
        /"[^"]*\b(Great news|Awesome|Woohoo|Perfect!|Nice work|All set!|I'd be happy to|Happy to help)\b/i,
      ),
    ).toEqual([]);
  });

  test("reports its own failures in the first person", () => {
    // "Failed to save X." is agentless — passive voice is where products
    // hide, and it is the fastest way to stop feeling like a partner.
    //
    // Scoped to the sinks that actually reach a person: the chat error
    // banner and toasts. Thrown `Error` messages inside the API clients are
    // developer strings that land in Sentry, not in front of the user, and
    // rewriting those in Cue's voice would make the logs worse, not better.
    const SINK = /(setError|setExitError|toast\.error)\s*\(/g;
    const AGENTLESS = /"(Failed to|Unable to|Could not|Couldn't)\b[^"]*"/;

    const agentless = chatSources().flatMap((file) => {
      const hits: string[] = [];
      for (const match of file.text.matchAll(SINK)) {
        const window = file.text.slice(match.index, match.index + 160);
        const offender = window.match(AGENTLESS);
        if (offender) hits.push(offender[0]);
      }
      return hits.length > 0 ? [`${file.path}: ${hits.join(" | ")}`] : [];
    });
    expect(agentless).toEqual([]);
  });

  test("#5B5B68 is never text", () => {
    // Regressed four times. It is a legitimate graphic fill; it is never a
    // text colour, in any spelling.
    expect(offenders(/text-\[#5B5B68\]|color:\s*["']#5B5B68/i)).toEqual([]);
  });
});
