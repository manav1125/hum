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

const FONT_STACK = `"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

export function wrapInPrintTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: ${FONT_STACK};
    font-size: 14px;
    line-height: 1.7;
    color: #1a1a1a;
    background: #ffffff;
    padding: 0;
  }

  h1 { font-size: 28px; font-weight: 600; margin-top: 32px; margin-bottom: 12px; }
  h2 { font-size: 22px; font-weight: 600; margin-top: 28px; margin-bottom: 10px; }
  h3 { font-size: 18px; font-weight: 600; margin-top: 24px; margin-bottom: 8px; }
  h4, h5, h6 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }

  p {
    margin-bottom: 12px;
  }

  pre {
    background: #f5f5f5;
    border-radius: 8px;
    padding: 12px 16px;
    overflow-x: auto;
    margin-bottom: 12px;
  }

  code {
    font-family: "DM Mono", "SF Mono", monospace;
    font-size: 13px;
    background: #f5f5f5;
    border-radius: 4px;
    padding: 2px 5px;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  blockquote {
    border-left: 3px solid #6366f1;
    padding-left: 16px;
    margin: 12px 0;
    color: #555555;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
  }

  th, td {
    border: 1px solid #e0e0e0;
    padding: 8px 12px;
    text-align: left;
  }

  th {
    background: #f5f5f5;
    font-weight: 600;
  }

  ul, ol {
    margin: 12px 0;
    padding-left: 24px;
  }

  li {
    margin-bottom: 4px;
  }

  a {
    color: #6366f1;
    text-decoration: none;
  }

  hr {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 24px 0;
  }

  img {
    max-width: 100%;
    height: auto;
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
