/**
 * deck_template_load — return the real HTML skeleton for a Create Studio
 * presentation template so the deck generator can reproduce its look faithfully.
 *
 * WHY THIS TOOL EXISTS (the cloud/sandbox gap it closes):
 * The template skeletons are bundled with the skill under
 *   {skillDir}/templates/presentations/<id>/slide_NN.html
 * i.e. at /app/assistant/.../bundled-skills/app-builder/... on a cloud deploy —
 * which is OUTSIDE the agent's /workspace sandbox. `file_read` is jailed to the
 * workspace (sandboxPolicy → "outside the working directory") and `host_file_read`
 * has no host bridge on a cloud/self-host daemon, so the agent literally cannot
 * read those files by path. It would then fall back to guessing the look from the
 * design-contract text, and the deck wouldn't match the template.
 *
 * This tool runs in-daemon (execution_target: host → in-process), where the
 * bundled files ARE readable, and returns their HTML inline. No path
 * coordination, no host-file dependency — robust for cloud and desktop alike.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getBundledSkillsDir } from "../../../skills.js";

const PRESENTATIONS_SUBPATH = join("app-builder", "templates", "presentations");

function presentationsRoot(): string {
  return join(getBundledSkillsDir(), PRESENTATIONS_SUBPATH);
}

/** Available template ids (directory names under templates/presentations/). */
function listTemplateIds(): string[] {
  const root = presentationsRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

interface SlideMeta {
  title?: string;
  filename?: string;
}

/**
 * Ordered list of `{ n, filename, title }` for a template. Prefers metadata.json
 * (which carries per-slide titles and canonical order); falls back to globbing
 * slide_*.html so a template with a missing/corrupt metadata still loads.
 */
function resolveSlideOrder(
  dir: string,
): Array<{ n: number; filename: string; title?: string }> {
  const metaPath = join(dir, "metadata.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        slides?: Record<string, SlideMeta>;
      };
      const slides = meta.slides ?? {};
      const entries = Object.entries(slides)
        .map(([key, v]) => ({
          n: Number(key),
          filename: v.filename ?? `slide_${key.padStart(2, "0")}.html`,
          title: v.title,
        }))
        .filter((e) => Number.isFinite(e.n))
        .sort((a, b) => a.n - b.n);
      if (entries.length > 0) return entries;
    } catch {
      // fall through to glob
    }
  }
  return readdirSync(dir)
    .filter((f) => /^slide_\d+\.html$/i.test(f))
    .map((filename) => ({
      n: Number(filename.replace(/[^\d]/g, "")),
      filename,
    }))
    .sort((a, b) => a.n - b.n);
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const templateId =
    typeof input.template_id === "string" ? input.template_id.trim() : "";
  if (!templateId) {
    return {
      content: `\`template_id\` is required. Available templates: ${listTemplateIds().join(", ")}.`,
      isError: true,
    };
  }

  // Guard against path traversal — template_id is a single directory name.
  if (templateId.includes("/") || templateId.includes("..")) {
    return {
      content: `Invalid template_id "${templateId}".`,
      isError: true,
    };
  }

  const dir = join(presentationsRoot(), templateId);
  if (!existsSync(dir)) {
    const available = listTemplateIds();
    return {
      content: `No bundled template "${templateId}". Available: ${
        available.length ? available.join(", ") : "(none found)"
      }.`,
      isError: true,
    };
  }

  const order = resolveSlideOrder(dir);
  if (order.length === 0) {
    return {
      content: `Template "${templateId}" has no slide_NN.html files.`,
      isError: true,
    };
  }

  // Optional subset: `slides: [1, 3, 5]` fetches only those slide numbers.
  // Omit to get every slide (templates are small — ~2-3KB/slide).
  let wanted = order;
  const rawSlides = input.slides;
  if (Array.isArray(rawSlides) && rawSlides.length > 0) {
    const want = new Set(
      rawSlides.map((s) => Number(s)).filter(Number.isFinite),
    );
    wanted = order.filter((s) => want.has(s.n));
    if (wanted.length === 0) {
      return {
        content: `None of the requested slide numbers [${rawSlides.join(", ")}] exist in "${templateId}" (it has slides 1–${order.length}).`,
        isError: true,
      };
    }
  }

  const metadataOnly = input.metadata_only === true;

  const parts: string[] = [
    `TEMPLATE "${templateId}" — ${order.length} slides. These are the REAL skeletons (1920×1080, inline <style>). Reproduce this palette, fonts, and per-slide layout with the user's real content; the BRAND block (if any) overrides colors/fonts.`,
    "",
    "Slide index:",
    ...order.map((s) => `  ${s.n}. ${s.title ?? s.filename}`),
  ];

  if (!metadataOnly) {
    for (const s of wanted) {
      const filePath = join(dir, s.filename);
      let html: string;
      try {
        html = readFileSync(filePath, "utf-8");
      } catch (err) {
        html = `<!-- could not read ${s.filename}: ${(err as Error).message} -->`;
      }
      parts.push(
        "",
        `----- SLIDE ${s.n}: ${s.title ?? s.filename} (${s.filename}) -----`,
        html,
      );
    }
    parts.push(
      "",
      "Note: demo <img src> references were intentionally not bundled — swap them for the user's real assets or drop the images.",
    );
  }

  return {
    content: parts.join("\n"),
    isError: false,
  };
}
