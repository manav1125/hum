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
 * design_export — bring a Cue Design artifact back into Cue as a first-class
 * attachment, so it can be attached to an email, saved, or shared. This is the
 * return half of the chat ⇄ Design loop: `design_handoff` sends work OUT to the
 * studio; this pulls the finished artifact back IN.
 *
 * Exports the project's page/prototype as a self-contained HTML file via the
 * sidecar's export API (reached over the private network at DESIGN_UPSTREAM_URL,
 * same outbound pattern as the other bridges), then registers it as a Cue
 * attachment. Deck/slide PDF export needs a server-side render that isn't wired
 * yet — for now this brings back the HTML artifact.
 */

function designUpstream(): string | null {
  const raw = process.env.DESIGN_UPSTREAM_URL?.trim();
  if (!raw) return null;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function designOrigin(): string {
  const host = process.env.DESIGN_HOST?.trim();
  return host ? `https://${host}` : "https://localhost";
}

/** Resolve the target project: an explicit id, or the most recently updated. */
async function resolveProject(
  upstream: string,
  requested: string | undefined,
): Promise<{ id: string; name: string } | { error: string }> {
  const origin = designOrigin();
  if (
    requested &&
    requested.trim() &&
    requested.trim().toLowerCase() !== "latest"
  ) {
    return { id: requested.trim(), name: requested.trim() };
  }
  const r = await fetch(`${upstream}/api/projects`, {
    headers: { origin },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok)
    return { error: `couldn't list design projects (status ${r.status})` };
  const body = (await r.json()) as unknown;
  const list =
    (Array.isArray(body)
      ? body
      : (body as { projects?: unknown[] }).projects) ?? [];
  const projects = list
    .filter((p): p is { id: string; name?: string; updatedAt?: number } =>
      Boolean(p && typeof (p as { id?: unknown }).id === "string"),
    )
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (projects.length === 0) {
    return { error: "there are no Cue Design projects yet" };
  }
  return { id: projects[0]!.id, name: projects[0]!.name ?? projects[0]!.id };
}

export async function run(
  input: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const upstream = designUpstream();
  if (!upstream) {
    return {
      content:
        "Cue Design isn't set up on this Cue, so there's nothing to export. The DESIGN_UPSTREAM_URL for the sidecar isn't configured.",
      isError: true,
    };
  }

  const requestedId =
    typeof input.projectId === "string" ? input.projectId : undefined;
  const fileName =
    typeof input.fileName === "string" && input.fileName.trim()
      ? input.fileName.trim()
      : "index.html";

  const resolved = await resolveProject(upstream, requestedId).catch((err) => ({
    error: `couldn't reach Cue Design: ${(err as Error).message}`,
  }));
  if ("error" in resolved) {
    return {
      content: `Couldn't find the design project — ${resolved.error}.`,
      isError: true,
    };
  }

  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : resolved.name;
  const format = input.format === "html" ? "html" : "pdf"; // default pdf

  // Both formats start from the sidecar's self-contained HTML export.
  let htmlRes: Response;
  try {
    htmlRes = await fetch(
      `${upstream}/api/projects/${encodeURIComponent(resolved.id)}/export/html`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: designOrigin() },
        body: JSON.stringify({ fileName, title }),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch (err) {
    return {
      content: `Couldn't export the design project: ${(err as Error).message}`,
      isError: true,
    };
  }
  if (!htmlRes.ok) {
    let detail = `status ${htmlRes.status}`;
    try {
      const body = (await htmlRes.json()) as { error?: unknown };
      if (body?.error) detail = JSON.stringify(body.error);
    } catch {
      /* non-JSON */
    }
    return { content: `Export failed: ${detail}`, isError: true };
  }
  const html = await htmlRes.text();
  if (!html.trim()) {
    return { content: "The export produced an empty file.", isError: true };
  }

  let bytes: Buffer;
  let mimeType: string;
  let ext: string;
  if (format === "pdf") {
    // Render the bundled HTML to a PDF in the sidecar (chromium print-to-pdf).
    let pdfRes: Response;
    try {
      pdfRes = await fetch(`${upstream}/api/render/pdf`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: designOrigin() },
        body: JSON.stringify({ html }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      return {
        content: `Couldn't render the PDF: ${(err as Error).message}`,
        isError: true,
      };
    }
    if (!pdfRes.ok) {
      let detail = `status ${pdfRes.status}`;
      try {
        const body = (await pdfRes.json()) as { error?: unknown };
        if (body?.error) detail = JSON.stringify(body.error);
      } catch {
        /* non-JSON */
      }
      return { content: `PDF render failed: ${detail}`, isError: true };
    }
    bytes = Buffer.from(await pdfRes.arrayBuffer());
    mimeType = "application/pdf";
    ext = "pdf";
  } else {
    bytes = Buffer.from(html, "utf8");
    mimeType = "text/html";
    ext = "html";
  }

  if (bytes.length === 0) {
    return { content: "The export produced an empty file.", isError: true };
  }

  const dir = join(tmpdir(), `cue-design-export-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const safeTitle =
    title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "design";
  const outName = `${safeTitle}.${ext}`;
  const outPath = join(dir, outName);
  await writeFile(outPath, bytes);
  const outStat = await stat(outPath);

  const attachment = uploadFileBackedAttachment(
    outName,
    mimeType,
    outPath,
    outStat.size,
  );

  return {
    content: JSON.stringify(
      {
        message:
          "Brought the Cue Design artifact into Cue as an attachment — it can now be attached to an email, saved, or shared.",
        attachmentId: attachment.id,
        projectId: resolved.id,
        projectName: resolved.name,
        filename: outName,
        mimeType,
        sizeBytes: outStat.size,
      },
      null,
      2,
    ),
    isError: false,
    attachmentIds: [attachment.id],
  };
}
