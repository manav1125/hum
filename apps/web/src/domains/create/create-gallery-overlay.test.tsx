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

/**
 * Desktop mock frame 1a (site/create.html) puts a blue ✓ in the top-right of a
 * selected template card, and the slides card renders one. It was never
 * VISIBLE: the card layers its thumbnail and preview inside a
 * `position: relative` media frame that comes after the badge in the tree, so
 * with both on `z-index: auto` the artwork painted straight over the check.
 * A stacking bug leaves the DOM perfectly correct, so this is asserted on the
 * layering rather than on the badge merely existing.
 */
describe("CreateGalleryOverlay — the selected ✓ is painted above the artwork", () => {
  afterEach(() => {
    cleanup();
  });

  /** The ✓ badge inside a card: the aria-hidden pill, not the fidelity chip. */
  function badgeIn(card: HTMLElement): HTMLElement | undefined {
    return Array.from(card.children).find(
      (c): c is HTMLElement =>
        c instanceof HTMLElement &&
        c.getAttribute("aria-hidden") !== null &&
        c.style.borderRadius === "999px",
    );
  }

  function selectFirstSlidesCard(): HTMLElement {
    render(
      <CreateGalleryOverlay
        mode="slides"
        hasBrand={false}
        onConfirm={() => {}}
        onTakeAiDirection={() => {}}
        onClose={() => {}}
      />,
    );
    const select = document.querySelector<HTMLElement>(
      "button[aria-label^='Use the ']",
    )!;
    fireEvent.click(select);
    return select.parentElement as HTMLElement;
  }

  test("the badge outranks every positioned sibling that follows it", () => {
    const card = selectFirstSlidesCard();
    const badge = badgeIn(card);
    expect(badge).toBeDefined();

    const badgeZ = Number(badge!.style.zIndex);
    expect(Number.isNaN(badgeZ)).toBe(false);

    // The media frame is positioned and comes LATER in the tree, so on equal
    // z-index it would win on tree order alone — the badge must outrank it.
    const laterPositioned = Array.from(card.children)
      .slice(Array.from(card.children).indexOf(badge!) + 1)
      .filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement &&
          (c.style.position === "relative" || c.style.position === "absolute"),
      );
    expect(laterPositioned.length).toBeGreaterThan(0);
    for (const sib of laterPositioned) {
      const z = sib.style.zIndex === "" ? 0 : Number(sib.style.zIndex);
      expect(badgeZ).toBeGreaterThan(z);
    }
  });

  test("the badge does not eat the card's own clicks", () => {
    const card = selectFirstSlidesCard();
    // Lifting the badge puts it over the full-bleed select button, so it has
    // to stay transparent to the pointer or it would punch a dead 22px hole in
    // the corner of every selected card.
    expect(badgeIn(card)!.style.pointerEvents).toBe("none");
  });

  test("the fidelity chip still sits above the lifted badge", () => {
    const card = selectFirstSlidesCard();
    const badgeZ = Number(badgeIn(card)!.style.zIndex);
    const fidelity = Array.from(card.querySelectorAll<HTMLElement>("button"))
      .find((b) => b.textContent === "EXACT" || b.textContent === "INSPIRED")!
      .closest<HTMLElement>("span[style*='z-index']")!;
    expect(Number(fidelity.style.zIndex)).toBeGreaterThan(badgeZ);
  });
});
