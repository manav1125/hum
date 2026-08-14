/**
 * Guards the document-editor skill's designed-PDF path:
 *
 * 1. the routing rule (presented artifact → `pdf_create({ html })`) stays in
 *    SKILL.md and keeps pointing at a reference file that exists;
 * 2. the house stylesheet in that reference stays renderable OFFLINE — the PDF
 *    renderer blocks the network, so a remote font or image silently prints as
 *    a blank box;
 * 3. the stylesheet actually produces a PDF (skipped when Chromium is absent).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const SKILL_DIR = join(import.meta.dir, "..");
const SKILL_MD = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf-8");
const REFERENCE_PATH = join(SKILL_DIR, "references", "DESIGNED_PDF.md");
const REFERENCE = readFileSync(REFERENCE_PATH, "utf-8");

/** The `<style>` block the model is told to paste verbatim. */
function houseStylesheet(): string {
  const match = REFERENCE.match(/```html\n(<style>[\s\S]*?<\/style>)\n```/);
  expect(match).not.toBeNull();
  return match![1];
}

/** The markup examples the model composes the page out of. */
function markupExamples(): string {
  return [...REFERENCE.matchAll(/```html\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((block) => !block.startsWith("<style>"))
    .join("\n");
}

describe("routing rule", () => {
  test("SKILL.md routes presented artifacts to pdf_create with html", () => {
    // The decision section must come before the editor's how-to, so the model
    // reads it before it starts creating documents.
    const routing = SKILL_MD.indexOf("which path — editor, or designed PDF?");
    const creating = SKILL_MD.indexOf("## Creating a new document");
    expect(routing).toBeGreaterThan(-1);
    expect(creating).toBeGreaterThan(routing);

    const section = SKILL_MD.slice(routing, creating);
    expect(section).toContain("pdf_create({ html })");
    // The shapes that produced the flat text-only PDF.
    for (const shape of [
      "proposal",
      "one-pager",
      "pitch",
      "brief",
      "invoice",
    ]) {
      expect(section.toLowerCase()).toContain(shape);
    }
    // …and the editor is still the answer for prose.
    expect(section).toContain("document_create");
  });

  test("SKILL.md points at a reference file that exists", () => {
    expect(SKILL_MD).toContain("{baseDir}/references/DESIGNED_PDF.md");
    expect(() => readFileSync(REFERENCE_PATH, "utf-8")).not.toThrow();
  });

  test("SKILL.md forbids fabricated figures on both paths", () => {
    expect(SKILL_MD).toContain("## Numbers you can defend");
    expect(SKILL_MD).toMatch(/never invent|Never invent/);
    expect(SKILL_MD).toContain('class="tbd"');
  });
});

describe("house stylesheet is offline-safe", () => {
  // Whitespace-insensitive: prettier reformats the CSS inside the fence, so
  // assertions match on declarations, not on the file's exact spacing.
  const css = houseStylesheet();
  const flat = css.replace(/\s+/g, "");

  test("references nothing over the network", () => {
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain("@import");
    expect(css).not.toContain("@font-face");
    expect(css).not.toMatch(/url\(/);
  });

  test("every font stack ends in a generic family", () => {
    const stacks = [...flat.matchAll(/--(serif|sans|mono):([^;]+);/g)];
    expect(stacks.length).toBe(3);
    for (const [, name, value] of stacks) {
      const last = value.split(",").pop()!.trim();
      expect([name, last]).toEqual([
        name,
        { serif: "serif", sans: "sans-serif", mono: "monospace" }[name]!,
      ]);
    }
  });

  test("carries no blurred shadows (they rasterize as grey slabs)", () => {
    const shadows = [...flat.matchAll(/box-shadow:([^;}]+)/g)].map((m) => m[1]);
    for (const shadow of shadows) {
      expect(shadow.startsWith("inset")).toBe(true);
    }
  });

  test("is print-shaped, not screen-shaped", () => {
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain(":hover");
    expect(css).not.toContain("<script");
    expect(flat).toContain("print-color-adjust:exact");
  });

  test("declares the tokens and components the skill promises", () => {
    for (const token of [
      "--ink:",
      "--accent:",
      "--paper:",
      "--plate:",
      "--flag:",
    ]) {
      expect(flat).toContain(token);
    }
    for (const cls of [
      ".cover",
      ".sec-num",
      ".stats",
      ".card",
      ".tw",
      "tr.hi",
      ".callout",
      ".step",
      ".tbd",
      "footer",
    ]) {
      expect(flat).toContain(cls);
    }
  });

  test("every block component avoids being sliced across a page", () => {
    for (const cls of [".stats", ".card", ".tw", ".callout", ".step"]) {
      // `${cls}{` so `.card` doesn't match the `.cards` grid wrapper.
      const start = flat.indexOf(`${cls}{`);
      expect([cls, start > -1]).toEqual([cls, true]);
      const rule = flat.slice(start, flat.indexOf("}", start));
      expect([cls, rule.includes("break-inside:avoid")]).toEqual([cls, true]);
    }
  });

  test("markup examples use only classes the stylesheet defines", () => {
    const used = new Set(
      [...markupExamples().matchAll(/class="([^"]+)"/g)].flatMap((m) =>
        m[1].trim().split(/\s+/),
      ),
    );
    expect(used.size).toBeGreaterThan(8);
    for (const cls of used) expect(flat).toContain(`.${cls}`);
  });
});

// Rendering needs Playwright's Chromium; skip rather than fail where the
// browser was never installed (the offline-safety checks above still run).
let chromiumAvailable = false;
try {
  const { chromium } = await import("playwright");
  chromiumAvailable = Boolean(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

describe("house stylesheet renders", () => {
  test.skipIf(!chromiumAvailable)(
    "produces a single-page PDF from the reference components",
    async () => {
      const { renderHtmlToPdf } =
        await import("../../../../documents/pdf-render.js");
      const body = markupExamples();
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>${houseStylesheet()}</head><body>${body}</body></html>`;
      const pdf = await renderHtmlToPdf(html, {
        format: "A4",
        marginIn: 0,
        javascript: false,
      });
      expect(pdf.subarray(0, 5).toString("utf-8")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(10_000);
    },
    120_000,
  );
});
