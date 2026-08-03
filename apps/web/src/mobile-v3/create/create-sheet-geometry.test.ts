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
