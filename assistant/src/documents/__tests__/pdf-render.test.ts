/**
 * The print template's constraints all fail *silently*: a font that isn't on
 * the container renders in whatever Chromium falls back to, a remote asset
 * becomes a blank box, a blurred shadow rasterizes into a grey slab. Nothing
 * throws, so the only signal is somebody opening the PDF. These assert the
 * preflight rules from
 * `config/bundled-skills/document-editor/references/DESIGNED_PDF.md`.
 */

import { describe, expect, test } from "bun:test";

import { wrapInPrintTemplate } from "../pdf-render.js";

const html = wrapInPrintTemplate("<p>body</p>");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const rootBlock = css.slice(
  css.indexOf(":root"),
  css.indexOf("}", css.indexOf(":root")),
);

describe("wrapInPrintTemplate", () => {
  test("embeds the rendered markdown verbatim", () => {
    expect(wrapInPrintTemplate("<p>hello &amp; welcome</p>")).toContain(
      "<p>hello &amp; welcome</p>",
    );
  });

  test("is self-contained — the renderer blocks the network", () => {
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("@import");
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain("url(");
  });

  test("every font stack ends in a generic family", () => {
    // The prod container installs only fonts-freefont-ttf, so a named face is
    // never load-bearing — the generic terminator is what actually resolves.
    const stacks = [...rootBlock.matchAll(/--(serif|sans|mono):([^;]+);/g)];
    expect(stacks.length).toBe(3);
    for (const [, name, value] of stacks) {
      const generic = { serif: "serif", sans: "sans-serif", mono: "monospace" }[
        name
      ];
      expect(value.trim().split(",").at(-1)?.trim()).toBe(generic);
    }
  });

  test("declares its colours once, as tokens", () => {
    expect(css.match(/:root/g)?.length).toBe(1);
    const outsideRoot = css.replace(rootBlock, "");
    expect(outsideRoot).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("prints backgrounds and borders rather than dropping them", () => {
    expect(css).toContain("print-color-adjust: exact");
    expect(css).toContain("-webkit-print-color-adjust: exact");
  });

  test("has no blurred box-shadow", () => {
    // Chromium rasterizes a blurred shadow into a flat grey slab in the PDF.
    expect(css).not.toContain("box-shadow");
  });

  test("pairs serif headings with the sans body and mono table headers", () => {
    expect(css).toMatch(/h1\s*{[^}]*font-family: var\(--serif\)/);
    expect(css).toMatch(/h2\s*{[^}]*font-family: var\(--serif\)/);
    expect(css).toMatch(/body\s*{[^}]*font-family: var\(--sans\)/);
    expect(css).toMatch(/thead th\s*{[^}]*font-family: var\(--mono\)/);
    // Right-aligned markdown columns are figure columns by convention.
    expect(css).toMatch(
      /td\[align="right"\]\s*{[^}]*font-family: var\(--mono\)/,
    );
  });

  test("keeps surfaces whole across a page break", () => {
    for (const selector of ["pre", "blockquote", "table", "tr", "img"]) {
      const rule = css.match(new RegExp(`\\n  ${selector} ?{[^}]*}`));
      expect(rule?.[0]).toContain("break-inside: avoid");
    }
  });
});
