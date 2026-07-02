/**
 * deck_export_pdf — render a slide-deck app (or raw deck HTML) to a 16:9 PDF
 * attachment. The share/send half of deck building: the deck lives in the
 * Library as an app; this prints it one slide per page via the print
 * contract documented in references/SLIDES.md.
 */

import { renderHtmlToPdf } from "../../../../documents/pdf-render.js";
import {
  getApp,
  getAppDirPath,
  inlineDistAssets,
  resolveEffectiveAppHtml,
} from "../../../../memory/app-store.js";
import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function sanitizeFilename(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "deck"
  );
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const appId = typeof input.app_id === "string" ? input.app_id.trim() : "";
  const rawHtml = typeof input.html === "string" ? input.html : "";
  if ((appId ? 1 : 0) + (rawHtml ? 1 : 0) !== 1) {
    return {
      content:
        "Provide exactly ONE of `app_id` (a deck app from the Library) or `html` (a self-contained deck).",
      isError: true,
    };
  }

  let html = rawHtml;
  let title =
    typeof input.output_title === "string" && input.output_title.trim()
      ? input.output_title.trim()
      : "deck";
  if (appId) {
    const app = getApp(appId);
    if (!app) {
      return { content: `App not found: ${appId}`, isError: true };
    }
    title =
      typeof input.output_title === "string" && input.output_title.trim()
        ? input.output_title.trim()
        : app.name;
    try {
      html = resolveEffectiveAppHtml(app);
      html = inlineDistAssets(getAppDirPath(appId), html);
    } catch (err) {
      return {
        content: `Could not resolve the deck's HTML (try app_refresh first): ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  const widthPx =
    typeof input.width_px === "number" && input.width_px >= 320
      ? Math.round(input.width_px)
      : 1280;
  const heightPx =
    typeof input.height_px === "number" && input.height_px >= 180
      ? Math.round(input.height_px)
      : 720;

  try {
    const pdf = await renderHtmlToPdf(html, {
      widthPx,
      heightPx,
      marginIn: 0,
      javascript: true,
      settleMs: 800,
    });
    const filename = `${sanitizeFilename(title)}.pdf`;
    const attachment = uploadAttachmentFromBytes(
      filename,
      "application/pdf",
      new Uint8Array(pdf),
    );

    // A one-page PDF for a deck almost always means the print contract is
    // missing (slides stacked or hidden in print media). Surface the hint so
    // the model can fix the deck via app_update and retry.
    const suspiciouslyShort = pdf.length < 20_000;
    return {
      content: JSON.stringify({
        message: "Deck exported as PDF.",
        attachmentId: attachment.id,
        filename,
        sizeBytes: pdf.length,
        dimensions: `${widthPx}x${heightPx}`,
        ...(suspiciouslyShort
          ? {
              note: "The PDF looks very small — the deck may be missing the print contract from SLIDES.md (each .slide needs display:block + page-break-after:always under @media print, and @page { size: 1280px 720px; margin: 0 }). Add it with app_update and export again.",
            }
          : {}),
      }),
      isError: false,
    };
  } catch (err) {
    return {
      content: `Deck export failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
