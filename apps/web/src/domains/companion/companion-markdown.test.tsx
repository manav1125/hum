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

import {
  renderCompanionMarkdown,
  toCompanionBlocks,
} from "./companion-markdown";

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

/**
 * Structure, not just punctuation.
 *
 * Answers routinely come back as lists, and a list drawn as run-on prose with
 * stray hyphens is harder to read than the paragraph it was trying not to be.
 */
describe("toCompanionBlocks", () => {
  test("consecutive bullets are one list", () => {
    const blocks = toCompanionBlocks("- one\n- two\n- three");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "ul", items: ["one", "two", "three"] });
  });

  test("a numbered list keeps where it started", () => {
    // Restarting at 1 would renumber the answer, which changes what it said.
    const blocks = toCompanionBlocks("3. third\n4. fourth");
    expect(blocks[0]).toEqual({
      kind: "ol",
      items: ["third", "fourth"],
      start: 3,
    });
  });

  test("headings are their own block", () => {
    expect(toCompanionBlocks("## Today\nrain")).toEqual([
      { kind: "h", level: 2, text: "Today" },
      { kind: "p", lines: ["rain"] },
    ]);
  });

  test("a blank line separates paragraphs; a single newline does not", () => {
    expect(toCompanionBlocks("one\ntwo\n\nthree")).toEqual([
      { kind: "p", lines: ["one", "two"] },
      { kind: "p", lines: ["three"] },
    ]);
  });

  test("REGRESSION: a hyphen mid-sentence is not a bullet", () => {
    // "Mostly cloudy — high 30" and "- high 30" must not be the same thing.
    const blocks = toCompanionBlocks("Mostly cloudy - high 30");
    expect(blocks[0]!.kind).toBe("p");
  });
});

describe("lists and links, drawn", () => {
  test("bullets render one per line with a marker", () => {
    const { container } = draw("- one\n- two");
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("two");
    expect(container.textContent).toContain("•");
  });

  test("a link is a button when there is somewhere to open it", () => {
    const opened: string[] = [];
    const { container } = render(
      <p>
        {renderCompanionMarkdown("see [docs](https://example.com/d)", (href) =>
          opened.push(href),
        )}
      </p>,
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("docs");
    button?.click();
    expect(opened).toEqual(["https://example.com/d"]);
  });

  test("and stays plain text when there is not", () => {
    // No opener means no navigation is possible, and a link that looks
    // clickable but is not is the failure this surface keeps being caught by.
    const { container } = draw("see [docs](https://example.com/d)");
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("see docs");
  });
});
