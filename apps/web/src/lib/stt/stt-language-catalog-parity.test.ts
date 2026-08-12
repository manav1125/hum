/**
 * Parity guard: the web spoken-language catalog mirrors the daemon's
 * authoritative roster (`DEEPGRAM_NOVA3_MONOLINGUAL_CODES` in
 * `assistant/src/providers/speech-to-text/deepgram.ts`). apps/web cannot
 * import from `assistant/`, so the catalog holds a copy — and copies drift
 * silently: a stale catalog would offer a language the daemon was never
 * verified for, or hide one it supports. Tests run in-repo, so read the
 * daemon source directly (same technique as `llm-model-catalog.test.ts`,
 * which pins the web LLM catalog to a daemon-generated file via fs).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  STT_ENGLISH_CODE,
  STT_LANGUAGE_OPTIONS,
  STT_MONOLINGUAL_CODES,
  STT_MULTI_CODE,
  sttLanguageLabelForCode,
} from "./language-catalog";

// apps/web/src/lib/stt → repo root is five levels up.
const DAEMON_DEEPGRAM_SOURCE = readFileSync(
  join(
    import.meta.dir,
    "../../../../../assistant/src/providers/speech-to-text/deepgram.ts",
  ),
  "utf-8",
);

/** Pull the string entries of the array literal introduced by `opener`. */
function arrayCodesAfter(source: string, opener: string): string[] {
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`Not found in daemon source: ${opener}`);
  }
  const from = start + opener.length;
  // The daemon writes its rosters as `] as const;` arrays; accept a plain
  // `];` too so a const-assertion removal doesn't silently widen the scan.
  const end = Math.min(
    ...["] as const;", "];"]
      .map((terminator) => source.indexOf(terminator, from))
      .filter((index) => index !== -1),
  );
  if (!Number.isFinite(end)) {
    throw new Error(`Unterminated array after: ${opener}`);
  }
  return [...source.slice(from, end).matchAll(/"([a-z-]+)"/g)].map(
    (match) => match[1]!,
  );
}

const daemonMonolingualCodes = arrayCodesAfter(
  DAEMON_DEEPGRAM_SOURCE,
  "export const DEEPGRAM_NOVA3_MONOLINGUAL_CODES = [",
);

describe("web STT language catalog stays in sync with the daemon roster", () => {
  test("the daemon source parses into a usable roster", () => {
    expect(daemonMonolingualCodes.length).toBeGreaterThan(0);
    expect(new Set(daemonMonolingualCodes).size).toBe(
      daemonMonolingualCodes.length,
    );
  });

  test("the mirrored code list equals the daemon roster exactly", () => {
    const mirrored: string[] = [...STT_MONOLINGUAL_CODES];
    expect(mirrored.sort()).toEqual([...daemonMonolingualCodes].sort());
  });

  test("the catalog offers multi plus exactly the daemon roster", () => {
    const catalogCodes = STT_LANGUAGE_OPTIONS.map((option) => option.code);
    // No duplicates: a duplicate entry would mask a drift below.
    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);
    expect([...catalogCodes].sort()).toEqual(
      [STT_MULTI_CODE, ...daemonMonolingualCodes].sort(),
    );
  });

  test("multi and English lead as peer rows, roster follows A-Z", () => {
    expect(STT_LANGUAGE_OPTIONS[0]?.code).toBe(STT_MULTI_CODE);
    expect(STT_LANGUAGE_OPTIONS[1]?.code).toBe(STT_ENGLISH_CODE);
    const rosterLabels = STT_LANGUAGE_OPTIONS.slice(2).map(
      (option) => option.label,
    );
    expect(rosterLabels).toEqual(
      [...rosterLabels].sort((a, b) => a.localeCompare(b, "en")),
    );
  });

  test("the multi sentinel carries the value the daemon special-cases", () => {
    // deepgramLanguageOptions() pins nova-3 for any configured language and
    // the daemon schema defaults services.stt.language to this exact string.
    expect(STT_MULTI_CODE).toBe("multi");
    expect(DAEMON_DEEPGRAM_SOURCE).toContain('"multi"');
  });

  test("every option has a real display name (Intl or fallback held)", () => {
    for (const option of STT_LANGUAGE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      if (option.code !== STT_MULTI_CODE) {
        // A label equal to its bare code means both Intl.DisplayNames and
        // the static fallback map missed it.
        expect(option.label).not.toBe(option.code);
      }
    }
  });

  test("an unknown custom code renders verbatim", () => {
    expect(sttLanguageLabelForCode("en-US")).toBe("en-US");
    expect(sttLanguageLabelForCode(STT_MULTI_CODE)).toBe("Multilingual");
  });
});
