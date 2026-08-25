import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  CompanionDrops,
  describeDrop,
  type DropChoice,
} from "./companion-drop";
import type { CompanionCaught } from "@vellumai/ipc-contract";

/**
 * Drops on the creature — design `C10`.
 *
 * The rule under test is that **nothing is stored until a choice is made**.
 * Dropping a contract on Cue is not filing it, and a drop nobody answers has
 * to end with the file exactly where it was — which is what makes letting go
 * safe enough to be the default.
 */

const LET_GO_MS = 40;
const pdf: CompanionCaught = { kind: "file", label: "acme-msa-v4.pdf" };

describe("a drop is held, not kept", () => {
  let presented: Array<CompanionCaught | null>;
  let handed: Array<{ choice: DropChoice; payload: string }>;
  let drops: CompanionDrops;

  beforeEach(() => {
    presented = [];
    handed = [];
    drops = new CompanionDrops(
      {
        present: (c) => presented.push(c),
        hand: (choice, _caught, payload) => handed.push({ choice, payload }),
      },
      LET_GO_MS,
    );
  });

  test("it names exactly what arrived", () => {
    drops.catch(pdf, "/Users/x/acme-msa-v4.pdf");
    expect(drops.current()?.label).toBe("acme-msa-v4.pdf");
  });

  test("REGRESSION: silence lets it go, and stores nothing", async () => {
    drops.catch(pdf, "/Users/x/acme-msa-v4.pdf");
    await Bun.sleep(LET_GO_MS + 30);

    expect(drops.current()).toBeNull();
    // Nothing was stored, so there is nothing to undo. That is the property
    // that makes letting go the safe default rather than a loss.
    expect(handed).toEqual([]);
    expect(presented.at(-1)).toBeNull();
  });

  test("✕ lets it go the same way", () => {
    drops.catch(pdf, "/Users/x/acme-msa-v4.pdf");
    drops.release();

    expect(drops.current()).toBeNull();
    expect(handed).toEqual([]);
  });

  test("each of the three choices hands it to the app, untouched", () => {
    for (const choice of ["read", "file", "note"] as DropChoice[]) {
      drops.catch(pdf, "/Users/x/acme-msa-v4.pdf");
      expect(drops.choose(choice)).toBe(true);
    }
    expect(handed.map((h) => h.choice)).toEqual(["read", "file", "note"]);
    expect(handed[0]?.payload).toBe("/Users/x/acme-msa-v4.pdf");
  });

  test("choosing after it has been let go does nothing at all", async () => {
    drops.catch(pdf, "/Users/x/acme-msa-v4.pdf");
    await Bun.sleep(LET_GO_MS + 30);

    expect(drops.choose("file")).toBe(false);
    expect(handed).toEqual([]);
  });

  test("a second drop replaces the first rather than queueing", () => {
    // Two things held at once means a chip that names one of them, and a chip
    // that does not name exactly what arrived is the one thing this gesture
    // cannot afford.
    drops.catch(pdf, "/a.pdf");
    drops.catch({ kind: "url", label: "example.com/x" }, "https://example.com/x");

    expect(drops.current()?.label).toBe("example.com/x");
    drops.choose("read");
    expect(handed).toHaveLength(1);
    expect(handed[0]?.payload).toBe("https://example.com/x");
  });

  test("REGRESSION: an answered drop does not get let go afterwards", async () => {
    // The timer outliving the answer would take the caught chip away from
    // under a person who had already chosen — or worse, publish over what
    // came next.
    drops.catch(pdf, "/a.pdf");
    drops.choose("read");
    presented.length = 0;
    await Bun.sleep(LET_GO_MS + 30);

    expect(presented).toEqual([]);
  });
});

describe("the chip says the real thing", () => {
  test("a file is named by its filename, not its path", () => {
    expect(
      describeDrop({ kind: "file", value: "/Users/x/Docs/acme-msa-v4.pdf" })
        .label,
    ).toBe("acme-msa-v4.pdf");
  });

  test("REGRESSION: a long filename keeps its extension", () => {
    // `acme-msa-v4.pdf` and `acme-msa-v4.pages` are a different mistake, and
    // the whole point of the chip is that the mistake is visible first.
    const label = describeDrop({
      kind: "file",
      value: "/x/a-very-long-contract-name-that-goes-on-and-on-forever.pdf",
    }).label;
    expect(label.endsWith(".pdf")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(34);
  });

  test("a URL drops its scheme, because nobody reads https://", () => {
    expect(
      describeDrop({ kind: "url", value: "https://example.com/pricing" }).label,
    ).toBe("example.com/pricing");
  });

  test("selected text is quoted back, collapsed to one line", () => {
    expect(
      describeDrop({ kind: "text", value: "  Dana wants\n  the 24-month term " })
        .label,
    ).toBe("Dana wants the 24-month term");
  });

  test("nothing is ever described as '1 item'", () => {
    for (const value of ["/x/y.pdf", "https://a.b", "some words"]) {
      for (const kind of ["file", "url", "text"] as const) {
        expect(describeDrop({ kind, value }).label).not.toBe("1 item");
      }
    }
  });
});
