/**
 * The promise this exporter makes is that the .pptx is *editable* — the client
 * opens it in PowerPoint, clicks into a bullet and retypes it — and that it is
 * *not* a stack of screenshots. Both failures open perfectly well and only look
 * wrong (or, worse, look right until someone tries to fix a typo). So these
 * assertions read the actual OOXML out of the package rather than trusting the
 * builder, and one of them checks the negative: that no slide contains a
 * picture.
 */

import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import {
  dedupeParagraphProps,
  renderMarkdownToPptx,
  wrappedLineCount,
} from "../pptx-render.js";

const MARKDOWN = `# Proposal

A proposal for **Acme Trading LLC** with *emphasis* and \`code\`.

## Pricing

- first bullet
- second bullet
  - nested bullet

1. step one
2. step two

| Item | Qty | Total |
| --- | ---: | ---: |
| Implementation | 1 | $12,000.00 |
| Seats | 25 | $12,000.00 |

> Prices exclude VAT.

Contact [Manav Gupta](mailto:manav@brinc.io).
`;

/** 16:9 at 10" wide, less the 0.55" side margins, in EMU. */
const CONTENT_W_EMU = Math.round((10 - 2 * 0.55) * 914400);

async function slideXml(markdown: string, opts = {}): Promise<string[]> {
  const deck = await renderMarkdownToPptx(markdown, opts);
  const zip = await JSZip.loadAsync(deck.bytes);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return Promise.all(names.map((n) => zip.file(n)!.async("string")));
}

describe("renderMarkdownToPptx", () => {
  test("produces a readable OOXML package, not an opaque blob", async () => {
    const deck = await renderMarkdownToPptx(MARKDOWN);
    // A .pptx is a zip: `PK\x03\x04`. Anything else means PowerPoint errors.
    expect(deck.bytes.subarray(0, 2).toString("binary")).toBe("PK");

    const zip = await JSZip.loadAsync(deck.bytes);
    for (const entry of [
      "[Content_Types].xml",
      "ppt/presentation.xml",
      "ppt/slides/slide1.xml",
      "ppt/slideMasters/slideMaster1.xml",
    ]) {
      expect(zip.file(entry)).not.toBeNull();
    }
  });

  test("refuses empty content rather than emitting a blank deck", () => {
    expect(renderMarkdownToPptx("   ")).rejects.toThrow(/empty/i);
  });

  test("is 16:9", async () => {
    const deck = await renderMarkdownToPptx(MARKDOWN);
    const zip = await JSZip.loadAsync(deck.bytes);
    const xml = await zip.file("ppt/presentation.xml")!.async("string");
    // 10" x 5.625" in EMU.
    expect(xml).toContain('cx="9144000" cy="5143500"');
  });

  test("puts every word on the slide as an editable text run", async () => {
    const slides = await slideXml(MARKDOWN);
    const text = slides.join("");
    for (const phrase of [
      "Proposal",
      "Acme Trading LLC",
      "first bullet",
      "nested bullet",
      "step one",
      "Implementation",
      "Prices exclude VAT.",
    ]) {
      expect(text).toContain(`>${phrase}<`);
    }
  });

  test("contains no pictures — this export is not screenshots of slides", async () => {
    // The whole reason the structural path exists. An image-bearing slide would
    // open fine and be uneditable, which is the outcome worth failing a build
    // over.
    const slides = await slideXml(MARKDOWN);
    for (const xml of slides) {
      expect(xml).not.toContain("<p:pic>");
      expect(xml).not.toContain("<a:blip");
    }
  });

  test("starts a new slide at each h1/h2 and carries the heading as the title", async () => {
    const deck = await renderMarkdownToPptx(MARKDOWN);
    // Pricing runs onto continuation slides because its table takes one of its
    // own; the titles are what prove the headings drove the slide breaks.
    expect(deck.slideTitles[0]).toBe("Proposal");
    expect(new Set(deck.slideTitles.slice(1))).toEqual(
      new Set(["Pricing", "Pricing (cont.)"]),
    );
  });

  test("keeps h3 and deeper inside the body instead of fragmenting the deck", async () => {
    const deck = await renderMarkdownToPptx(
      "## Scope\n\n### Assumptions\n\nText.",
    );
    expect(deck.slideTitles).toEqual(["Scope"]);
    const [xml] = await slideXml("## Scope\n\n### Assumptions\n\nText.");
    expect(xml).toContain(">Assumptions<");
  });

  test("writes native bullet and number lists, with nesting as an indent level", async () => {
    const slides = await slideXml(MARKDOWN);
    const xml = slides.join("");
    // Both must exist: an ordered list rendered as bullets loses the sequence
    // the author relied on.
    expect(xml).toContain("<a:buChar");
    expect(xml).toContain('<a:buAutoNum type="arabicPeriod"');
    // Nesting survives as a level rather than being flattened.
    expect(xml).toContain('lvl="1"');
  });

  test("writes a real table grid, sized to the content column", async () => {
    const slides = await slideXml(MARKDOWN);
    const grid =
      slides.join("").match(/<a:tblGrid>[\s\S]*?<\/a:tblGrid>/)?.[0] ?? "";
    const widths = [...grid.matchAll(/w="(\d+)"/g)].map((m) => Number(m[1]));

    expect(widths).toHaveLength(3);
    for (const w of widths) expect(w).toBeGreaterThan(300000); // > 0.33"
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(CONTENT_W_EMU, -3);
  });

  test("keeps the markdown column alignment on the table cells", async () => {
    const xml = (await slideXml(MARKDOWN)).join("");
    expect(xml).toContain('algn="r"');
  });

  test("carries bold and italic through as run properties", async () => {
    const xml = (await slideXml(MARKDOWN)).join("");
    expect(xml).toMatch(/b="1"[\s\S]{0,400}>Acme Trading LLC</);
    expect(xml).toMatch(/i="1"[\s\S]{0,400}>emphasis</);
    expect(xml).toMatch(/Courier New[\s\S]{0,400}>code</);
  });

  test("writes exactly one paragraph-properties element per paragraph", async () => {
    // pptxgenjs emits one in front of every run, so a paragraph mixing bold and
    // plain text comes out with two or three. ECMA-376 allows one, first — and
    // PowerPoint offers to "repair" the file when it finds more.
    const slides = await slideXml(MARKDOWN);
    for (const xml of slides) {
      for (const paragraph of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
        expect(
          (paragraph.match(/<a:pPr[\s/>]/g) ?? []).length,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test("registers an external link as a relationship and leaves a relative one as text", async () => {
    const deck = await renderMarkdownToPptx(MARKDOWN);
    const zip = await JSZip.loadAsync(deck.bytes);
    const parts = await Promise.all(
      Object.keys(zip.files)
        .filter((n) =>
          /^ppt\/slides\/(_rels\/)?slide\d+\.xml(\.rels)?$/.test(n),
        )
        .map((n) => zip.file(n)!.async("string")),
    );
    const all = parts.join("");
    expect(all).toContain("<a:hlinkClick");
    expect(all).toContain("mailto:manav@brinc.io");
    expect(all).toContain('TargetMode="External"');

    const [relative] = await slideXml("See [the docs](../guide.md).");
    expect(relative).toContain("the docs");
    expect(relative).not.toContain("<a:hlinkClick");
  });

  test("names an image it cannot embed instead of dropping it", async () => {
    // The renderer has no network, so a remote image can't be fetched — but a
    // silently missing figure is worse than a labelled gap.
    const [xml] = await slideXml("![Org chart](https://example.com/a.png)");
    expect(xml).toContain("[image: Org chart]");
  });

  test("decodes the entities marked leaves escaped for HTML output", async () => {
    const [xml] = await slideXml("Terms & conditions for <Acme>.");
    expect(xml).toContain(">Terms &amp; conditions for <");
    expect(xml).toContain(">&lt;Acme&gt;<");
  });

  test("adds a title slide only when the content doesn't already open with one", async () => {
    const own = await renderMarkdownToPptx(MARKDOWN, { title: "Proposal" });
    // The h1 is the first slide; no second "Proposal" is prepended.
    expect(own.slideTitles.filter((t) => t === "Proposal")).toHaveLength(1);

    const without = await renderMarkdownToPptx("Just a paragraph.", {
      title: "Proposal",
    });
    expect(without.slideTitles[0]).toBe("Proposal");
    expect(without.slideCount).toBe(2);
  });

  test("treats a horizontal rule as an explicit slide break, but not a trailing one", async () => {
    const split = await renderMarkdownToPptx(
      "## Scope\n\nBefore.\n\n---\n\nAfter.",
    );
    expect(split.slideCount).toBe(2);
    expect(split.slideTitles).toEqual(["Scope", "Scope"]);

    // A rule at the end is punctuation, not a request for a blank slide.
    const trailing = await renderMarkdownToPptx("## Scope\n\nBefore.\n\n---\n");
    expect(trailing.slideCount).toBe(1);
  });
});

describe("overflow", () => {
  const bullet =
    "A long line of body copy that wraps at least twice on a 16:9 slide because it keeps going well past the width of the content column and then some.";

  test("splits a long section across slides instead of running off the canvas", async () => {
    const markdown = `## Scope\n${Array.from({ length: 20 }, () => `- ${bullet}`).join("\n")}`;
    const deck = await renderMarkdownToPptx(markdown);

    expect(deck.slideCount).toBeGreaterThan(1);
    // Continuation slides say so, so the reader knows the list didn't restart.
    expect(deck.slideTitles[0]).toBe("Scope");
    expect(deck.slideTitles[1]).toBe("Scope (cont.)");

    // Nothing is lost in the split: every bullet is still in the package.
    const text = (await slideXml(markdown)).join("");
    expect((text.match(/A long line of body copy/g) ?? []).length).toBe(20);
  });

  test("splits one over-long paragraph on word boundaries rather than clipping it", async () => {
    const paragraph = `${bullet} `.repeat(30).trim();
    const deck = await renderMarkdownToPptx(`## Scope\n\n${paragraph}`);
    expect(deck.slideCount).toBeGreaterThan(1);

    const text = (await slideXml(`## Scope\n\n${paragraph}`)).join("");
    // Words survive the cut — the split never lands inside one.
    expect(text).not.toMatch(
      />[a-z]+<\/a:t><\/a:r>[\s\S]{0,80}<a:t>[a-z]{1,3} /,
    );
    expect((text.match(/because it keeps going/g) ?? []).length).toBe(30);
  });

  test("splits a long table and repeats the header row on every slide", async () => {
    const rows = Array.from(
      { length: 40 },
      (_, i) => `| Line item number ${i + 1} | ${i + 1} | $${i + 1},000.00 |`,
    ).join("\n");
    const markdown = `## Pricing\n\n| Item | Qty | Total |\n| --- | ---: | ---: |\n${rows}`;
    const deck = await renderMarkdownToPptx(markdown);
    expect(deck.slideCount).toBeGreaterThan(1);

    const slides = await slideXml(markdown);
    const withTable = slides.filter((xml) => xml.includes("<a:tbl>"));
    expect(withTable.length).toBeGreaterThan(1);
    // A continuation table with no header is a column of unlabelled numbers.
    for (const xml of withTable) expect(xml).toContain(">Qty<");
  });

  test("a table slide never also carries body text, so nothing can overlap it", async () => {
    // Text height is estimated; a table is positioned absolutely. Keeping them
    // on separate slides is what makes the geometry exact rather than close.
    const markdown = `## Pricing\n\nLead-in sentence.\n\n| Item | Qty |\n| --- | --- |\n| A | 1 |`;
    const slides = await slideXml(markdown);
    for (const xml of slides) {
      if (!xml.includes("<a:tbl>")) continue;
      expect(xml).not.toContain(">Lead-in sentence.<");
    }
  });
});

describe("wrappedLineCount", () => {
  test("wraps on word boundaries rather than dividing by length", () => {
    // 20 characters in a 12-wide column. Dividing length by width says two
    // lines; the words only fit one per line, so it is really three, and the
    // paragraph would have been measured at two thirds of its height.
    expect(wrappedLineCount("aaaaaa bbbbbb cccccc", 12)).toBe(3);
    // Widen the column by one and two of them share a line.
    expect(wrappedLineCount("aaaaaa bbbbbb cccccc", 13)).toBe(2);
    expect(wrappedLineCount("short", 40)).toBe(1);
    expect(wrappedLineCount("", 40)).toBe(1);
  });

  test("counts a single unbreakable token wider than the column", () => {
    expect(wrappedLineCount("x".repeat(95), 40)).toBe(3);
  });
});

describe("dedupeParagraphProps", () => {
  test("keeps the first properties element and drops the strays", () => {
    const xml =
      "<a:p><a:pPr><a:buChar/></a:pPr><a:r><a:t>a</a:t></a:r>" +
      '<a:pPr indent="0"><a:buNone/></a:pPr><a:r><a:t>b</a:t></a:r></a:p>';
    const out = dedupeParagraphProps(xml);
    expect((out.match(/<a:pPr/g) ?? []).length).toBe(1);
    expect(out).toContain("<a:buChar/>");
    expect(out).toContain("<a:t>a</a:t>");
    expect(out).toContain("<a:t>b</a:t>");
  });

  test("treats each paragraph independently", () => {
    const xml = "<a:p><a:pPr/><a:r/></a:p><a:p><a:pPr/><a:r/></a:p>";
    expect((dedupeParagraphProps(xml).match(/<a:pPr/g) ?? []).length).toBe(2);
  });
});
