/**
 * HTML/markdown → PNG rendering via Playwright headless Chromium.
 *
 * The sibling of `pdf-render.ts` and subject to the same contract: the network
 * is blocked (content must be self-contained), the browser is always closed in
 * `finally`, and JavaScript is off unless a caller opts in.
 *
 * A PNG differs from a PDF in one way that matters — it is rasterized, so the
 * pixel density is a decision rather than a detail. We default to a 2x device
 * scale factor because these images get pasted into Slack, decks and Notion,
 * where a 1x capture of 12px body text is visibly soft.
 */

import { marked } from "marked";

import {
  ensureChromiumHeadlessShell,
  importPlaywright,
} from "../tools/browser/runtime-check.js";
import { wrapInPrintTemplate } from "./pdf-render.js";

/**
 * Chromium refuses to allocate a capture surface beyond 16384px on either
 * axis and fails the screenshot outright rather than cropping. A tall document
 * at 2x scale reaches that ceiling faster than it looks, so the effective
 * budget is checked against `deviceScaleFactor * height`.
 */
const MAX_CAPTURE_PX = 16384;

export interface HtmlPngOptions {
  /** Viewport width in CSS pixels. Default 1000 — a readable prose measure. */
  widthPx?: number;
  /**
   * Viewport height in CSS pixels. Default 1400. Only bounds the capture when
   * `fullPage` is false; otherwise it just seeds the initial layout.
   */
  heightPx?: number;
  /** Pixel density multiplier. Default 2 (retina). Clamped to 1–4. */
  deviceScaleFactor?: number;
  /** Capture the whole scrollable page rather than the viewport. Default true. */
  fullPage?: boolean;
  /**
   * CSS selector for a single element to capture instead of the page — the
   * "export just this chart / table / cover" path.
   */
  selector?: string;
  /** Keep the page background transparent (only useful with transparent CSS). */
  transparent?: boolean;
  /** Enable JavaScript during render. Default false. */
  javascript?: boolean;
  /** Extra settle time after load when JS is enabled (ms, capped at 3000). */
  settleMs?: number;
}

export interface PngResult {
  bytes: Buffer;
  /** Actual raster dimensions, read back off the PNG header. */
  width: number;
  height: number;
}

/**
 * Read the pixel dimensions out of a PNG's IHDR chunk.
 *
 * Cheap, and the only way to state the real output size: the caller asked for
 * CSS pixels, the file is in device pixels, and a `selector` capture is
 * whatever size that element happened to be.
 */
export function readPngDimensions(bytes: Buffer): {
  width: number;
  height: number;
} {
  const isPng =
    bytes.length >= 24 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(4) === 0x0d0a1a0a;
  if (!isPng) throw new Error("Rendered output is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Render a self-contained HTML string to a PNG. Network requests are always
 * blocked — external assets must be inlined or data-URIs.
 */
export async function renderHtmlToPng(
  html: string,
  opts: HtmlPngOptions = {},
): Promise<PngResult> {
  const width = clamp(opts.widthPx ?? 1000, 100, 4000);
  const height = clamp(opts.heightPx ?? 1400, 100, 4000);
  const scale = clamp(opts.deviceScaleFactor ?? 2, 1, 4);

  const pw = await importPlaywright();
  await ensureChromiumHeadlessShell(pw);
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: opts.javascript ?? false,
      viewport: { width, height },
      deviceScaleFactor: scale,
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    if (opts.javascript) {
      const settle = Math.min(3000, Math.max(0, opts.settleMs ?? 300));
      if (settle > 0) await page.waitForTimeout(settle);
    }

    const shot = { type: "png" as const, omitBackground: !!opts.transparent };

    let bytes: Buffer;
    if (opts.selector) {
      const element = page.locator(opts.selector).first();
      if ((await element.count()) === 0) {
        throw new Error(
          `No element matched selector \`${opts.selector}\`. Omit \`selector\` to capture the whole page.`,
        );
      }
      await assertCapturable(
        await element.boundingBox().then((b) => b?.height ?? 0),
        scale,
      );
      bytes = Buffer.from(await element.screenshot(shot));
    } else {
      const fullPage = opts.fullPage ?? true;
      if (fullPage) {
        const contentHeight = await page.evaluate(measureContentHeight);
        await assertCapturable(contentHeight, scale);
        // Playwright's `fullPage` grows the capture to fit tall content but
        // never shrinks it, so a document shorter than the viewport ships with
        // a band of dead white at the bottom — obvious the moment it is pasted
        // into a thread. Shrink the viewport to the content first.
        if (contentHeight > 0 && contentHeight < height) {
          await page.setViewportSize({ width, height: contentHeight });
        }
      }
      bytes = Buffer.from(await page.screenshot({ ...shot, fullPage }));
    }

    return { bytes, ...readPngDimensions(bytes) };
  } finally {
    await browser.close();
  }
}

/**
 * Render markdown to a PNG using the shared document print template, so an
 * image export and a PDF export of the same content look like siblings.
 */
export async function renderMarkdownToPng(
  markdown: string,
  opts: HtmlPngOptions = {},
): Promise<PngResult> {
  const innerHtml = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  }) as string;
  // The print template has no page padding of its own (the PDF margin supplies
  // it), so a screenshot would butt the text against the edge. Pad in a wrapper
  // rather than in the template, which the PDF path shares.
  const padded = `<div style="padding:48px 56px">${innerHtml}</div>`;
  return renderHtmlToPng(wrapInPrintTemplate(padded), opts);
}

/**
 * How tall the content actually is, in CSS pixels.
 *
 * Runs inside the page. `documentElement.scrollHeight` is the obvious choice
 * and the wrong one: it is floored at the viewport height, so a short document
 * always measures as a full screen. `body.scrollHeight` is content-derived,
 * and the child rects catch anything positioned out of body's flow — the max
 * of the three can over-measure (harmless: a slightly taller image) but not
 * under-measure (which would clip the last line off).
 */
function measureContentHeight(): number {
  const body = document.body;
  if (!body) return document.documentElement.scrollHeight;
  const childBottoms = Array.from(body.children).map(
    (el) => el.getBoundingClientRect().bottom + window.scrollY,
  );
  return Math.ceil(
    Math.max(body.scrollHeight, body.offsetHeight, 0, ...childBottoms),
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function assertCapturable(cssHeight: number, scale: number) {
  if (cssHeight * scale > MAX_CAPTURE_PX) {
    throw new Error(
      `Content is too tall to rasterize (${Math.round(cssHeight)}px at ${scale}x exceeds Chromium's ${MAX_CAPTURE_PX}px limit). ` +
        `Lower \`scale\`, capture one element with \`selector\`, or export a PDF instead.`,
    );
  }
}
