/**
 * Markdown → Notion blocks.
 *
 * Notion's API has no binary and no markdown surface: a page's body is a tree
 * of typed block objects, so a document only reaches Notion by being rebuilt
 * as blocks. This walks the same `marked` token stream the DOCX and XLSX
 * renderers walk, so all three read a document the same way and a third
 * markdown parser never enters the codebase.
 *
 * Notion's own limits are enforced here rather than discovered at the API:
 * 2000 characters per rich-text object, 100 blocks per append request.
 */

import type { Token, Tokens } from "marked";
import { marked } from "marked";

/** Notion's per-rich-text-object character ceiling. */
const RICH_TEXT_MAX = 2000;
/** Notion's per-request block ceiling for `blocks/{id}/children`. */
export const NOTION_MAX_BLOCKS_PER_REQUEST = 100;

type NotionBlock = Record<string, unknown>;

interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: Annotations;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function textRun(
  content: string,
  annotations: Annotations,
  href?: string,
): RichText[] {
  if (!content) return [];
  const out: RichText[] = [];
  // Long runs are split rather than truncated: losing the tail of a paragraph
  // silently is worse than an extra rich-text object.
  for (let i = 0; i < content.length; i += RICH_TEXT_MAX) {
    const slice = content.slice(i, i + RICH_TEXT_MAX);
    const item: RichText = {
      type: "text",
      text: href ? { content: slice, link: { url: href } } : { content: slice },
    };
    if (Object.keys(annotations).length > 0) item.annotations = annotations;
    out.push(item);
  }
  return out;
}

/** Flatten marked's inline token tree into Notion rich-text objects. */
function inlineRichText(
  tokens: Token[] | undefined,
  annotations: Annotations = {},
  href?: string,
): RichText[] {
  if (!tokens) return [];
  const out: RichText[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out.push(
          ...inlineRichText(
            (token as Tokens.Strong).tokens,
            { ...annotations, bold: true },
            href,
          ),
        );
        break;
      case "em":
        out.push(
          ...inlineRichText(
            (token as Tokens.Em).tokens,
            { ...annotations, italic: true },
            href,
          ),
        );
        break;
      case "del":
        out.push(
          ...inlineRichText(
            (token as Tokens.Del).tokens,
            { ...annotations, strikethrough: true },
            href,
          ),
        );
        break;
      case "codespan":
        out.push(
          ...textRun(
            decodeEntities((token as Tokens.Codespan).text),
            { ...annotations, code: true },
            href,
          ),
        );
        break;
      case "link": {
        const link = token as Tokens.Link;
        out.push(...inlineRichText(link.tokens, annotations, link.href));
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        out.push(
          ...textRun(
            `[image: ${decodeEntities(image.text || image.href)}]`,
            annotations,
            href,
          ),
        );
        break;
      }
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          out.push(...inlineRichText(t.tokens, annotations, href));
        } else {
          out.push(...textRun(decodeEntities(t.text), annotations, href));
        }
        break;
      }
      case "escape":
        out.push(
          ...textRun(
            decodeEntities((token as Tokens.Escape).text),
            annotations,
            href,
          ),
        );
        break;
      case "br":
        out.push(...textRun("\n", annotations, href));
        break;
      default: {
        const raw = (token as { raw?: string }).raw;
        if (raw) out.push(...textRun(decodeEntities(raw), annotations, href));
      }
    }
  }
  return out;
}

function paragraph(richText: RichText[]): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText },
  };
}

function listItems(list: Tokens.List): NotionBlock[] {
  const type = list.ordered ? "numbered_list_item" : "bulleted_list_item";
  return list.items.map((item) => {
    // A checklist item is a to-do in Notion, which is strictly better than a
    // bullet with a literal "[ ]" in it.
    if (item.task) {
      return {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: inlineRichText(item.tokens),
          checked: Boolean(item.checked),
        },
      };
    }
    return {
      object: "block",
      type,
      [type]: { rich_text: inlineRichText(item.tokens) },
    };
  });
}

function tableBlock(table: Tokens.Table): NotionBlock {
  const width = table.header.length;
  const row = (cells: Tokens.TableCell[]): NotionBlock => ({
    object: "block",
    type: "table_row",
    table_row: {
      cells: Array.from({ length: width }, (_, i) =>
        inlineRichText(cells[i]?.tokens),
      ),
    },
  });
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: [row(table.header), ...table.rows.map(row)],
    },
  };
}

function blockFor(token: Token): NotionBlock[] {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      // Notion only has three heading levels; deeper markdown headings land on
      // heading_3 rather than being dropped.
      const level = Math.min(Math.max(h.depth, 1), 3);
      const type = `heading_${level}`;
      return [
        {
          object: "block",
          type,
          [type]: { rich_text: inlineRichText(h.tokens) },
        },
      ];
    }
    case "paragraph":
      return [paragraph(inlineRichText((token as Tokens.Paragraph).tokens))];
    case "list":
      return listItems(token as Tokens.List);
    case "table":
      return [tableBlock(token as Tokens.Table)];
    case "code": {
      const c = token as Tokens.Code;
      return [
        {
          object: "block",
          type: "code",
          code: {
            rich_text: textRun(c.text, {}),
            language: notionLanguage(c.lang),
          },
        },
      ];
    }
    case "blockquote": {
      const q = token as Tokens.Blockquote;
      return [
        {
          object: "block",
          type: "quote",
          quote: {
            rich_text: inlineRichText(
              q.tokens.flatMap((t) =>
                t.type === "paragraph"
                  ? ((t as Tokens.Paragraph).tokens ?? [])
                  : [t],
              ),
            ),
          },
        },
      ];
    }
    case "hr":
      return [{ object: "block", type: "divider", divider: {} }];
    case "space":
      return [];
    default: {
      const raw = (token as { raw?: string }).raw?.trim();
      return raw ? [paragraph(textRun(decodeEntities(raw), {}))] : [];
    }
  }
}

/**
 * Notion rejects a code block whose `language` it does not know, so anything
 * unrecognised becomes "plain text" rather than failing the whole append.
 */
const NOTION_LANGUAGES = new Set([
  "bash",
  "c",
  "c++",
  "c#",
  "css",
  "diff",
  "docker",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "markdown",
  "php",
  "plain text",
  "python",
  "ruby",
  "rust",
  "shell",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
]);

function notionLanguage(lang: string | undefined): string {
  if (!lang) return "plain text";
  const normalized = lang.trim().toLowerCase().split(/\s+/)[0];
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "shell",
    yml: "yaml",
    md: "markdown",
    text: "plain text",
    txt: "plain text",
  };
  const candidate = aliases[normalized] ?? normalized;
  return NOTION_LANGUAGES.has(candidate) ? candidate : "plain text";
}

/** Convert a markdown document into a flat list of Notion block objects. */
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const tokens = marked.lexer(markdown);
  return tokens.flatMap(blockFor);
}

/** Split blocks into append-sized batches Notion will accept. */
export function chunkNotionBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const out: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += NOTION_MAX_BLOCKS_PER_REQUEST) {
    out.push(blocks.slice(i, i + NOTION_MAX_BLOCKS_PER_REQUEST));
  }
  return out;
}
