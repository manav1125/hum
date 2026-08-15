/**
 * Notion is the one destination that rebuilds the document rather than
 * shipping it, so the conversion is the destination. These tests pin the
 * structure Notion's API actually requires — a wrong `type` key or a missing
 * `rich_text` array is a 400 at append time, not a rendering blemish.
 */

import { describe, expect, it } from "bun:test";

import {
  chunkNotionBlocks,
  markdownToNotionBlocks,
  NOTION_MAX_BLOCKS_PER_REQUEST,
} from "../markdown-to-notion-blocks.js";

type Block = Record<string, any>;

function convert(markdown: string): Block[] {
  return markdownToNotionBlocks(markdown) as Block[];
}

describe("markdownToNotionBlocks", () => {
  it("maps headings to Notion's three levels, clamping deeper ones", () => {
    const blocks = convert("# One\n\n## Two\n\n### Three\n\n#### Four\n");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "heading_2",
      "heading_3",
      "heading_3",
    ]);
    expect(blocks[0].heading_1.rich_text[0].text.content).toBe("One");
  });

  it("carries inline emphasis through as annotations", () => {
    const [block] = convert("Plain **bold** and *italic* and `code`.");
    const runs = block.paragraph.rich_text;
    const bold = runs.find((r: Block) => r.annotations?.bold);
    const italic = runs.find((r: Block) => r.annotations?.italic);
    const code = runs.find((r: Block) => r.annotations?.code);
    expect(bold.text.content).toBe("bold");
    expect(italic.text.content).toBe("italic");
    expect(code.text.content).toBe("code");
  });

  it("keeps link targets on the rich text", () => {
    const [block] = convert("See [the docs](https://example.com/x).");
    const link = block.paragraph.rich_text.find((r: Block) => r.text.link);
    expect(link.text.content).toBe("the docs");
    expect(link.text.link.url).toBe("https://example.com/x");
  });

  it("distinguishes bulleted, numbered and checklist items", () => {
    const bulleted = convert("- a\n- b\n");
    expect(bulleted.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
    ]);

    const numbered = convert("1. a\n2. b\n");
    expect(numbered.map((b) => b.type)).toEqual([
      "numbered_list_item",
      "numbered_list_item",
    ]);

    const tasks = convert("- [ ] todo\n- [x] done\n");
    expect(tasks.map((b) => b.type)).toEqual(["to_do", "to_do"]);
    expect(tasks[0].to_do.checked).toBe(false);
    expect(tasks[1].to_do.checked).toBe(true);
  });

  it("builds a table with a header row and uniform width", () => {
    const [table] = convert(
      "| Item | Price |\n| --- | --- |\n| Widget | $10 |\n| Gadget | $20 |\n",
    );
    expect(table.type).toBe("table");
    expect(table.table.table_width).toBe(2);
    expect(table.table.has_column_header).toBe(true);
    expect(table.table.children).toHaveLength(3);
    for (const row of table.table.children) {
      expect(row.type).toBe("table_row");
      expect(row.table_row.cells).toHaveLength(2);
    }
    expect(table.table.children[1].table_row.cells[0][0].text.content).toBe(
      "Widget",
    );
  });

  it("normalises code languages Notion does not know", () => {
    expect(convert("```ts\nlet a = 1;\n```\n")[0].code.language).toBe(
      "typescript",
    );
    expect(convert("```brainfuck\n+++\n```\n")[0].code.language).toBe(
      "plain text",
    );
    expect(convert("```\nbare\n```\n")[0].code.language).toBe("plain text");
  });

  it("maps quotes and rules to their Notion equivalents", () => {
    expect(convert("> quoted\n")[0].type).toBe("quote");
    expect(convert("---\n")[0].type).toBe("divider");
  });

  it("decodes HTML entities marked leaves escaped", () => {
    const [block] = convert("Fish & chips <tag>\n");
    const text = block.paragraph.rich_text
      .map((r: Block) => r.text.content)
      .join("");
    expect(text).toContain("&");
    expect(text).not.toContain("&amp;");
  });

  it("splits a run longer than Notion's 2000-character limit instead of truncating", () => {
    const long = "x".repeat(5000);
    const [block] = convert(`${long}\n`);
    const runs = block.paragraph.rich_text;
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.text.content.length).toBeLessThanOrEqual(2000);
    }
    expect(runs.map((r: Block) => r.text.content).join("")).toHaveLength(5000);
  });

  it("produces nothing for empty input", () => {
    expect(convert("")).toEqual([]);
    expect(convert("   \n\n  \n")).toEqual([]);
  });

  it("tags every block as a Notion block object", () => {
    for (const block of convert("# H\n\ntext\n\n- item\n\n> q\n\n---\n")) {
      expect(block.object).toBe("block");
      expect(block[block.type]).toBeDefined();
    }
  });
});

describe("chunkNotionBlocks", () => {
  it("splits at Notion's per-request ceiling", () => {
    const blocks = Array.from({ length: 250 }, (_, i) => ({ i }));
    const chunks = chunkNotionBlocks(blocks);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(NOTION_MAX_BLOCKS_PER_REQUEST).toBe(100);
  });

  it("leaves a short document as one batch, and an empty one as none", () => {
    expect(chunkNotionBlocks([{ a: 1 }])).toHaveLength(1);
    expect(chunkNotionBlocks([])).toHaveLength(0);
  });
});
