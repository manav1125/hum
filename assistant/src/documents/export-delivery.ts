/**
 * The one place that knows how a document becomes a downloadable file.
 *
 * Every export format resolves to the same three things — bytes, a filename,
 * and a MIME type — and every one is delivered the same way, as an in-chat
 * attachment. Keeping that in a single function is what stops the export tools
 * from drifting apart as formats are added: a new format is a new `case`, not
 * a new delivery path.
 */

import { renderMarkdownToDocx } from "./docx-render.js";
import { renderMarkdownToHtmlDocument } from "./html-export.js";
import { renderMarkdownToPDF } from "./pdf-render.js";
import { renderMarkdownToPng } from "./png-render.js";
import { renderMarkdownToPptx } from "./pptx-render.js";
import { renderMarkdownTablesToXlsx } from "./xlsx-render.js";

export const EXPORT_FORMATS = [
  "pdf",
  "png",
  "markdown",
  "html",
  "docx",
  "xlsx",
  "pptx",
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return (
    typeof value === "string" &&
    (EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

const SPEC: Record<ExportFormat, { ext: string; mime: string }> = {
  pdf: { ext: "pdf", mime: "application/pdf" },
  png: { ext: "png", mime: "image/png" },
  markdown: { ext: "md", mime: "text/markdown" },
  html: { ext: "html", mime: "text/html" },
  docx: {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pptx: {
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
};

export function mimeFor(format: ExportFormat): string {
  return SPEC[format].mime;
}

export function extensionFor(format: ExportFormat): string {
  return SPEC[format].ext;
}

export function sanitizeFilename(title: string, fallback = "document"): string {
  return (
    title
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

export interface RenderOptions {
  /** Used as the docx title heading, the html <title>, and the workbook title. */
  title?: string;
  /** PNG only: capture a single element instead of the page. */
  selector?: string;
  /** PNG only: pixel density. Default 2. */
  scale?: number;
  /** PNG only: viewport width in CSS px. Default 1000. */
  widthPx?: number;
}

export interface RenderedExport {
  bytes: Buffer;
  /** Format-specific facts worth telling the model about (sheet names, size). */
  detail: Record<string, unknown>;
}

/**
 * Render a markdown document into the requested format.
 *
 * Markdown is the common currency here: it is what the editor stores, so every
 * format is derived from it rather than from a per-format authoring path.
 */
export async function renderMarkdownAs(
  format: ExportFormat,
  markdown: string,
  opts: RenderOptions = {},
): Promise<RenderedExport> {
  switch (format) {
    case "markdown":
      return { bytes: Buffer.from(markdown, "utf8"), detail: {} };

    case "html": {
      const html = renderMarkdownToHtmlDocument(markdown, {
        title: opts.title,
      });
      return { bytes: Buffer.from(html, "utf8"), detail: {} };
    }

    case "pdf":
      return {
        bytes: await renderMarkdownToPDF(opts.title ?? "", markdown),
        detail: { pageFormat: "A4" },
      };

    case "png": {
      const png = await renderMarkdownToPng(markdown, {
        selector: opts.selector,
        deviceScaleFactor: opts.scale,
        widthPx: opts.widthPx,
      });
      return {
        bytes: png.bytes,
        detail: { width: png.width, height: png.height },
      };
    }

    case "docx":
      return {
        bytes: await renderMarkdownToDocx(markdown, { title: opts.title }),
        detail: { editable: true },
      };

    case "xlsx": {
      const book = await renderMarkdownTablesToXlsx(markdown, {
        title: opts.title,
      });
      return {
        bytes: book.bytes,
        detail: { sheets: book.sheets, tableCount: book.tableCount },
      };
    }

    case "pptx": {
      const deck = await renderMarkdownToPptx(markdown, { title: opts.title });
      return {
        bytes: deck.bytes,
        detail: {
          editable: true,
          slideCount: deck.slideCount,
          slideTitles: deck.slideTitles,
          // Said explicitly so the model repeats it rather than implying the
          // deck reproduces a designed layout.
          note: "Structural export: real editable text, PowerPoint's own styling — not a copy of a designed layout.",
          // Already phrased for the reader — a table split across slides, or
          // one that belongs in a document. Say these to the user as written.
          ...(deck.notes.length ? { say: deck.notes } : {}),
        },
      };
    }
  }
}
