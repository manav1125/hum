/**
 * Markdown → PowerPoint (.pptx) rendering.
 *
 * This is the structural export, the sibling of `docx-render.ts`: headings
 * become slide titles, lists become native bullet lists, tables become native
 * pptx table grids, and every word of it is a real text run the recipient can
 * click into and retype. It is *not* a picture of a designed deck.
 *
 * That distinction is the whole reason this module is shaped the way it is.
 * There is no honest path from arbitrary CSS layout to editable shapes — the
 * only way to make a designed HTML deck "a pptx" is to screenshot each slide
 * and paste the image onto a blank one, which produces a file that looks like
 * a real export right up until someone tries to fix a typo. A designed deck
 * therefore stays a PDF (`deck_export_pdf`), and this path takes structure in
 * and gives editable slides back.
 *
 * Consequences of that choice, stated once here:
 *
 * - Styling is PowerPoint's, not a print template's. A plain title/body layout
 *   means the recipient's own theme, outline view and "Reset Slide" all work.
 * - Overflow is handled by *measuring and splitting*, never by letting content
 *   run off the canvas. See `paginate` — an overflowing slide is the single
 *   most common failure of generated decks. A table too wide for the canvas is
 *   split the other way too, by column; see `planTable`.
 * - Anything markdown can express but a slide cannot (a remote image) degrades
 *   to labelled text rather than vanishing.
 */

import JSZip from "jszip";
import type { Token, Tokens } from "marked";
import { marked } from "marked";
import pptxgen from "pptxgenjs";

import type { ApportionOptions, ColumnText } from "./table-columns.js";
import { apportionColumns, columnGroups } from "./table-columns.js";

/**
 * pptxgenjs ships `module.exports = PptxGenJS` — the constructor itself — but
 * declares `export default` in its `.d.ts`. Under NodeNext resolution that
 * makes TypeScript hand back the module namespace where the runtime hands back
 * the class, so the value is reconciled once here and the type aliases below
 * then read normally everywhere else.
 */
const Pptx = pptxgen as unknown as typeof pptxgen.default;
type TextProps = pptxgen.default.TextProps;
type TableRow = pptxgen.default.TableRow;
type TableCell = pptxgen.default.TableCell;

// ---------------------------------------------------------------------------
// Canvas geometry — 16:9, the only aspect ratio anyone presents in
// ---------------------------------------------------------------------------

/** 16:9 at PowerPoint's 10" width. All measurements below are inches. */
const SLIDE_W = 10;
const SLIDE_H = 5.625;

const MARGIN_X = 0.55;
const CONTENT_W = SLIDE_W - 2 * MARGIN_X;

const TITLE_Y = 0.32;
const TITLE_H = 0.72;
const BODY_Y = 1.18;
/** Bottom gutter kept clear so nothing sits on the edge of the canvas. */
const BODY_BOTTOM_PAD = 0.35;
const BODY_H = SLIDE_H - BODY_BOTTOM_PAD - BODY_Y;

const PT_TITLE_H1 = 28;
const PT_TITLE_H2 = 24;
const PT_BODY = 16;
const PT_NESTED = 14;
const PT_MONO = 12;
const PT_TABLE = 12;

/** Padding inside a table cell, in points, per side — passed to `addTable`. */
const CELL_MARGIN_PT = 5;

const FONT_BODY = "Arial";
const FONT_MONO = "Courier New";

const INK = "1A2230";
const MUTED = "5A6779";
const ACCENT = "3D6EE8";
const RULE = "D9DEE8";
const HEADER_FILL = "EEF1F7";

/** Deepest bullet level PowerPoint indents sensibly. */
const MAX_INDENT = 4;

// ---------------------------------------------------------------------------
// Intermediate model
// ---------------------------------------------------------------------------

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
  link?: string;
}

/**
 * One logical paragraph of body text — a markdown paragraph, one list item, one
 * line of a code block. Packing works at this granularity, so it is also the
 * unit that can be moved to the next slide.
 */
interface Line {
  runs: Run[];
  indent: number;
  bullet?: "bullet" | "number";
  fontSize: number;
  /** Space after the paragraph, in points. */
  spaceAfter: number;
  color?: string;
  mono?: boolean;
}

interface TableModel {
  header: Run[][];
  rows: Run[][][];
  align: (string | null)[];
  /** Plain text of every cell, kept for width and height estimation. */
  headerText: string[];
  rowText: string[][];
}

type Chunk =
  | { kind: "lines"; line: Line }
  | { kind: "table"; table: TableModel };

/** A run of content that shares one slide title, before overflow splitting. */
interface Section {
  title: string;
  /** h1 titles are set a little larger than h2 titles. */
  depth: number;
  chunks: Chunk[];
  /** Opened by a heading rather than by a `---` slide break. */
  byHeading: boolean;
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

function inlineRuns(
  tokens: Token[] | undefined,
  style: Run = { text: "" },
): Run[] {
  if (!tokens?.length) return [];
  const out: Run[] = [];
  const inherit = (extra: Partial<Run>): Run => ({
    ...style,
    ...extra,
    text: "",
  });

  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(
          ...inlineRuns(
            (token as Tokens.Strong).tokens,
            inherit({ bold: true }),
          ),
        );
        break;
      case "em":
        out.push(
          ...inlineRuns((token as Tokens.Em).tokens, inherit({ italic: true })),
        );
        break;
      case "del":
        out.push(
          ...inlineRuns(
            (token as Tokens.Del).tokens,
            inherit({ strike: true }),
          ),
        );
        break;
      case "codespan":
        out.push({
          ...style,
          mono: true,
          text: decode((token as Tokens.Codespan).text),
        });
        break;
      case "br":
        out.push({ ...style, text: " " });
        break;
      case "link": {
        const link = token as Tokens.Link;
        // A relative href is worth more as plain text than as a dead link the
        // reader clicks and blames on us.
        const external = /^(https?:|mailto:)/i.test(link.href ?? "");
        const nested = inlineRuns(
          link.tokens,
          inherit(external ? { link: link.href } : {}),
        );
        if (nested.length) out.push(...nested);
        else
          out.push({
            ...style,
            text: decode(link.text),
            ...(external ? { link: link.href } : {}),
          });
        break;
      }
      case "image":
        // No network during render, so a remote image can't be embedded. Name
        // it instead of dropping it — a silently missing figure is worse.
        out.push({
          ...style,
          italic: true,
          text: `[image: ${decode((token as Tokens.Image).text || (token as Tokens.Image).href)}]`,
        });
        break;
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, style));
        else out.push({ ...style, text: decode(t.text) });
        break;
      }
      case "html":
        out.push({ ...style, text: decode((token as Tokens.HTML).raw) });
        break;
      case "escape":
        out.push({ ...style, text: decode((token as Tokens.Escape).text) });
        break;
      default: {
        const raw =
          (token as { text?: string; raw?: string }).text ??
          (token as { raw?: string }).raw ??
          "";
        if (raw) out.push({ ...style, text: decode(raw) });
      }
    }
  }
  return out.filter((r) => r.text.length > 0);
}

/**
 * marked leaves HTML entities escaped in token text (it emits HTML, after all).
 * PowerPoint wants the characters; the packager re-escapes them for the XML.
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

function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

// ---------------------------------------------------------------------------
// Markdown → sections
// ---------------------------------------------------------------------------

function line(runs: Run[], extra: Partial<Line> = {}): Line {
  return {
    runs,
    indent: 0,
    fontSize: PT_BODY,
    spaceAfter: 8,
    ...extra,
  };
}

function blockToChunks(token: Token, depth = 0): Chunk[] {
  switch (token.type) {
    case "paragraph":
      return [
        {
          kind: "lines",
          line: line(inlineRuns((token as Tokens.Paragraph).tokens)),
        },
      ];

    // h3 and deeper are not worth a slide of their own; they read as a
    // sub-heading inside the body of the slide their parent heading opened.
    case "heading": {
      const h = token as Tokens.Heading;
      return [
        {
          kind: "lines",
          line: line(
            inlineRuns(h.tokens).map((r) => ({ ...r, bold: true })),
            { fontSize: PT_BODY + 1, spaceAfter: 4, color: ACCENT },
          ),
        },
      ];
    }

    case "list": {
      const list = token as Tokens.List;
      const out: Chunk[] = [];
      for (const item of list.items)
        out.push(...listItemChunks(item, list.ordered, depth));
      return out;
    }

    case "table":
      return [{ kind: "table", table: tableModel(token as Tokens.Table) }];

    case "code":
      return (token as Tokens.Code).text.split("\n").map((text) => ({
        kind: "lines" as const,
        line: line([{ text: text || " ", mono: true }], {
          fontSize: PT_MONO,
          spaceAfter: 0,
          mono: true,
        }),
      }));

    case "blockquote":
      return (token as Tokens.Blockquote).tokens.flatMap((child) =>
        blockToChunks(child, depth).map((chunk) =>
          chunk.kind === "lines"
            ? {
                kind: "lines" as const,
                line: {
                  ...chunk.line,
                  // Not indented: OOXML's indent level only moves a paragraph
                  // that has a bullet, so an indent here would be measured but
                  // never rendered. Italic and a muted ink carry the quote.
                  color: MUTED,
                  runs: chunk.line.runs.map((r) => ({ ...r, italic: true })),
                },
              }
            : chunk,
        ),
      );

    case "html": {
      const raw = (token as Tokens.HTML).raw.replace(/<[^>]+>/g, " ").trim();
      return raw
        ? [{ kind: "lines", line: line([{ text: decode(raw) }]) }]
        : [];
    }

    case "space":
    case "hr":
      return [];

    default: {
      const text = (token as { text?: string }).text;
      return text
        ? [{ kind: "lines", line: line([{ text: decode(text) }]) }]
        : [];
    }
  }
}

function listItemChunks(
  item: Tokens.ListItem,
  ordered: boolean,
  depth: number,
): Chunk[] {
  const indent = Math.min(MAX_INDENT, depth);
  const inline = item.tokens.filter(
    (t) => t.type === "text" || t.type === "paragraph",
  );
  const nested = item.tokens.filter((t) => t.type === "list");
  const other = item.tokens.filter(
    (t) => !["text", "paragraph", "list", "space"].includes(t.type),
  );

  const runs = inline.flatMap((t) =>
    inlineRuns((t as Tokens.Text | Tokens.Paragraph).tokens),
  );
  // GFM task items keep their checkbox — it carries meaning in a checklist.
  const prefix: Run[] = item.task ? [{ text: item.checked ? "☒ " : "☐ " }] : [];

  const out: Chunk[] = [
    {
      kind: "lines",
      line: line(
        [...prefix, ...(runs.length ? runs : [{ text: decode(item.text) }])],
        {
          indent,
          bullet: ordered ? "number" : "bullet",
          fontSize: depth === 0 ? PT_BODY : PT_NESTED,
          spaceAfter: 4,
        },
      ),
    },
  ];

  for (const child of nested) out.push(...blockToChunks(child, depth + 1));
  for (const child of other) out.push(...blockToChunks(child, depth));
  return out;
}

function tableModel(token: Tokens.Table): TableModel {
  const header = token.header.map((cell) =>
    inlineRuns(cell.tokens).map((r) => ({ ...r, bold: true })),
  );
  const rows = token.rows.map((row) =>
    row.map((cell) => inlineRuns(cell.tokens)),
  );
  return {
    header,
    rows,
    align: token.align ?? [],
    headerText: header.map(runsText),
    rowText: rows.map((row) => row.map(runsText)),
  };
}

/**
 * Split the token stream into sections, one per `#`/`##` heading.
 *
 * A `---` rule is honoured as an explicit slide break inside a section — that
 * is what it means in every other markdown deck tool, and a user who typed one
 * meant it.
 */
function sections(tokens: Token[], leadTitle: string): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;

  const open = (title: string, depth: number, byHeading: boolean): Section => {
    const section: Section = { title, depth, chunks: [], byHeading };
    out.push(section);
    current = section;
    return section;
  };

  for (const token of tokens) {
    if (token.type === "heading" && (token as Tokens.Heading).depth <= 2) {
      const h = token as Tokens.Heading;
      open(runsText(inlineRuns(h.tokens)).trim() || "Untitled", h.depth, true);
      continue;
    }
    if (token.type === "hr") {
      // Same title, fresh slide.
      if (current) open(current.title, current.depth, false);
      continue;
    }
    const chunks = blockToChunks(token);
    if (!chunks.length) continue;
    (current ?? open(leadTitle, 1, false)).chunks.push(...chunks);
  }

  // A heading with nothing under it is a deliberate section divider and stays.
  // A rule with nothing after it is punctuation, and would otherwise become a
  // blank slide repeating the previous title.
  return out.filter((s) => s.byHeading || s.chunks.length > 0);
}

// ---------------------------------------------------------------------------
// Overflow: measure, then split
// ---------------------------------------------------------------------------

/**
 * Average glyph advance as a fraction of the point size.
 *
 * Calibrated against a rendered slide rather than guessed: 16pt Arial body copy
 * fits 86 characters across the 8.6" bullet column, an advance of 0.44. The
 * 0.45 here keeps a little headroom; `wrappedLineCount` does the rest, so the
 * constant no longer has to be inflated to cover word-wrap waste. The two
 * errors are not symmetric — over-estimating costs one extra slide,
 * under-estimating runs text off the bottom of the canvas — so PowerPoint's own
 * "shrink text on overflow" is left on as the backstop.
 */
const CHAR_ADVANCE = 0.45;
/** Courier New is monospaced at exactly 0.6 em. */
const MONO_ADVANCE = 0.6;
const LINE_SPACING = 1.28;

function charsPerLine(l: Line): number {
  const indentIn = l.indent * 0.35 + (l.bullet ? 0.3 : 0);
  const widthPt = Math.max(1, CONTENT_W - indentIn) * 72;
  const advance = l.fontSize * (l.mono ? MONO_ADVANCE : CHAR_ADVANCE);
  return Math.max(10, Math.floor(widthPt / advance));
}

/**
 * How many rendered lines a string occupies, by simulating the word wrap.
 *
 * Dividing length by characters-per-line looks equivalent and is not: it lands
 * on the wrong side of the boundary for any paragraph within a few percent of a
 * whole number of lines, which is most of them, and each mistake costs a whole
 * slide. Walking the words also gets the genuinely different case right — a
 * long unbreakable token (a URL) that overflows on its own.
 */
export function wrappedLineCount(text: string, perLine: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;

  let lines = 1;
  let used = 0;
  for (const word of words) {
    const width = used === 0 ? word.length : word.length + 1;
    if (used > 0 && used + width > perLine) {
      lines += 1;
      used = word.length;
    } else {
      used += width;
    }
    // A single token wider than the column wraps inside itself.
    while (used > perLine) {
      lines += 1;
      used -= perLine;
    }
  }
  return lines;
}

/** Height of one packed paragraph, in inches. */
function lineHeight(l: Line): number {
  const wrapped = wrappedLineCount(runsText(l.runs), charsPerLine(l));
  return (wrapped * l.fontSize * LINE_SPACING + l.spaceAfter) / 72;
}

/**
 * Split a paragraph too tall for an entire empty slide into pieces that fit.
 *
 * Splitting happens on word boundaries and preserves run formatting: the runs
 * are walked in order and cut where the budget runs out, so a bold phrase that
 * straddles the break stays bold on both sides.
 */
function splitLine(l: Line, budgetIn: number): Line[] {
  const perLine = charsPerLine(l);
  const linesThatFit = Math.max(
    1,
    Math.floor((budgetIn * 72 - l.spaceAfter) / (l.fontSize * LINE_SPACING)),
  );
  const budgetChars = Math.max(perLine, perLine * linesThatFit);

  const out: Line[] = [];
  let bucket: Run[] = [];
  let used = 0;

  const flush = () => {
    if (!bucket.length) return;
    out.push({ ...l, runs: bucket });
    bucket = [];
    used = 0;
  };

  for (const run of l.runs) {
    let remaining = run.text;
    while (remaining.length) {
      const room = budgetChars - used;
      if (room <= 0) {
        flush();
        continue;
      }
      if (remaining.length <= room) {
        bucket.push({ ...run, text: remaining });
        used += remaining.length;
        remaining = "";
        break;
      }
      // Cut at the last space inside the budget so words survive intact.
      const slice = remaining.slice(0, room);
      const cut = slice.lastIndexOf(" ");
      const at = cut > room * 0.4 ? cut : room;
      bucket.push({ ...run, text: remaining.slice(0, at).trimEnd() });
      remaining = remaining.slice(at).trimStart();
      flush();
    }
  }
  flush();
  return out.length ? out : [l];
}

/**
 * The size a table on a slide has to be set at to be *read* rather than
 * squinted at — 24px, which is 18pt at 96dpi.
 *
 * It is deliberately not {@link PT_TABLE}. Twelve points is the size at which a
 * grid still physically fits a canvas; eighteen is the size at which a person
 * two metres from a screen takes a row in at a glance. The exporter lays tables
 * out at the first and judges them at the second, because "does it fit" and "is
 * it still a table" are different questions and only the second one decides
 * whether this content wanted a document all along.
 */
const LEGIBLE_PT = 18;

/**
 * How tall one row may be before it stops being a row.
 *
 * A table is a thing you scan. The moment a single row needs more than half the
 * canvas, the reader is reading a paragraph that happens to have borders — the
 * eye has to travel further down one record than across the whole table, and
 * the shape has stopped doing the work a table exists to do.
 */
const GLANCE_H = BODY_H / 2;

/** Rows of a table that fit on one slide, given its estimated row heights. */
function tableRowHeights(
  table: TableModel,
  widths: number[],
  fontPt = PT_TABLE,
): {
  header: number;
  rows: number[];
} {
  const cellLines = (text: string, i: number) => {
    const widthPt = Math.max(0.4, widths[i] ?? 1) * 72 - 18; // less cell margins
    const perLine = Math.max(6, Math.floor(widthPt / (fontPt * CHAR_ADVANCE)));
    return wrappedLineCount(text, perLine);
  };
  const rowHeight = (cells: string[]) =>
    (Math.max(...cells.map((t, i) => cellLines(t, i)), 1) *
      fontPt *
      LINE_SPACING +
      10) /
    72;

  return {
    header: rowHeight(table.headerText),
    rows: table.rowText.map(rowHeight),
  };
}

/** The units `table-columns` works in on a slide: inches, at the table size. */
const TABLE_METRICS: ApportionOptions = {
  fontPt: PT_TABLE,
  unitsPerPt: 1 / 72,
  padding: (2 * CELL_MARGIN_PT) / 72,
};

function columnTexts(table: TableModel): ColumnText[] {
  return table.headerText.map((header, i) => ({
    header,
    cells: table.rowText.map((r) => r[i] ?? ""),
  }));
}

/**
 * Column widths in inches. `apportionColumns` decides the split; see there for
 * why a column's longest unbreakable token, not just its text volume, sets a
 * floor.
 */
function columnWidths(table: TableModel): number[] {
  if (table.headerText.length === 0) return [];
  return apportionColumns(columnTexts(table), CONTENT_W, TABLE_METRICS);
}

interface TableSlice {
  header: Run[][];
  rows: Run[][][];
  align: (string | null)[];
  widths: number[];
}

interface Page {
  title: string;
  depth: number;
  /** A page carries either text paragraphs or one table slice, never both. */
  lines: Line[];
  table?: TableSlice;
  /** "1 of 3" — set only when a table was split, so the seam is deliberate. */
  part?: { index: number; count: number };
  continued: boolean;
}

/**
 * How firmly the deck has to say that this content wanted a document.
 *
 * One measure decides all three — how tall the tallest laid-out row is against
 * {@link GLANCE_H} — so they are three temperatures of one honest sentence
 * rather than three rules that can disagree. `width` is a table that split
 * cleanly and reads fine; `long` is past the glance; `document` is a row that
 * fills a whole slide by itself.
 */
type Temperature = "none" | "width" | "long" | "document";

const FIRMNESS: Record<Temperature, number> = {
  none: 0,
  width: 1,
  long: 2,
  document: 3,
};

/**
 * The one thing the exporter still declines to draw: a cell bigger than the
 * slide it would have to live on.
 *
 * Everywhere else a recommendation is enough, because a split deck plus a
 * truthful note leaves the owner with work they can use. Here there is no split
 * to make — one cell alone, given the whole canvas at a readable size, still
 * runs off it — so a grid would be a picture of text falling off a slide.
 */
const REFUSAL =
  "One cell here is bigger than a whole slide, so there is no split that helps — " +
  "this is a document, not a deck. Want it as one?";

const COUNT_WORDS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * Turn sections into pages that are guaranteed to fit.
 *
 * A table is given its own page rather than being placed under a measured
 * stack of paragraphs: a native pptx table is positioned absolutely, so any
 * error in the text height estimate above it would put the grid on top of the
 * prose. Keeping them apart makes the geometry exact instead of approximate.
 *
 * The notes come back with the pages because a split is a decision the deck
 * cannot state on its own: the slides show the seam, and the note is what says
 * out loud that it was deliberate and what the alternative is.
 */
function paginate(list: Section[]): { pages: Page[]; notes: string[] } {
  const pages: Page[] = [];
  const flagged: {
    temperature: Temperature;
    split: boolean;
    slides: number;
  }[] = [];
  let refused = false;

  for (const section of list) {
    let continued = false;
    const push = (page: Omit<Page, "title" | "depth" | "continued">) => {
      pages.push({
        title: section.title,
        depth: section.depth,
        continued,
        ...page,
      });
      continued = true;
    };

    let bucket: Line[] = [];
    let used = 0;
    const flushText = () => {
      if (!bucket.length) return;
      push({ lines: bucket });
      bucket = [];
      used = 0;
    };

    for (const chunk of section.chunks) {
      if (chunk.kind === "table") {
        flushText();
        const plan = planTable(chunk.table);
        if (plan.refused) {
          refused = true;
          push({
            lines: [line([{ text: REFUSAL, italic: true }], { color: MUTED })],
          });
          continue;
        }
        const count = plan.slices.length;
        if (plan.temperature !== "none")
          flagged.push({
            temperature: plan.temperature,
            split: plan.splitWide,
            slides: count,
          });
        plan.slices.forEach((slice, i) =>
          push({
            lines: [],
            table: slice,
            ...(count > 1 ? { part: { index: i + 1, count } } : {}),
          }),
        );
        continue;
      }

      const pieces =
        lineHeight(chunk.line) > BODY_H
          ? splitLine(chunk.line, BODY_H)
          : [chunk.line];
      for (const piece of pieces) {
        const h = lineHeight(piece);
        if (bucket.length && used + h > BODY_H) flushText();
        bucket.push(piece);
        used += h;
      }
    }
    flushText();

    // A heading with nothing under it is still a slide — a section divider.
    if (!continued) push({ lines: [] });
  }

  const notes: string[] = [];
  const first = flagged[0];
  if (flagged.length === 1 && first)
    notes.push(tableNote(first.temperature, first.split, first.slides));
  else if (flagged.length > 1)
    notes.push(
      manyTablesNote(
        flagged.reduce(
          (worst, f) =>
            FIRMNESS[f.temperature] > FIRMNESS[worst] ? f.temperature : worst,
          "none" as Temperature,
        ),
      ),
    );
  if (refused) notes.push(REFUSAL);

  return { pages, notes };
}

/**
 * The same sentence at three temperatures.
 *
 * Every one of them ends in the document offer, because the note exists to hand
 * the owner the better shape — not to apologise for the one they got. The deck
 * is already in their hands either way; what changes across the three is only
 * how strongly Cue says that the deck was the wrong container.
 */
function tableNote(
  temperature: Temperature,
  split: boolean,
  slides: number,
): string {
  const across = `Too wide for one slide, so I split it across ${countWord(slides)}`;
  switch (temperature) {
    case "width":
      return `${across} — want it as a document instead?`;
    case "long":
      return split
        ? `${across} — though these rows are really too long for slides. Want it as a document?`
        : "I laid this out as a table, though these rows are really too long for slides. Want it as a document?";
    case "document":
      return split
        ? `${across}, but a single row fills a slide on its own — this is a document, not a deck. Want it as one?`
        : "A single row here fills a slide on its own — this is a document, not a deck. I laid it out anyway. Want it as one?";
    default:
      return "";
  }
}

/** The same three temperatures when more than one table wanted saying. */
function manyTablesNote(temperature: Temperature): string {
  switch (temperature) {
    case "width":
      return "Several tables were too wide for one slide, so I split each across more than one — want this as a document instead?";
    case "long":
      return "Several tables were too wide for one slide, and their rows are really too long for slides. Want this as a document?";
    case "document":
      return "Several tables here have rows that fill a slide on their own — this is a document, not a deck. I laid them out anyway. Want it as one?";
    default:
      return "";
  }
}

/** Split a table into per-slide slices, repeating the header row on each. */
function sliceRows(table: TableModel): TableSlice[] {
  const widths = columnWidths(table);
  const heights = tableRowHeights(table, widths);
  const budget = BODY_H - heights.header;

  const slices: TableSlice[] = [];
  let rows: Run[][][] = [];
  let used = 0;

  for (const [i, row] of table.rows.entries()) {
    const h = heights.rows[i] ?? 0.3;
    if (rows.length && used + h > budget) {
      slices.push({ header: table.header, rows, align: table.align, widths });
      rows = [];
      used = 0;
    }
    rows.push(row);
    used += h;
  }
  slices.push({ header: table.header, rows, align: table.align, widths });
  return slices;
}

/** The columns named by `group`, as a table in their own right. */
function subTable(table: TableModel, group: number[]): TableModel {
  return {
    header: group.map((i) => table.header[i] ?? []),
    rows: table.rows.map((row) => group.map((i) => row[i] ?? [])),
    align: group.map((i) => table.align[i] ?? null),
    headerText: group.map((i) => table.headerText[i] ?? ""),
    rowText: table.rowText.map((row) => group.map((i) => row[i] ?? "")),
  };
}

/** Whether every row of this column group still fits between title and edge. */
function groupFits(table: TableModel): boolean {
  const heights = tableRowHeights(table, columnWidths(table));
  const budget = BODY_H - heights.header;
  return heights.rows.every((h) => h <= budget);
}

/** The narrowest split that still says which row is which: key plus one. */
function narrowestGroups(count: number): number[][] {
  if (count <= 2) return [Array.from({ length: count }, (_, i) => i)];
  return Array.from({ length: count - 1 }, (_, k) => [0, k + 1]);
}

/**
 * Whether one cell, given a whole slide to itself, still overflows it.
 *
 * The full content width, everything below the title, and nothing else on the
 * canvas — laid out at the size a slide's text has to be to be read. There is
 * no arrangement of columns that beats giving a cell the entire slide, so a
 * cell that loses here loses everywhere, and that is the one case with nothing
 * to emit.
 *
 * One header row is still charged for. A body cell never appears without the
 * heading that says what it is, so "a slide of its own" is the slide minus that
 * row, not the bare canvas.
 */
function cellFitsAlone(text: string): boolean {
  const perLine = Math.max(
    6,
    Math.floor((CONTENT_W * 72 - 18) / (LEGIBLE_PT * CHAR_ADVANCE)),
  );
  const rowHeight = (lines: number) =>
    (lines * LEGIBLE_PT * LINE_SPACING + 10) / 72;
  return rowHeight(wrappedLineCount(text, perLine)) <= BODY_H - rowHeight(1);
}

/**
 * The tallest row of a plan, as a multiple of {@link GLANCE_H}.
 *
 * Measured on the laid-out row — the group's own apportioned column widths, at
 * {@link LEGIBLE_PT} — rather than on how much text the row contains. The same
 * 1,400 characters is a comfortable row across five columns and an essay in
 * one, and no count of characters can tell those two apart.
 */
function glanceRatio(table: TableModel, groups: number[][]): number {
  let tallest = 0;
  for (const group of groups) {
    const sub = subTable(table, group);
    const heights = tableRowHeights(sub, columnWidths(sub), LEGIBLE_PT);
    for (const h of heights.rows) if (h > tallest) tallest = h;
  }
  return tallest / GLANCE_H;
}

interface TablePlan {
  slices: TableSlice[];
  /** Split by column across slides, not merely by row. */
  splitWide: boolean;
  /** A cell too big for a slide of its own: nothing to split, nothing to emit. */
  refused: boolean;
  /** How firmly the note says a document would have been the better shape. */
  temperature: Temperature;
}

/**
 * Decide how a table becomes slides.
 *
 * Two lengths have to fit and only one of them is negotiable by apportionment.
 * A table wider than the canvas is cut into groups of columns
 * (`columnGroups`), each group its own run of slides, each repeating the header
 * row and the first column. Shrinking the type instead is the tempting answer
 * and the wrong one: a deck's table is already at the size a person can read
 * from a chair, so the few points there are to give buy nothing and cost the
 * only thing the slide was for.
 *
 * Height decides how firmly the deck says a document would have been better,
 * and it says so *with* the slides rather than instead of them. A refusal that
 * emits only a sentence is the one outcome where the owner's work has to be
 * redone from scratch: they asked for a deck, so they get a deck, plus the note
 * that this content wanted a different shape. See {@link glanceRatio} for the
 * measure and {@link tableNote} for the three temperatures it picks between.
 *
 * The single exception is a cell larger than a slide of its own. Fewer columns
 * beside it is the only lever splitting has, and that lever has already been
 * pulled all the way — so there is nothing to emit, and that alone refuses.
 */
function planTable(table: TableModel): TablePlan {
  const none = {
    slices: [],
    splitWide: false,
    refused: false,
    temperature: "none" as const,
  };
  if (table.headerText.length === 0) return none;

  const everyCell = [table.headerText, ...table.rowText].flat();
  if (!everyCell.every(cellFitsAlone))
    return { ...none, refused: true, slices: [] };

  const columns = columnTexts(table);
  let groups = columnGroups(columns, CONTENT_W, TABLE_METRICS);

  // Placement, not legibility: a group whose rows overrun the canvas at the
  // size they are actually drawn gets fewer columns, so the grid stays on the
  // slide. Past the narrowest split there is no further lever — and a cell that
  // survived `cellFitsAlone` always has room there — so this never refuses.
  if (!groups.every((g) => groupFits(subTable(table, g)))) {
    const narrow = narrowestGroups(columns.length);
    if (narrow.length > groups.length) groups = narrow;
  }

  const ratio = glanceRatio(table, groups);
  const splitWide = groups.length > 1;
  return {
    slices: groups.flatMap((g) => sliceRows(subTable(table, g))),
    splitWide,
    refused: false,
    // Above one, a row no longer fits in a glance. Above two it no longer fits
    // on a slide at all — one record has become the whole canvas.
    temperature:
      ratio > 2
        ? "document"
        : ratio > 1
          ? "long"
          : splitWide
            ? "width"
            : "none",
  };
}

// ---------------------------------------------------------------------------
// Pages → pptx
// ---------------------------------------------------------------------------

function runOptions(run: Run, l: Line) {
  return {
    bold: run.bold || undefined,
    italic: run.italic || undefined,
    strike: run.strike || undefined,
    fontFace: run.mono || l.mono ? FONT_MONO : FONT_BODY,
    ...(run.link ? { hyperlink: { url: run.link } } : {}),
  };
}

function textItems(lines: Line[]): TextProps[] {
  const items: TextProps[] = [];
  for (const l of lines) {
    const runs = l.runs.length ? l.runs : [{ text: " " }];
    runs.forEach((run, i) => {
      const first = i === 0;
      const last = i === runs.length - 1;
      items.push({
        text: run.text,
        options: {
          ...runOptions(run, l),
          fontSize: l.fontSize,
          color: l.color ?? INK,
          // Paragraph-level properties belong to the paragraph, so they are set
          // on its first run only; `dedupeParagraphProps` drops the stray
          // copies pptxgenjs emits for the rest.
          ...(first
            ? {
                indentLevel: l.indent,
                ...(l.bullet
                  ? {
                      bullet: l.bullet === "number" ? { type: "number" } : true,
                    }
                  : { bullet: false }),
                paraSpaceAfter: l.spaceAfter || undefined,
              }
            : {}),
          ...(last ? { breakLine: true } : {}),
        },
      });
    });
  }
  return items;
}

function alignOf(
  align: string | null | undefined,
): "left" | "right" | "center" {
  return align === "right" ? "right" : align === "center" ? "center" : "left";
}

function cellItems(runs: Run[], l: Line): TableCell[] {
  const list: Run[] = runs.length ? runs : [{ text: "" }];
  return list.map((run, i) => ({
    text: run.text,
    options: {
      ...runOptions(run, l),
      bullet: false,
      ...(i === list.length - 1 ? { breakLine: true } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// OOXML repair
// ---------------------------------------------------------------------------

/**
 * Keep only the first `<a:pPr>` in each `<a:p>`.
 *
 * pptxgenjs 4.0.1 writes a paragraph-properties element in front of *every*
 * run, so a paragraph mixing bold and plain text ("a **bold** word") comes out
 * with two or three `<a:pPr>` children. ECMA-376's `CT_TextParagraph` allows
 * exactly one, first — which is why this pass exists rather than a rule against
 * mixed formatting: inline bold and italic are the point of a structural
 * export, and the fix belongs in the packaging, not in the mapping.
 */
export function dedupeParagraphProps(xml: string): string {
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
    let seen = false;
    return paragraph.replace(
      /<a:pPr(?:\s[^>]*)?\/>|<a:pPr(?:\s[^>]*)?>[\s\S]*?<\/a:pPr>/g,
      (pPr) => {
        if (seen) return "";
        seen = true;
        return pPr;
      },
    );
  });
}

/** Apply {@link dedupeParagraphProps} to every slide part in the package. */
async function repairPackage(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/.test(
      name,
    ),
  );
  for (const name of parts) {
    const xml = await zip.file(name)!.async("string");
    zip.file(name, dedupeParagraphProps(xml));
  }
  return (await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  })) as Buffer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PptxOptions {
  /** Used for the opening title slide and the deck's document properties. */
  title?: string;
}

export interface RenderedDeck {
  bytes: Buffer;
  slideCount: number;
  slideTitles: string[];
  /**
   * What the deck cannot say for itself, in Cue's voice — a table split across
   * slides, or one that belongs in a document. Empty for an ordinary deck.
   */
  notes: string[];
}

/**
 * Convert a markdown document into a PowerPoint deck of editable slides.
 *
 * Every slide's text is a live text run: the recipient opens it in PowerPoint,
 * clicks into a bullet and retypes it. Nothing here is an image of anything.
 * Throws only if the markdown is empty.
 */
export async function renderMarkdownToPptx(
  markdown: string,
  opts: PptxOptions = {},
): Promise<RenderedDeck> {
  if (!markdown.trim())
    throw new Error("Nothing to export — the content is empty.");

  const tokens = marked.lexer(markdown, { gfm: true });
  const first = tokens.find((t) => t.type !== "space");
  const opensWithH1 =
    first?.type === "heading" && (first as Tokens.Heading).depth === 1;

  // A title slide is only prepended when the content doesn't already open with
  // an h1 — otherwise every deck gets its name twice.
  const titleSlide = opts.title && !opensWithH1 ? opts.title : undefined;
  const { pages, notes } = paginate(
    sections(tokens, titleSlide ? "Overview" : (opts.title ?? "Overview")),
  );

  const pptx = new Pptx();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "Cue";
  if (opts.title) pptx.title = opts.title;

  const slideTitles: string[] = [];

  if (titleSlide) {
    slideTitles.push(titleSlide);
    const slide = pptx.addSlide();
    slide.addText(
      [{ text: titleSlide, options: { bullet: false, breakLine: true } }],
      {
        x: MARGIN_X,
        y: SLIDE_H / 2 - 0.9,
        w: CONTENT_W,
        h: 1.2,
        fontSize: 36,
        bold: true,
        color: INK,
        fontFace: FONT_BODY,
        align: "center",
        valign: "middle",
      },
    );
    slide.addShape("line", {
      x: SLIDE_W / 2 - 0.6,
      y: SLIDE_H / 2 + 0.45,
      w: 1.2,
      h: 0,
      line: { color: ACCENT, width: 2 },
    });
  }

  for (const page of pages) {
    const slide = pptx.addSlide();
    // A split table names its part in the title. "(cont.)" says only that
    // something came before; "1 of 3" says how much is still to come, which is
    // what a reader looking at half a table needs to know.
    const heading = page.part
      ? `${page.title} · ${page.part.index} of ${page.part.count}`
      : page.continued
        ? `${page.title} (cont.)`
        : page.title;
    slideTitles.push(heading);

    slide.addText(
      [{ text: heading, options: { bullet: false, breakLine: true } }],
      {
        x: MARGIN_X,
        y: TITLE_Y,
        w: CONTENT_W,
        h: TITLE_H,
        fontSize: page.depth === 1 ? PT_TITLE_H1 : PT_TITLE_H2,
        bold: true,
        color: INK,
        fontFace: FONT_BODY,
        valign: "middle",
        fit: "shrink",
      },
    );
    slide.addShape("line", {
      x: MARGIN_X,
      y: TITLE_Y + TITLE_H + 0.06,
      w: CONTENT_W,
      h: 0,
      line: { color: RULE, width: 1 },
    });

    if (page.table) {
      const { header, rows, align, widths } = page.table;
      const headerRow: TableRow = header.map((cell, i) => ({
        text: cellItems(cell, line(cell)),
        options: {
          align: alignOf(align[i]),
          fill: { color: HEADER_FILL },
          valign: "middle" as const,
        },
      }));
      const bodyRows: TableRow[] = rows.map((row) =>
        header.map((_, i) => ({
          text: cellItems(row[i] ?? [], line(row[i] ?? [])),
          options: { align: alignOf(align[i]), valign: "middle" as const },
        })),
      );
      slide.addTable([headerRow, ...bodyRows], {
        x: MARGIN_X,
        y: BODY_Y,
        w: CONTENT_W,
        colW: widths,
        fontSize: PT_TABLE,
        fontFace: FONT_BODY,
        color: INK,
        border: { type: "solid", pt: 1, color: RULE },
        margin: CELL_MARGIN_PT,
        autoPage: false,
      });
    } else if (page.lines.length) {
      slide.addText(textItems(page.lines), {
        x: MARGIN_X,
        y: BODY_Y,
        w: CONTENT_W,
        h: BODY_H,
        valign: "top",
        fontFace: FONT_BODY,
        color: INK,
        fit: "shrink",
      });
    }
  }

  const raw = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return {
    bytes: await repairPackage(Buffer.from(raw)),
    slideCount: slideTitles.length,
    slideTitles,
    notes,
  };
}
