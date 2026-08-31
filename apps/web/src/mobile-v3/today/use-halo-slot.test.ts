/**
 * Whether Halo has earned a row on Today, and what it is allowed to say.
 *
 * The judgement being tested is the same one `use-ritual-slot` makes: a slot
 * that renders whether or not it can say something true is how a permanent
 * empty row gets built by accident. Most people signed into Cue do not own a
 * Halo, and Today should look exactly as it did before Halo existed for them.
 */
import { describe, expect, test } from "bun:test";

import { faceFromStatus, haloLine, phraseLag } from "./use-halo-slot";

const heard = {
  sync: { state: "behind", behindSeconds: 190 },
  coveredThrough: 1,
};

describe("faceFromStatus", () => {
  test("no device and nothing heard renders nothing at all", () => {
    expect(faceFromStatus(undefined, false)).toBeNull();
    expect(
      faceFromStatus(
        {
          sync: { state: "unknown", behindSeconds: null },
          coveredThrough: null,
        },
        false,
      ),
    ).toBeNull();
  });

  test("a device that has synced earns the row even on the web", () => {
    const face = faceFromStatus(heard, false);
    expect(face).not.toBeNull();
    expect(face!.line).toBe("synced to 3 min ago");
    // No native surfaces here, so the row is a statement, not a control.
    expect(face!.canOpen).toBe(false);
  });

  test("native surfaces earn the row before anything has ever synced", () => {
    // Somebody who has just paired needs to see the card say so, not wait
    // for their first sync to discover Halo exists.
    const face = faceFromStatus(undefined, true);
    expect(face).not.toBeNull();
    expect(face!.line).toBe("nothing yet");
    expect(face!.canOpen).toBe(true);
  });

  test("an unrecognised state is unknown, never guessed into behind", () => {
    const face = faceFromStatus(
      { sync: { state: "wedged", behindSeconds: 60 }, coveredThrough: 1 },
      false,
    );
    expect(face!.state).toBe("unknown");
  });
});

describe("the line", () => {
  test("never prints a zero it invented", () => {
    // A fabricated 0 would claim Cue is current with a room it never heard.
    expect(haloLine("unknown", null)).toBe("nothing yet");
    expect(haloLine("behind", null)).toBe("nothing yet");
    expect(haloLine("up_to_date", null)).toBe("nothing yet");
  });

  test("has exactly three shapes", () => {
    expect(haloLine("up_to_date", 20)).toBe("up to date");
    expect(haloLine("behind", 190)).toBe("synced to 3 min ago");
    expect(haloLine("unknown", null)).toBe("nothing yet");
  });

  test("rounding never understates how stale the day is", () => {
    // 2h30m rounds UP. Telling somebody Cue is fresher than it is, is the one
    // direction this number must never fail in.
    expect(phraseLag(45)).toBe("just now");
    expect(phraseLag(150)).toBe("3 min");
    expect(phraseLag(3600)).toBe("1 hour");
    expect(phraseLag(9000)).toBe("3 hours");
  });

  test("matches the phrasing HaloKit uses on the native card", () => {
    // Card, Island, Day cover and this row all state the same number; if any
    // two disagree the honesty reads as inconsistency instead.
    expect(haloLine("behind", 190)).toContain("3 min");
  });
});
