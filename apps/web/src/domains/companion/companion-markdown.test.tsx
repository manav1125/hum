/**
 * What the card does with a real answer's punctuation.
 *
 * It used to draw the raw output, so `**Hong Kong**` arrived with its
 * asterisks and a link arrived as its whole address. These are the forms real
 * answers actually use inline.
 */

import { describe, expect, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "bun:test";

import { renderCompanionMarkdown } from "./companion-markdown";

afterEach(cleanup);

const draw = (text: string) => render(<p>{renderCompanionMarkdown(text)}</p>);

describe("renderCompanionMarkdown", () => {
  test("bold loses its asterisks and gains its weight", () => {
    const { container } = draw("**Hong Kong** — Sunday");
    expect(container.querySelector("strong")?.textContent).toBe("Hong Kong");
    expect(container.textContent).toBe("Hong Kong — Sunday");
  });

  test("a link shows its label, not its address", () => {
    const { container } = draw("per the [Hong Kong Observatory](https://example.com/x?a=1)");
    expect(container.textContent).toBe("per the Hong Kong Observatory");
    // The address is still reachable, just not shouted.
    expect(container.querySelector("span[title]")?.getAttribute("title")).toBe(
      "https://example.com/x?a=1",
    );
  });

  test("REGRESSION: emphasis inside a link label does not eat the link", () => {
    // Ordering matters: a bold rule that ran first would split the label from
    // its address and leave the URL on screen.
    const { container } = draw("[**Climate Data**](https://example.com/c)");
    expect(container.textContent).toBe("**Climate Data**");
    expect(container.querySelector("span[title]")).not.toBeNull();
  });

  test("code keeps its contents verbatim, asterisks and all", () => {
    const { container } = draw("run `a * b` now");
    expect(container.querySelector("code")?.textContent).toBe("a * b");
    expect(container.textContent).toBe("run a * b now");
  });

  test("italic, single asterisk and underscore", () => {
    expect(draw("*soon*").container.querySelector("em")?.textContent).toBe("soon");
    cleanup();
    expect(draw("_soon_").container.querySelector("em")?.textContent).toBe("soon");
  });

  test("unmatched punctuation is left exactly as it came", () => {
    // Half a bold marker is not emphasis, and silently deleting it would
    // change what the answer said.
    expect(draw("2 ** 3 is 8").container.textContent).toBe("2 ** 3 is 8");
  });

  test("a mid-word underscore pair still reads as emphasis", () => {
    // Documented, not ideal: `a_b_c_d` italicises `b`. Markdown-lite behaviour,
    // and the alternative — word-boundary rules — is a parser, which is the
    // thing this file exists to avoid. Named here so it is a decision rather
    // than a surprise.
    expect(draw("a_b_c_d").container.textContent).toBe("abc_d");
  });

  test("paragraphs and line breaks survive", () => {
    const { container } = draw("one\ntwo\n\nthree");
    expect(container.textContent).toBe("onetwothree");
    // Three lines drawn as blocks, not one run-on.
    expect(container.querySelectorAll("span").length).toBeGreaterThanOrEqual(3);
  });

  test("an empty link label falls back to the address", () => {
    expect(draw("[](https://example.com/z)").container.textContent).toBe(
      "https://example.com/z",
    );
  });
});
