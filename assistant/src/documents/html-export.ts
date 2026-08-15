/**
 * Markdown → standalone HTML, and the multi-file zip wrapper.
 *
 * The cheapest export we have: the PDF path already renders markdown into a
 * self-contained HTML document, so shipping that document *as* the deliverable
 * is a matter of not throwing it away. It matters because HTML is the one
 * format that stays live — it can be pasted into a CMS, emailed as a body, or
 * opened offline with the styling intact.
 */

import JSZip from "jszip";
import { marked } from "marked";

import { wrapInPrintTemplate } from "./pdf-render.js";

/**
 * Render markdown into a single self-contained HTML file: styling inlined in a
 * `<style>` block, no external requests, opens correctly from a file:// URL or
 * an email attachment.
 */
export function renderMarkdownToHtmlDocument(
  markdown: string,
  opts: { title?: string } = {},
): string {
  const inner = marked.parse(markdown, { gfm: true, breaks: true }) as string;
  // The print template supplies no page padding (the PDF margin does that), so
  // a browser-viewed export needs a centered measure of its own.
  const wrapped = `<div style="max-width:760px;margin:0 auto;padding:56px 32px">${inner}</div>`;
  const html = wrapInPrintTemplate(wrapped);
  return opts.title
    ? html.replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(opts.title)}</title>`,
      )
    : html;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ZipEntry {
  name: string;
  /** Text or binary content. */
  content: string | Uint8Array;
}

/**
 * Bundle several export artifacts into one `.zip` — the "send them the whole
 * thing" path when a deliverable is more than a single file.
 */
export async function zipFiles(entries: ZipEntry[]): Promise<Buffer> {
  if (entries.length === 0) throw new Error("Nothing to zip.");
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.content);
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(bytes);
}
