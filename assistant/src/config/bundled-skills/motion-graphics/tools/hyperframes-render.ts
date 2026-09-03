import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uploadFileBackedAttachment } from "../../../../memory/attachments-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * hyperframes_render — render an agent-authored HyperFrames composition
 * (HTML + GSAP) to an MP4 and return it as an in-chat attachment.
 *
 * This is the inline motion-graphics bridge: Cue's brain authors the
 * composition here, and the render happens in the Cue Design sidecar (which
 * has the bundled `hyperframes` CLI + headless chromium + ffmpeg). The
 * sidecar is reached over the private network at `DESIGN_UPSTREAM_URL`; this
 * is an outbound call to a separate service (not the assistant's own runtime),
 * so it does not go through the gateway's inbound proxy. When design isn't
 * configured for the instance, the tool returns a clear error rather than
 * throwing.
 */

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 180_000;

function designUpstream(): string | null {
  const raw = process.env.DESIGN_UPSTREAM_URL?.trim();
  if (!raw) return null;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function designOrigin(): string {
  const host = process.env.DESIGN_HOST?.trim();
  return host ? `https://${host}` : "https://localhost";
}

export async function run(
  input: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const html = typeof input.html === "string" ? input.html : "";
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : "motion-graphics";

  if (!html.trim()) {
    return {
      content:
        "hyperframes_render needs `html`: a complete HyperFrames composition (a full HTML document with GSAP loaded and window.__timelines registered). See the motion-graphics skill for the composition contract.",
      isError: true,
    };
  }
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    return {
      content: `Composition HTML is too large (max ${Math.round(
        MAX_HTML_BYTES / 1024 / 1024,
      )}MB). Trim inline assets or reference smaller ones.`,
      isError: true,
    };
  }

  const upstream = designUpstream();
  if (!upstream) {
    return {
      content:
        "Cue Design isn't set up on this Cue, so motion-graphics rendering is unavailable. The DESIGN_UPSTREAM_URL for the Cue Design sidecar isn't configured.",
      isError: true,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${upstream}/api/render/hyperframes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: designOrigin(),
      },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return {
      content: aborted
        ? `The motion-graphics render exceeded ${Math.round(
            RENDER_TIMEOUT_MS / 1000,
          )}s. Simplify the composition (fewer frames / shorter duration) and try again.`
        : `Couldn't reach the Cue Design render service: ${(err as Error).message}`,
      isError: true,
    };
  }

  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    return { content: `HyperFrames render failed: ${detail}`, isError: true };
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) {
    return { content: "The render produced an empty video.", isError: true };
  }

  const dir = join(tmpdir(), `cue-hf-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const filename = `${title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "motion-graphics"}.mp4`;
  const outPath = join(dir, filename);
  await writeFile(outPath, bytes);
  const outStat = await stat(outPath);

  const attachment = uploadFileBackedAttachment(
    filename,
    "video/mp4",
    outPath,
    outStat.size,
  );

  return {
    content: JSON.stringify(
      {
        message: "Motion-graphics video rendered.",
        attachmentId: attachment.id,
        filename,
        mimeType: "video/mp4",
        sizeBytes: outStat.size,
        renderer: "cue-design/hyperframes",
        note: res.headers.get("x-hyperframes-note") ?? undefined,
      },
      null,
      2,
    ),
    isError: false,
    attachmentIds: [attachment.id],
  };
}
