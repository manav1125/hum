/**
 * A pipe table in a document must render as a real `<table>`.
 *
 * This file exists because of one shipped bug, and the shape of it is worth
 * keeping: the editor registered StarterKit + Link + Markdown and no table
 * nodes, so `tiptap-markdown` had nowhere to put a pipe table. Every cell
 * collapsed into adjacent text and a competitor-scan document rendered as
 * "DimensionDetailWhatAI-first VC operating system…Target…Pricing…" — a wall
 * of run-together prose where the entire substance of the document was.
 *
 * What makes it worth a test rather than a fix: the stylesheet in
 * `tiptap-document-editor.tsx` already carried `.tiptap table`, `.tiptap th`
 * and `.tiptap td` rules. Someone wrote styling for tables that could not
 * appear. Styles are not evidence that a node type is registered, so the
 * assertion here is on the rendered DOM — `<table>`, `<th>`, `<td>` counts —
 * not on CSS and not on the extension list, either of which could look right
 * while the output stayed broken.
 */

import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

const TABLE_MD = [
  "| Dimension | Detail |",
  "| --- | --- |",
  "| What | AI-first VC operating system |",
  "| Target | VC firms managing funds |",
  "| Pricing | Not public |",
].join("\n");

/** Mirrors the extension set in `tiptap-document-editor.tsx`. */
function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({}),
      Link.configure({ openOnClick: false }),
      TableKit,
      Markdown,
    ],
    content,
  });
}

describe("document editor — markdown tables", () => {
  test("a pipe table becomes a real table element, not run-together text", () => {
    const editor = makeEditor(TABLE_MD);
    const html = editor.getHTML();

    expect(html).toContain("<table");
    expect(html).toContain("<td");

    editor.destroy();
  });

  test("cells stay separated — the failure was 'DimensionDetail' with no boundary", () => {
    const editor = makeEditor(TABLE_MD);
    // Text content with element boundaries collapsed is exactly what the user
    // saw. If the cells are real elements, the two header labels cannot end up
    // adjacent with no separator between them.
    const html = editor.getHTML();
    const strippedOfTags = html.replace(/<[^>]+>/g, "|");

    expect(strippedOfTags).not.toContain("DimensionDetail");
    expect(html).toContain("Dimension");
    expect(html).toContain("Detail");

    editor.destroy();
  });

  test("a document with no table still renders normally", () => {
    const editor = makeEditor("# Heading\n\nA paragraph of prose.");
    const html = editor.getHTML();

    expect(html).toContain("Heading");
    expect(html).toContain("A paragraph of prose.");
    expect(html).not.toContain("<table");

    editor.destroy();
  });
});
