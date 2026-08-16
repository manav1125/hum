/**
 * Round-4.1 frame 59 — the corner-badge tone rule: badges are always opaque
 * and the chip tone follows the ART (background/dominant color luminance),
 * not the fidelity. Dark artwork → solid light chip; light/busy artwork →
 * dark glass chip; unknown art defaults to dark glass (the correct read for
 * the light/busy slide artwork dominating the library).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import {
  CreateGalleryOverlay,
  chipToneForArt,
} from "./create-gallery-overlay";
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

/**
 * The brand toggle names the active brand ("In Northwind") rather than saying
 * "In your brand" at everyone. Covered by test rather than by screenshot on
 * purpose: the toggle only renders when a Brand Kit exists, and the developer
 * instance has none — so the branch that matters most here, a brand whose NAME
 * is unknown, is not reachable by looking at the running app at all.
 */
describe("CreateGalleryOverlay — the brand toggle", () => {
  afterEach(() => {
    cleanup();
  });

  function open(props: { hasBrand: boolean; brandName?: string | null }) {
    return render(
      <CreateGalleryOverlay
        mode="slides"
        hasBrand={props.hasBrand}
        brandName={props.brandName}
        onConfirm={() => {}}
        onTakeAiDirection={() => {}}
        onClose={() => {}}
      />,
    );
  }

  test("names the brand when the name is known", () => {
    open({ hasBrand: true, brandName: "Northwind" });
    expect(document.body.textContent).toContain("In Northwind");
    expect(document.body.textContent).not.toContain("In your brand");
  });

  test("falls back to 'your brand' rather than guessing a name", () => {
    // hasBrand can be true while the name is still null — the kit is known to
    // exist before its display name has loaded. Inventing one would be the
    // fabrication this codebase keeps ruling against; "your brand" is true.
    open({ hasBrand: true, brandName: null });
    expect(document.body.textContent).toContain("In your brand");
  });

  test("no toggle at all when there is no brand", () => {
    open({ hasBrand: false, brandName: null });
    expect(document.body.textContent).not.toContain("In your brand");
  });
});
