/**
 * Round-4.1 frame 59 — the corner-badge tone rule: badges are always opaque
 * and the chip tone follows the ART (background/dominant color luminance),
 * not the fidelity. Dark artwork → solid light chip; light/busy artwork →
 * dark glass chip; unknown art defaults to dark glass (the correct read for
 * the light/busy slide artwork dominating the library).
 */
import { describe, expect, test } from "bun:test";

import { chipToneForArt } from "./create-gallery-overlay";
import { TEMPLATE_SPECS } from "./studio-specs";

describe("chipToneForArt", () => {
  test("dark artwork gets the solid light chip", () => {
    expect(chipToneForArt("#1A2230")).toBe("light-chip");
    expect(chipToneForArt("#0a0a0a")).toBe("light-chip");
    expect(chipToneForArt("#3D2B5C")).toBe("light-chip");
    // 3-digit hex parses too.
    expect(chipToneForArt("#123")).toBe("light-chip");
  });

  test("light artwork gets the dark glass chip", () => {
    expect(chipToneForArt("#E9ECF1")).toBe("dark-glass");
    expect(chipToneForArt("#ffffff")).toBe("dark-glass");
    expect(chipToneForArt("#f5f5f5")).toBe("dark-glass");
  });

  test("unknown / unparseable art defaults to dark glass", () => {
    expect(chipToneForArt(null)).toBe("dark-glass");
    expect(chipToneForArt(undefined)).toBe("dark-glass");
    expect(chipToneForArt("")).toBe("dark-glass");
    expect(chipToneForArt("linear-gradient(#000,#fff)")).toBe("dark-glass");
    expect(chipToneForArt("not-a-color")).toBe("dark-glass");
  });

  test("every real template palette resolves to a defined tone", () => {
    for (const t of TEMPLATE_SPECS) {
      expect(["light-chip", "dark-glass"]).toContain(
        chipToneForArt(t.palette.bg),
      );
    }
  });
});
