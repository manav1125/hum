/**
 * Markdown → Word (.docx) rendering.
 *
 * The point of this export is that the result is *editable*: a client opens it
 * in Word, turns on track changes, and redlines the proposal. So this maps the
 * markdown tree onto real Word constructs — heading styles, list numbering,
 * table grids, character runs — rather than doing the easy thing and pasting a
 * picture of the page into a document.
 *
 * Consequences of that choice, stated once here rather than repeated below:
 *
 * - Styling is Word's, not the print template's. Headings use the built-in
 *   `Heading N` styles so the client's own theme and navigation pane work, and
 *   so their house template can restyle the whole file in one action.
 * - Anything markdown can't express in Word (raw HTML blocks, images referenced
 *   by URL) degrades to plain text rather than being dropped silently — a
 *   missing clause in a contract draft is worse than an ugly one.
 */

import {
  AlignmentType,
  BorderStyle,
  convertInchesToTwip,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Token, Tokens } from "marked";
import { marked } from "marked";

const FONT_BODY = "Calibri";
const FONT_MONO = "Consolas";

/** Word measures in twips (1/20 pt); these are the numbers we reuse. */
const PT = 20;

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** The numbering reference every ordered list in the document shares. */
const ORDERED_REF = "cue-ordered";

/** A4 portrait, in twips — the page every export uses. */
const PAGE_WIDTH = 11906;

/** Text column width at the default 1" margins; tables are sized against it. */
const DEFAULT_CONTENT_WIDTH = PAGE_WIDTH - 2 * convertInchesToTwip(1);

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Carries Word's built-in `Hyperlink` character style onto the run. */
  link?: boolean;
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

/**
 * Flatten marked's inline token tree into Word character runs, carrying
 * bold/italic/strike/code down through nesting so `**bold _and italic_**`
 * survives the trip.
 */
function inlineRuns(
  tokens: Token[] | undefined,
  style: RunStyle = {},
): (TextRun | ExternalHyperlink)[] {
  if (!tokens?.length) return [];
  const out: (TextRun | ExternalHyperlink)[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(
          ...inlineRuns((token as Tokens.Strong).tokens, {
            ...style,
            bold: true,
          }),
        );
        break;
      case "em":
        out.push(
          ...inlineRuns((token as Tokens.Em).tokens, {
            ...style,
            italics: true,
          }),
        );
        break;
      case "del":
        out.push(
          ...inlineRuns((token as Tokens.Del).tokens, {
            ...style,
            strike: true,
          }),
        );
        break;
      case "codespan":
        out.push(
          run(decode((token as Tokens.Codespan).text), {
            ...style,
            code: true,
          }),
        );
        break;
      case "br":
        out.push(new TextRun({ break: 1 }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        // A relative or unrecognised href is worth more as plain text than as
        // a dead link the reader clicks and blames on us.
        const external = /^(https?:|mailto:)/i.test(link.href ?? "");
        const nested = inlineRuns(link.tokens, { ...style, link: external });
        const runs = nested.length
          ? nested
          : [run(decode(link.text), { ...style, link: external })];
        if (external) {
          out.push(new ExternalHyperlink({ link: link.href, children: runs }));
        } else {
          out.push(...runs);
        }
        break;
      }
      case "image":
        // No network during render, so a remote image can't be embedded.
        // Name it instead of dropping it.
        out.push(
          run(
            `[image: ${decode((token as Tokens.Image).text || (token as Tokens.Image).href)}]`,
            {
              ...style,
              italics: true,
            },
          ),
        );
        break;
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, style));
        else out.push(run(decode(t.text), style));
        break;
      }
      case "html":
        out.push(run(decode((token as Tokens.HTML).raw), style));
        break;
      case "escape":
        out.push(run(decode((token as Tokens.Escape).text), style));
        break;
      default: {
        const raw =
          (token as { text?: string; raw?: string }).text ??
          (token as { raw?: string }).raw ??
          "";
        if (raw) out.push(run(decode(raw), style));
      }
    }
  }
  return out;
}

function runOptions(text: string, style: RunStyle) {
  return {
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    font: style.code ? FONT_MONO : FONT_BODY,
    ...(style.code
      ? { shading: { type: ShadingType.CLEAR, fill: "F2F4F8" } }
      : {}),
    ...(style.link ? { style: "Hyperlink" } : {}),
  };
}

function run(text: string, style: RunStyle): TextRun {
  return new TextRun(runOptions(text, style));
}

/**
 * marked leaves HTML entities escaped in token text (it emits HTML, after all).
 * Word wants the characters.
 */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Block elements
// ---------------------------------------------------------------------------

function blockToParagraphs(
  token: Token,
  depth = 0,
  contentWidth = DEFAULT_CONTENT_WIDTH,
): (Paragraph | Table)[] {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      return [
        new Paragraph({
          heading: HEADING_LEVELS[Math.min(h.depth, 6) - 1],
          children: inlineRuns(h.tokens),
          spacing: { before: 12 * PT, after: 6 * PT },
          keepNext: true,
        }),
      ];
    }

    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return [
        new Paragraph({
          children: inlineRuns(p.tokens),
          spacing: { after: 8 * PT, line: 276 },
        }),
      ];
    }

    case "list": {
      const list = token as Tokens.List;
      const out: (Paragraph | Table)[] = [];
      for (const item of list.items) {
        out.push(
          ...listItemParagraphs(item, list.ordered, depth, contentWidth),
        );
      }
      return out;
    }

    case "table":
      return [tableOf(token as Tokens.Table, contentWidth)];

    case "code": {
      const c = token as Tokens.Code;
      // One paragraph per line: Word has no <pre>, and a single run with
      // embedded breaks loses the shading on the empty lines.
      return c.text.split("\n").map(
        (line, i, all) =>
          new Paragraph({
            children: [new TextRun({ text: line, font: FONT_MONO, size: 18 })],
            shading: { type: ShadingType.CLEAR, fill: "F6F8FA" },
            spacing: {
              before: i === 0 ? 8 * PT : 0,
              after: i === all.length - 1 ? 8 * PT : 0,
            },
            indent: { left: convertInchesToTwip(0.15) },
          }),
      );
    }

    case "blockquote": {
      const q = token as Tokens.Blockquote;
      return q.tokens.flatMap((child) =>
        blockToParagraphs(child, depth, contentWidth).map((block) =>
          block instanceof Paragraph
            ? new Paragraph({
                children: inlineRunsOfBlock(child),
                indent: { left: convertInchesToTwip(0.3) },
                border: {
                  left: {
                    style: BorderStyle.SINGLE,
                    size: 12,
                    color: "3D6EE8",
                    space: 8,
                  },
                },
                spacing: { after: 8 * PT },
              })
            : block,
        ),
      );
    }

    case "hr":
      return [
        new Paragraph({
          text: "",
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: "D9DEE8",
              space: 1,
            },
          },
          spacing: { before: 8 * PT, after: 12 * PT },
        }),
      ];

    case "html": {
      const raw = (token as Tokens.HTML).raw.trim();
      if (!raw) return [];
      return [
        new Paragraph({
          children: [run(decode(raw.replace(/<[^>]+>/g, " ").trim()), {})],
          spacing: { after: 8 * PT },
        }),
      ];
    }

    case "space":
      return [];

    default: {
      const text = (token as { text?: string }).text;
      return text
        ? [
            new Paragraph({
              children: [run(decode(text), {})],
              spacing: { after: 8 * PT },
            }),
          ]
        : [];
    }
  }
}

/** Best-effort inline runs for an arbitrary block (used inside blockquotes). */
function inlineRunsOfBlock(token: Token): (TextRun | ExternalHyperlink)[] {
  const withTokens = token as { tokens?: Token[]; text?: string };
  if (withTokens.tokens?.length) return inlineRuns(withTokens.tokens);
  return withTokens.text ? [run(decode(withTokens.text), {})] : [];
}

function listItemParagraphs(
  item: Tokens.ListItem,
  ordered: boolean,
  depth: number,
  contentWidth: number,
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const level = Math.min(depth, 4);

  // The item's own text is whatever isn't a nested block.
  const inline = item.tokens.filter(
    (t) => t.type === "text" || t.type === "paragraph",
  );
  const nested = item.tokens.filter((t) => t.type === "list");
  const other = item.tokens.filter(
    (t) => !["text", "paragraph", "list", "space"].includes(t.type),
  );

  const children = inline.flatMap((t) =>
    inlineRuns((t as Tokens.Text | Tokens.Paragraph).tokens),
  );

  // GFM task list items keep their checkbox — it carries meaning in a
  // checklist deliverable.
  const prefix = item.task ? [run(item.checked ? "☒ " : "☐ ", {})] : [];

  out.push(
    new Paragraph({
      children: [
        ...prefix,
        ...(children.length ? children : [run(decode(item.text), {})]),
      ],
      ...(ordered
        ? { numbering: { reference: ORDERED_REF, level } }
        : { bullet: { level } }),
      spacing: { after: 4 * PT },
    }),
  );

  for (const child of nested) {
    out.push(...blockToParagraphs(child, depth + 1, contentWidth));
  }
  for (const child of other) {
    out.push(...blockToParagraphs(child, depth, contentWidth));
  }
  return out;
}

/**
 * Column widths, in twips, apportioned by how much text each column carries.
 *
 * A table with no explicit grid is the single worst-looking thing this exporter
 * can emit: OOXML's default `gridCol` is 100 twips (~0.07"), and a renderer
 * that honours the grid instead of auto-fitting squeezes every column into a
 * one-character ribbon. Word itself usually recovers; Quick Look and Pages do
 * not. So the grid is always written.
 */
function columnWidths(token: Tokens.Table, contentWidth: number): number[] {
  const columns = token.header.length;
  if (columns === 0) return [];

  const weights = token.header.map((cell, i) => {
    const longest = Math.max(
      cell.text.length,
      ...token.rows.map((row) => row[i]?.text.length ?? 0),
    );
    // Clamp so one long prose cell can't starve the numeric columns, and an
    // empty column still gets something to hold its border.
    return Math.min(40, Math.max(6, longest));
  });

  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((contentWidth * w) / total));
  // Give the rounding remainder to the widest column so the row fills the page.
  const widest = widths.indexOf(Math.max(...widths));
  widths[widest] += contentWidth - widths.reduce((a, b) => a + b, 0);
  return widths;
}

function tableOf(token: Tokens.Table, contentWidth: number): Table {
  const align = token.align ?? [];
  const alignmentAt = (i: number) =>
    align[i] === "right"
      ? AlignmentType.RIGHT
      : align[i] === "center"
        ? AlignmentType.CENTER
        : AlignmentType.LEFT;

  const widths = columnWidths(token, contentWidth);
  const cellWidth = (i: number) => ({
    size: widths[i] ?? Math.floor(contentWidth / Math.max(1, widths.length)),
    type: WidthType.DXA,
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: token.header.map(
      (cell, i) =>
        new TableCell({
          width: cellWidth(i),
          shading: { type: ShadingType.CLEAR, fill: "EEF1F7" },
          margins: cellMargins(),
          children: [
            new Paragraph({
              alignment: alignmentAt(i),
              children: inlineRuns(cell.tokens, { bold: true }),
            }),
          ],
        }),
    ),
  });

  const bodyRows = token.rows.map(
    (row) =>
      new TableRow({
        children: token.header.map((_, i) => {
          const cell = row[i];
          return new TableCell({
            width: cellWidth(i),
            margins: cellMargins(),
            children: [
              new Paragraph({
                alignment: alignmentAt(i),
                children: cell ? inlineRuns(cell.tokens) : [],
              }),
            ],
          });
        }),
      }),
  );

  return new Table({
    columnWidths: widths,
    width: { size: contentWidth, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    rows: [headerRow, ...bodyRows],
  });
}

function cellMargins() {
  return {
    top: 60,
    bottom: 60,
    left: 100,
    right: 100,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DocxOptions {
  /** Printed as a Title-styled heading above the content. */
  title?: string;
  /** Page margin in inches. Default 1 — the Word convention. */
  marginIn?: number;
}

/**
 * Convert a markdown string into a Word document buffer with live, editable
 * text. Throws only if the markdown is empty; anything it can't map degrades
 * to plain text.
 */
export async function renderMarkdownToDocx(
  markdown: string,
  opts: DocxOptions = {},
): Promise<Buffer> {
  if (!markdown.trim())
    throw new Error("Nothing to export — the content is empty.");

  const margin = convertInchesToTwip(opts.marginIn ?? 1);
  const contentWidth = Math.max(2000, PAGE_WIDTH - 2 * margin);

  const tokens = marked.lexer(markdown, { gfm: true });
  const body: (Paragraph | Table)[] = tokens.flatMap((t) =>
    blockToParagraphs(t, 0, contentWidth),
  );

  // A title is only prepended when the content doesn't already open with an
  // h1 — otherwise every exported document gets its name twice.
  const opensWithH1 =
    tokens.find((t) => t.type !== "space")?.type === "heading" &&
    (tokens.find((t) => t.type !== "space") as Tokens.Heading).depth === 1;
  const heading =
    opts.title && !opensWithH1
      ? [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: opts.title, font: FONT_BODY })],
            spacing: { after: 12 * PT },
          }),
        ]
      : [];

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT_BODY, size: 22 } },
      },
    },
    numbering: {
      config: [
        {
          reference: ORDERED_REF,
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format:
              level % 2 === 0 ? LevelFormat.DECIMAL : LevelFormat.LOWER_LETTER,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: {
              paragraph: {
                indent: {
                  left: convertInchesToTwip(0.4 * (level + 1)),
                  hanging: convertInchesToTwip(0.25),
                },
              },
            },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: margin,
              bottom: margin,
              left: margin,
              right: margin,
            },
          },
        },
        children: [...heading, ...body],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
