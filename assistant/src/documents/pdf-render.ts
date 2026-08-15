/**
 * Shared HTML/markdown → PDF rendering via Playwright headless Chromium.
 *
 * One render path for every PDF producer: the documents route, the
 * document-editor export tools, and app-builder's deck export. Network is
 * always blocked (content must be self-contained), the browser is always
 * closed in `finally`, and JavaScript is off unless a caller opts in (decks
 * need it to lay out slides before printing).
 */

import { marked } from "marked";

import {
  ensureChromiumHeadlessShell,
  importPlaywright,
} from "../tools/browser/runtime-check.js";

// ---------------------------------------------------------------------------
// Print template (documents)
// ---------------------------------------------------------------------------

/**
 * The document print stylesheet — the plain-prose half of the house style
 * described in `document-editor/references/DESIGNED_PDF.md`. Same tokens, same
 * serif/sans/mono pairing, but it has to land on bare markdown output (`h1`,
 * `table`, `blockquote`…) rather than on composed components, so every rule
 * hangs off an element selector.
 *
 * Constraints inherited from the renderer: the network is blocked, so no
 * `@font-face` and no `@import` — every stack ends in a generic family, because
 * on the prod container the only faces installed are FreeSerif/FreeSans/
 * FreeMono. Chromium rasterizes blurred `box-shadow` into flat grey slabs, so
 * surfaces take their definition from a 1px border instead of a fill.
 */
export function wrapInPrintTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --ink: #1a2230;
    --ink-2: #4a5568;
    --ink-3: #6b7688;
    --card: #ffffff;
    --line: #e1e6ef;
    --line-2: #edf0f6;
    --accent: #3d6ee8;
    --serif: Georgia, "Times New Roman", "Liberation Serif", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "Liberation Sans", sans-serif;
    --mono: ui-monospace, "SF Mono", "DejaVu Sans Mono", "Liberation Mono", Consolas, monospace;
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }

  body {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.65;
    color: var(--ink);
    background: var(--card);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Headings — serif for the titles, sans semibold for block headings. */
  h1, h2, h3, h4, h5, h6 {
    text-wrap: balance;
    break-after: avoid;
    break-inside: avoid;
  }

  h1 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
    letter-spacing: -0.015em;
    margin: 30px 0 12px;
  }

  h2 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.15;
    letter-spacing: -0.01em;
    margin: 28px 0 10px;
  }

  h3 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 24px 0 6px;
  }

  h4, h5, h6 {
    font-size: 12px;
    font-weight: 600;
    margin: 20px 0 6px;
  }

  h6 { color: var(--ink-2); }

  body > :first-child { margin-top: 0; }

  p { margin: 10px 0; }
  strong { font-weight: 600; }

  a {
    color: var(--accent);
    text-decoration: none;
  }

  ul, ol {
    margin: 10px 0;
    padding-left: 22px;
  }

  li { margin: 4px 0; }
  li::marker { color: var(--ink-3); }

  /* Code — bordered, never a grey slab, and wrapped so nothing clips off the
     page (a PDF has no horizontal scrollbar). */
  pre {
    font-size: 10.5px;
    line-height: 1.55;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 16px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    break-inside: avoid;
  }

  code {
    font-family: var(--mono);
    font-size: 0.92em;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 4px;
  }

  pre code {
    font-size: inherit;
    border: none;
    border-radius: 0;
    padding: 0;
  }

  /* Blockquote reads as the house callout. */
  blockquote {
    background: var(--card);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 0 10px 10px 0;
    padding: 12px 16px;
    margin: 16px 0;
    color: var(--ink-2);
    break-inside: avoid;
  }

  blockquote > :first-child { margin-top: 0; }
  blockquote > :last-child { margin-bottom: 0; }

  /* Tables — a bordered surface with mono headers. Separated borders keep the
     rounded corners that border-collapse would square off. */
  table {
    width: 100%;
    font-size: 11px;
    border: 1px solid var(--line);
    border-radius: 10px;
    border-collapse: separate;
    border-spacing: 0;
    margin: 18px 0;
    break-inside: avoid;
  }

  /* A table longer than the page has to break somewhere — but never through
     the middle of a row. */
  tr { break-inside: avoid; }

  th, td {
    text-align: left;
    vertical-align: top;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line-2);
  }

  thead th {
    font-family: var(--mono);
    font-size: 8.5px;
    font-weight: 500;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--ink-3);
    border-bottom: 1px solid var(--line);
  }

  tbody tr:last-child td { border-bottom: none; }

  /* A right-aligned markdown column is a figure column by convention: mono and
     tabular so the digits stack. */
  td { font-variant-numeric: tabular-nums; }

  td[align="right"] {
    text-align: right;
    font-family: var(--mono);
    font-size: 10.5px;
  }

  th[align="right"] {
    text-align: right;
    white-space: nowrap;
  }

  td[align="center"], th[align="center"] { text-align: center; }

  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 26px 0;
  }

  img {
    max-width: 100%;
    height: auto;
    break-inside: avoid;
  }

</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HtmlPdfOptions {
  /** Standard paper size. Ignored when widthPx/heightPx are provided. */
  format?: "A4" | "Letter";
  /** Custom page width in CSS pixels (e.g. 1280 for a 16:9 deck). */
  widthPx?: number;
  /** Custom page height in CSS pixels (e.g. 720 for a 16:9 deck). */
  heightPx?: number;
  landscape?: boolean;
  /** Uniform margin in inches. Default 0.75; decks pass 0. */
  marginIn?: number;
  /** Enable JavaScript during render (decks lay themselves out). Default false. */
  javascript?: boolean;
  /** Extra settle time after load when JS is enabled (ms, capped at 3000). */
  settleMs?: number;
}

/**
 * Render a self-contained HTML string to a PDF buffer. Network requests are
 * always blocked — external assets must be inlined or data-URIs.
 */
export async function renderHtmlToPdf(
  html: string,
  opts: HtmlPdfOptions = {},
): Promise<Buffer> {
  const pw = await importPlaywright();
  await ensureChromiumHeadlessShell(pw);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: opts.javascript ?? false,
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    if (opts.javascript) {
      const settle = Math.min(3000, Math.max(0, opts.settleMs ?? 300));
      if (settle > 0) await page.waitForTimeout(settle);
    }

    const margin = `${opts.marginIn ?? 0.75}in`;
    const sizing =
      opts.widthPx != null && opts.heightPx != null
        ? { width: `${opts.widthPx}px`, height: `${opts.heightPx}px` }
        : { format: opts.format ?? "A4" };

    const pdfBuffer = await page.pdf({
      ...sizing,
      landscape: opts.landscape ?? false,
      margin: { top: margin, bottom: margin, left: margin, right: margin },
      printBackground: true,
      preferCSSPageSize: opts.widthPx != null,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

/**
 * Convert a markdown string to a PDF buffer using the document print
 * template. The `title` parameter is accepted for parity with callers that
 * name their export; the rendered content is the markdown itself.
 */
export async function renderMarkdownToPDF(
  _title: string,
  markdown: string,
): Promise<Buffer> {
  const innerHtml = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  }) as string;
  return renderHtmlToPdf(wrapInPrintTemplate(innerHtml), {
    format: "A4",
    marginIn: 0.75,
    javascript: false,
  });
}
