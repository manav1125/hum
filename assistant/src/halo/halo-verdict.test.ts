/**
 * The line somebody reads every evening.
 *
 * Two things are worth pinning here. The register has to follow the shape of
 * the day rather than the model's mood, and the ban has to hold — especially
 * the third clause, "no sentence that could apply to every day", which is the
 * one a prompt cannot enforce because such sentences read fine to whatever
 * wrote them.
 */
import { describe, expect, test } from "bun:test";

import {
  chooseRegister,
  inventoryVerdict,
  isBannedVerdict,
  type VerdictDayShape,
} from "./halo-verdict.js";

function shape(over: Partial<VerdictDayShape> = {}): VerdictDayShape {
  return {
    chapters: [
      {
        title: "Standup",
        summary: null,
        placeLabel: "OFFICE",
        hasOutcome: false,
      },
      {
        title: "Lunch with Tom",
        summary: null,
        placeLabel: null,
        hasOutcome: false,
      },
      {
        title: "Sprint review",
        summary: null,
        placeLabel: null,
        hasOutcome: false,
      },
    ],
    heardSeconds: 6 * 3600,
    wornSeconds: 8 * 3600,
    markCount: 0,
    weekday: "Tuesday",
    ...over,
  };
}

describe("choosing the register", () => {
  test("a settled day names the outcome", () => {
    expect(
      chooseRegister(
        shape({
          chapters: [
            ...shape().chapters,
            {
              title: "Acme",
              summary: null,
              placeLabel: null,
              hasOutcome: true,
            },
          ],
        }),
      ),
    ).toBe("outcome");
  });

  test("chapters without outcomes name the texture", () => {
    expect(chooseRegister(shape())).toBe("texture");
  });

  test("two chapters or fewer is thin, whatever else is true", () => {
    expect(
      chooseRegister(
        shape({
          chapters: [
            {
              title: "A walk",
              summary: null,
              placeLabel: null,
              hasOutcome: true,
            },
          ],
        }),
      ),
    ).toBe("thin");
  });

  test("a mostly-unheard day scopes itself first", () => {
    // The verdict must not read as though it covered hours nobody wore it.
    expect(
      chooseRegister(shape({ heardSeconds: 3 * 3600, wornSeconds: 14 * 3600 })),
    ).toBe("gap_scoped");
  });

  test("gap-scoping outranks having an outcome", () => {
    expect(
      chooseRegister(
        shape({
          heardSeconds: 3600,
          wornSeconds: 14 * 3600,
          chapters: [
            {
              title: "Sprint",
              summary: null,
              placeLabel: null,
              hasOutcome: true,
            },
            { title: "b", summary: null, placeLabel: null, hasOutcome: true },
            { title: "c", summary: null, placeLabel: null, hasOutcome: true },
          ],
        }),
      ),
    ).toBe("gap_scoped");
  });
});

describe("the ban", () => {
  test("rejects scoring words", () => {
    expect(isBannedVerdict("A productive morning with Dana")).toBe(true);
    expect(isBannedVerdict("A slow afternoon")).toBe(true);
    expect(isBannedVerdict("A busy day at the office")).toBe(true);
  });

  test("rejects apology and absence-noting", () => {
    expect(isBannedVerdict("Not much happened today")).toBe(true);
    expect(isBannedVerdict("Unfortunately little was heard")).toBe(true);
  });

  test("rejects sentences that would fit any other day", () => {
    // The clause a prompt cannot hold: each of these reads fine to the model
    // that wrote it, and is worthless to the person reading it.
    expect(isBannedVerdict("A day of conversations and decisions")).toBe(true);
    expect(isBannedVerdict("A mix of meetings and errands")).toBe(true);
    expect(isBannedVerdict("Caught up on things")).toBe(true);
    expect(isBannedVerdict("A typical day")).toBe(true);
  });

  test("allows a plain, specific sentence", () => {
    expect(isBannedVerdict("The morning found Acme its number")).toBe(false);
    expect(isBannedVerdict("Mostly errands, and a long call with Ma")).toBe(
      false,
    );
    expect(
      isBannedVerdict("Of the afternoon I heard: the sprint got its cut"),
    ).toBe(false);
  });

  test("does not catch a scoring word inside an innocent one", () => {
    // "slow" must not fire on "slowly"; the ban is on whole words.
    expect(isBannedVerdict("The Airtel deck came together slowly")).toBe(false);
  });

  test("an empty verdict is banned, so the fallback runs", () => {
    expect(isBannedVerdict("   ")).toBe(true);
  });
});

describe("the inventory fallback", () => {
  test("is specific and unglamorous rather than poetic", () => {
    expect(inventoryVerdict(shape())).toBe(
      "3 conversations, nothing that needed keeping.",
    );
  });

  test("counts what the wearer marked, because they chose it", () => {
    expect(inventoryVerdict(shape({ markCount: 1 }))).toBe(
      "3 conversations, one you marked.",
    );
    expect(inventoryVerdict(shape({ markCount: 2 }))).toBe(
      "3 conversations, 2 you marked.",
    );
  });

  test("a single conversation is singular", () => {
    expect(
      inventoryVerdict(
        shape({
          chapters: [
            { title: "a", summary: null, placeLabel: null, hasOutcome: false },
          ],
        }),
      ),
    ).toContain("1 conversation,");
  });

  test("an empty day says so without apologising", () => {
    const text = inventoryVerdict(
      shape({ chapters: [], heardSeconds: 2 * 3600 }),
    );
    expect(text).toBe("2 hours heard, nothing that needed keeping.");
    expect(isBannedVerdict(text)).toBe(false);
  });

  test("every fallback it can produce passes its own ban", () => {
    const cases = [
      shape(),
      shape({ markCount: 3 }),
      shape({ chapters: [] }),
      shape({ chapters: [], heardSeconds: 0 }),
    ];
    for (const c of cases) {
      expect(isBannedVerdict(inventoryVerdict(c))).toBe(false);
    }
  });
});
