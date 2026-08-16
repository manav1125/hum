/**
 * Round-4.1 frame 59 — the corner-badge tone rule: badges are always opaque
 * and the chip tone follows the ART (background/dominant color luminance),
 * not the fidelity. Dark artwork → solid light chip; light/busy artwork →
 * dark glass chip; unknown art defaults to dark glass (the correct read for
 * the light/busy slide artwork dominating the library).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

/**
 * A slides card used to be one big <button> with the EXACT/INSPIRED toggle's
 * own buttons nested inside it. Browsers flatten nested interactive elements
 * however they please, which cost keyboard users the toggle: it was not
 * reliably focusable or operable, and the card announced as a single control.
 * The card is now a container with the select affordance and the fidelity
 * toggle as SIBLING buttons.
 */
describe("CreateGalleryOverlay — the slides card is not one big button", () => {
  afterEach(() => {
    cleanup();
  });

  function openSlides() {
    return render(
      <CreateGalleryOverlay
        mode="slides"
        hasBrand={false}
        onConfirm={() => {}}
        onTakeAiDirection={() => {}}
        onClose={() => {}}
      />,
    );
  }

  test("no interactive element is nested inside another", () => {
    openSlides();
    expect(document.querySelectorAll("button button").length).toBe(0);
    expect(document.querySelectorAll("a button, button a").length).toBe(0);
  });

  test("select and fidelity are separate, independently reachable controls", () => {
    openSlides();
    const selects = Array.from(
      document.querySelectorAll<HTMLElement>("button[aria-label^='Use the ']"),
    );
    expect(selects.length).toBeGreaterThan(0);

    const fidelity = Array.from(
      document.querySelectorAll<HTMLElement>("button"),
    ).filter((b) => b.textContent === "EXACT" || b.textContent === "INSPIRED");
    expect(fidelity.length).toBeGreaterThan(0);

    // Neither contains the other — so tabbing reaches both, and each is its
    // own control to a screen reader.
    for (const f of fidelity) {
      for (const s of selects) {
        expect(s.contains(f)).toBe(false);
        expect(f.contains(s)).toBe(false);
      }
    }

    // Within a card the select affordance comes first in DOM order, so the
    // tab order matches the reading order: pick the template, then adjust it.
    const card = selects[0]!.parentElement!;
    const inCard = Array.from(card.querySelectorAll<HTMLElement>("button"));
    expect(inCard[0]).toBe(selects[0]);
    expect(inCard.length).toBeGreaterThan(1);
  });

  /**
   * The point of the change: a keyboard user must be able to walk to a card,
   * then to its EXACT/INSPIRED toggle, and operate it. (Chrome's own flattening
   * of the old nested markup is exactly what made this unreliable.)
   */
  test("the keyboard reaches the card, then its fidelity toggle, and works it", async () => {
    const user = userEvent.setup();
    openSlides();
    document.querySelector<HTMLInputElement>("input")!.focus();

    await user.tab();
    const select = document.activeElement as HTMLElement;
    expect(select.getAttribute("aria-label")).toMatch(/^Use the /);

    await user.tab();
    expect(document.activeElement?.textContent).toBe("EXACT");

    await user.tab();
    const inspired = document.activeElement as HTMLElement;
    expect(inspired.textContent).toBe("INSPIRED");
    // Not the active fidelity yet…
    expect(inspired.style.background).not.toContain("mv1-blue");

    await user.keyboard("{Enter}");
    // …and pressing it from the keyboard switches the mode.
    expect(
      (document.activeElement as HTMLElement).style.background,
    ).toContain("mv1-blue");

    // The select affordance still works from the keyboard too.
    select.focus();
    await user.keyboard("{Enter}");
    expect(select.getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking a card still selects its template", () => {
    openSlides();
    const first = document.querySelector<HTMLElement>(
      "button[aria-label^='Use the ']",
    )!;
    expect(first.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });
});
