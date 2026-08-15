/**
 * An HTML export's one job is to survive leaving the machine that made it —
 * opened from a download folder, pasted into an email, viewed with no network.
 * Every way that fails is silent: a stylesheet that never loads just renders
 * as unstyled text on the recipient's screen.
 */

import { describe, expect, test } from "bun:test";

import JSZip from "jszip";

import {
  escapeHtml,
  renderMarkdownToHtmlDocument,
  zipFiles,
} from "../html-export.js";

const html = renderMarkdownToHtmlDocument(
  "# Title\n\nBody with **bold**.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
  { title: "My Report" },
);

describe("renderMarkdownToHtmlDocument", () => {
  test("is a complete document, not a fragment", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("</html>");
  });

  test("renders the markdown, including GFM tables", () => {
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
  });

  test("is self-contained — it must render with no network", () => {
    expect(html).not.toContain("@import");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  test("carries a title and a viewport so it opens sanely on a phone", () => {
    expect(html).toContain("<title>My Report</title>");
    expect(html).toContain('name="viewport"');
  });

  test("escapes the title rather than letting it break out of the tag", () => {
    const injected = renderMarkdownToHtmlDocument("hi", {
      title: "</title><script>alert(1)</script>",
    });
    expect(injected).not.toContain("<script>alert(1)</script>");
    expect(injected).toContain("&lt;script&gt;");
  });

  test("constrains the measure so long lines stay readable in a browser", () => {
    // The print template leaves page padding to the PDF margin; a browser view
    // needs its own or the text runs edge to edge.
    expect(html).toContain("max-width:760px");
  });
});

describe("escapeHtml", () => {
  test("escapes the four characters that can break out of markup", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
    );
  });
});

describe("zipFiles", () => {
  test("bundles text and binary entries under their given names", async () => {
    const zip = await zipFiles([
      { name: "report.html", content: "<p>hi</p>" },
      { name: "chart.png", content: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const read = await JSZip.loadAsync(zip);
    expect(Object.keys(read.files).sort()).toEqual([
      "chart.png",
      "report.html",
    ]);
    expect(await read.file("report.html")!.async("string")).toBe("<p>hi</p>");
    expect([...(await read.file("chart.png")!.async("uint8array"))]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test("refuses an empty bundle", () => {
    expect(zipFiles([])).rejects.toThrow(/Nothing to zip/);
  });
});
