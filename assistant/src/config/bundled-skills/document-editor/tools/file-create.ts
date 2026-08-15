/**
 * file_create — build a standalone file (PNG, HTML, Markdown, Word, Excel)
 * from markdown or self-contained HTML and deliver it as an in-chat
 * attachment. The non-PDF sibling of `pdf_create`.
 *
 * The `html` input only makes sense for the formats that are, or can be
 * rasterized from, a rendered page — `png` and `html`. Word and Excel want
 * structure, not a picture of one, so those formats take `markdown`; that
 * restriction is enforced here rather than silently producing a document with
 * a screenshot pasted into it.
 */

import {
  extensionFor,
  isExportFormat,
  mimeFor,
  renderMarkdownAs,
  sanitizeFilename,
} from "../../../../documents/export-delivery.js";
import { renderHtmlToPng } from "../../../../documents/png-render.js";
import { uploadAttachmentFromBytes } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** `pdf_create` owns PDF; offering it here too would only split the routing. */
const SUPPORTED = ["png", "html", "markdown", "docx", "xlsx"] as const;

/** Formats that need the markdown structure, not a rendered page. */
const MARKDOWN_ONLY = new Set(["docx", "xlsx", "markdown"]);

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const markdown =
    typeof input.markdown === "string" ? input.markdown : undefined;
  const html = typeof input.html === "string" ? input.html : undefined;
  const format = input.format;

  if (!title) {
    return { content: "Provide a `title` for the file.", isError: true };
  }
  if (!isExportFormat(format) || !SUPPORTED.includes(format as never)) {
    return {
      content: `Provide a \`format\`: one of ${SUPPORTED.join(", ")}. For a PDF use pdf_create.`,
      isError: true,
    };
  }
  if ((markdown ? 1 : 0) + (html ? 1 : 0) !== 1) {
    return {
      content: "Provide exactly ONE of `markdown` or `html` as the content.",
      isError: true,
    };
  }
  if (html && MARKDOWN_ONLY.has(format)) {
    return {
      content: `\`${format}\` needs \`markdown\` — it is built from the document's structure (headings, lists, tables), not from rendered HTML. Pass the content as markdown, or choose png/html.`,
      isError: true,
    };
  }

  const content = markdown ?? html ?? "";
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return {
      content: "Content too large (max 2 MB). Split it into smaller files.",
      isError: true,
    };
  }

  const selector =
    typeof input.selector === "string" ? input.selector : undefined;
  const scale = typeof input.scale === "number" ? input.scale : undefined;
  const widthPx =
    typeof input.width_px === "number" ? input.width_px : undefined;

  try {
    let bytes: Buffer;
    let detail: Record<string, unknown> = {};

    if (html) {
      if (format === "html") {
        bytes = Buffer.from(html, "utf8");
      } else {
        const png = await renderHtmlToPng(html, {
          selector,
          deviceScaleFactor: scale,
          widthPx,
        });
        bytes = png.bytes;
        detail = { width: png.width, height: png.height };
      }
    } else {
      const rendered = await renderMarkdownAs(format, markdown!, {
        title,
        selector,
        scale,
        widthPx,
      });
      bytes = rendered.bytes;
      detail = rendered.detail;
    }

    const filename = `${sanitizeFilename(title, "file")}.${extensionFor(format)}`;
    const attachment = uploadAttachmentFromBytes(
      filename,
      mimeFor(format),
      new Uint8Array(bytes),
    );
    return {
      content: JSON.stringify({
        message: `${format.toUpperCase()} created.`,
        attachmentId: attachment.id,
        filename,
        format,
        sizeBytes: bytes.length,
        ...detail,
      }),
      isError: false,
      // Typed side channel: lets the daemon link the stored attachment onto
      // the assistant message row so history reloads return it.
      attachmentIds: [attachment.id],
    };
  } catch (err) {
    return {
      content: `${String(format).toUpperCase()} creation failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
