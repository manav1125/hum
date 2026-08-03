/**
 * Two rules the Create sheet's stylesheet has to keep, both learned the
 * expensive way on an iPhone 16.
 *
 * happy-dom has no layout engine, so these are assertions about the CSS text
 * rather than about rendered boxes — the boxes were measured on the device and
 * the numbers are quoted in each test. What a test can do here is stop the
 * exact declaration that produced them from coming back.
 */

import { describe, expect, test } from "bun:test";

import {
  FULL_DETENT,
  PEEK_DETENT,
  fittedPeekHeight,
} from "./create-sheet-geometry";

const css = await Bun.file(
  new URL("./mv3-create.css", import.meta.url).pathname,
).text();

/** The body of a single rule, by selector. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is missing from mv3-create.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("the sheet's scrollers keep their origin reachable", () => {
  test(".mv3c-flow does not bottom-anchor with justify-content", () => {
    // `justify-content: flex-end` on an `overflow-y: auto` box distributes the
    // overflow off the TOP, and scrollTop cannot go negative. Measured before
    // the fix: the first bubble sat at y = -559 with scrollTop 0 of a maximum
    // 642 — 642px of the conversation painted outside the sheet, unreachable.
    const flow = rule(".mv3c-flow");
    expect(flow).toContain("overflow-y: auto");
    expect(flow).not.toContain("justify-content: flex-end");
    expect(flow).not.toContain("justify-content: center");
  });

  test("…it bottom-anchors with an auto margin instead", () => {
    // The behaviour the design asks for ("short flows sit against the footer")
    // survives: an auto margin absorbs free space and resolves to zero when
    // there is none, so the scroll origin stays where it can be reached.
    expect(rule(".mv3c-flow > *:first-child")).toContain("margin-top: auto");
  });

  test("every scroller in the sheet contains its overscroll", () => {
    for (const selector of [".mv3c-body", ".mv3c-flow"]) {
      expect(
        rule(selector),
        `${selector} scrolls but lets the drag chain to the page behind it`,
      ).toContain("overscroll-behavior: contain");
    }
  });
});

describe("the detent handle is a real control", () => {
  test(".mv3c-grabber is a block box", () => {
    // It is a `<span>`. Without an explicit display it is inline, so width,
    // height and the auto margins are ignored: measured at 0px tall, which
    // made `.mv3c-grabstrip` 0px tall too — the sheet's only detent control
    // had no visible handle and no hit area.
    const grabber = rule(".mv3c-grabber");
    expect(grabber).toContain("display: block");
    expect(grabber).toContain("height: 5px");
    expect(grabber).toContain("width: 40px");
  });
});

describe("the peek detent fits the stage it is showing", () => {
  /**
   * The Create entry, measured on an iPhone 16 with the 42%-of-viewport peek.
   *
   * Phone shell, 393×852 — the geometry in the owner's screenshot. Sheet
   * 494→852 (h358); scroller 518→688 (client 170) holding 271px of content; the
   * two type cards laid out 606→718, so 30px of each card — its rounded foot,
   * its "N templates" count and the bottom of its name — fell past 688 and were
   * clipped; the footer began at exactly 688, which is why the clip read as the
   * composer cutting the cards in half; and the "+4 more types" row, at
   * 729→771, was outside the sheet altogether.
   */
  const PHONE_SHELL = { viewportH: 852, sheetH: 0.42 * 852, bodyClientH: 170, bodyScrollH: 271 };
  /**
   * The same stage in Safari on the same device, where the browser chrome
   * leaves a 393×659 viewport: sheet 382→659 (h277), scroller 406→494 (client
   * 88) for the same 271px, so the cards were laid out 494→605 — below the
   * scroller's last pixel, and not visible at all.
   */
  const DEVICE_SAFARI = { viewportH: 659, sheetH: 0.42 * 659, bodyClientH: 88, bodyScrollH: 270 };

  test("it grows past 42% by exactly the height the scroller was short", () => {
    // 459 is what the sheet measured on the device after the fix, in both
    // shells: the same content plus the same chrome, so the same answer.
    expect(Math.round(fittedPeekHeight(PHONE_SHELL))).toBe(459);
    expect(Math.round(fittedPeekHeight(DEVICE_SAFARI))).toBe(459);
  });

  test("…which is precisely enough, and no more", () => {
    // Chrome is whatever the sheet is that the scroller is not, and it does not
    // change when the sheet grows. So the scroller ends up exactly as tall as
    // its content: nothing clipped, and no dead space either.
    for (const m of [PHONE_SHELL, DEVICE_SAFARI]) {
      const chrome = m.sheetH - m.bodyClientH;
      expect(fittedPeekHeight(m) - chrome).toBeCloseTo(m.bodyScrollH, 5);
    }
  });

  test("the fit is a fixpoint, so measuring the grown sheet does not move it", () => {
    // The measurement runs after every render. If feeding the result back in
    // produced a different result it would oscillate forever.
    const settled = fittedPeekHeight(PHONE_SHELL);
    const chrome = PHONE_SHELL.sheetH - PHONE_SHELL.bodyClientH;
    const again = fittedPeekHeight({
      viewportH: PHONE_SHELL.viewportH,
      sheetH: settled,
      bodyClientH: settled - chrome,
      bodyScrollH: PHONE_SHELL.bodyScrollH,
    });
    expect(again).toBeCloseTo(settled, 5);
  });

  test("…and it does not chase the 0.34s height transition", () => {
    // Mid-transition `sheetH` and `bodyClientH` are both partway there, and only
    // their difference is read, so every frame answers with the same target.
    const chrome = PHONE_SHELL.sheetH - PHONE_SHELL.bodyClientH;
    for (const sheetH of [PHONE_SHELL.sheetH, 400, 430, 459]) {
      expect(
        fittedPeekHeight({ ...PHONE_SHELL, sheetH, bodyClientH: sheetH - chrome }),
      ).toBeCloseTo(459, 0);
    }
  });

  test("42% is a floor: a stage that already fits does not shrink below it", () => {
    // Otherwise a short peek would collapse onto its own content and the sheet
    // would change size every time a suggestion row resolved.
    const short = { ...PHONE_SHELL, bodyScrollH: 120 };
    expect(fittedPeekHeight(short)).toBeCloseTo(PEEK_DETENT * 852, 5);
  });

  test("the full detent is the ceiling: a long stage scrolls, it does not take the screen", () => {
    const long = { ...PHONE_SHELL, bodyScrollH: 2000 };
    expect(fittedPeekHeight(long)).toBeCloseTo(FULL_DETENT * 852, 5);
    // The scrim behind the sheet stays reachable at every content length.
    expect(fittedPeekHeight(long)).toBeLessThan(852);
  });

  test("before layout it answers with the floor rather than a guess", () => {
    expect(fittedPeekHeight({ ...PHONE_SHELL, bodyClientH: 0, sheetH: 0 })).toBeCloseTo(
      PEEK_DETENT * 852,
      5,
    );
  });
});
