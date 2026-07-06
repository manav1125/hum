/**
 * Create Studio — the generation bridge.
 *
 * A `CreateIntent` is the structured selection a user makes in the gallery
 * (a template, a style, a brand kit) that rides alongside their typed prompt.
 * Rather than embedding the choice as loose prose the backend must re-parse
 * (Mira's approach), we compile the selected `TemplateSpec` + active brand +
 * `StyleSpec` into an explicit **design contract** — a compact directive block
 * prepended to the seeded prompt that the `app-builder` / `document-editor` /
 * `replicate` skills honor verbatim (palette hexes, fonts, layout rhythm,
 * brand voice, logo, and — for pixel-faithful decks — the bundled HTML path).
 *
 * This module is pure and UI-agnostic: the (design-gated) gallery UI calls
 * `compileCreateIntent()` and includes the result in the prompt it seeds. No
 * generation happens here.
 */

import {
  getDataFormatSpec,
  getDocTypeSpec,
  getStyleSpec,
  getTemplateSpec,
  type DataFormatSpec,
  type DocTypeSpec,
  type StyleSpec,
  type TemplateSpec,
} from "./studio-specs";

/**
 * A per-generation style reference — "make it look like this". The user drops
 * ONE image or pastes a URL to borrow its look for a single generation. This is
 * DISTINCT from the saved Brand Kit (`brandKitId`): the reference styles this
 * one output only and never mutates the stored brand.
 */
export interface CreateReference {
  /** Whether the reference is a dropped/uploaded image or a pasted URL. */
  kind: "image" | "url";
  /**
   * The reference itself — an image URL / data-URI / object-URL for `image`,
   * or the pasted page/asset URL for `url`. The compiler names it verbatim in
   * the REFERENCE contract line so the skill can fetch or attach it.
   */
  ref: string;
}

/** The structured selection carried with a Create generation. */
export interface CreateIntent {
  /** slides | image | video | data | docs | … */
  mode: string;
  /** Resolves a TemplateSpec (slides / dashboards) or a DocTypeSpec (docs). */
  templateId?: string;
  /** Resolves a StyleSpec (image / video). */
  styleId?: string;
  /** Data mode — output format (dashboard / report / sheet / slides). */
  formatId?: string;
  /** Data mode — chart types to include. */
  chartTypes?: string[];
  /** Active brand kit id, or null to generate un-branded. */
  brandKitId?: string | null;
  /**
   * A per-generation style reference to match ("make it look like this"). One
   * image or URL, applied to THIS output only — separate from `brandKitId`.
   */
  reference?: CreateReference;
}

/**
 * The subset of a stored Brand Profile the contract compiler consumes. Mirrors
 * the daemon `BrandProfile` (assistant/src/brand) loosely on purpose — the
 * frontend gets the full typed shape from the generated SDK once the brand
 * routes are in the spec; this keeps the compiler decoupled from that.
 */
export interface BrandProfileLike {
  name?: string;
  palette?: Partial<{
    primary: string;
    accent: string;
    bg: string;
    surface: string;
    text: string;
    muted: string;
  }>;
  fonts?: Partial<{ heading: string; body: string }>;
  logo?: Partial<{ light: string; dark: string; mark: string }>;
  voice?: Partial<{
    tone: string;
    doList: string[];
    dontList: string[];
    boilerplate: string;
  }>;
}

function templateContract(t: TemplateSpec): string {
  const p = t.palette;
  const lines = [
    `DESIGN CONTRACT — render in the "${t.name}" template look:`,
    `- Palette: primary ${p.primary}, accent ${p.accent}, background ${p.bg}, surface ${p.surface}, text ${p.text}.`,
    `- Fonts: headings ${t.fonts.heading}; body ${t.fonts.body}.`,
    `- Layout rhythm: ${t.layoutRhythm.join(" → ")}.`,
    `- Cover: ${t.coverTreatment}.`,
  ];
  // Pixel-faithful path: the real HTML skeleton is bundled with the skill.
  if (t.fidelity !== "contract" && t.sourceHtmlDir) {
    lines.push(
      `- An exact HTML template is bundled at templates/presentations/${t.sourceHtmlDir} (per references/TEMPLATES.md). For a faithful reproduction, load those slides and fill them with the real content below; otherwise generate fresh slides that inherit the palette/fonts/rhythm above.`,
    );
  }
  return lines.join("\n");
}

function brandContract(b: BrandProfileLike): string {
  const lines: string[] = [
    `BRAND — apply ${b.name ? `"${b.name}"` : "the active brand"} to everything (it OVERRIDES the template's default colors/fonts where they conflict):`,
  ];
  const p = b.palette;
  if (p && (p.primary || p.accent || p.bg || p.text)) {
    const parts = [
      p.primary && `primary ${p.primary}`,
      p.accent && `accent ${p.accent}`,
      p.bg && `background ${p.bg}`,
      p.surface && `surface ${p.surface}`,
      p.text && `text ${p.text}`,
    ].filter(Boolean);
    lines.push(`- Brand palette: ${parts.join(", ")}.`);
  }
  if (b.fonts?.heading || b.fonts?.body) {
    lines.push(
      `- Brand fonts: ${[b.fonts?.heading && `headings ${b.fonts.heading}`, b.fonts?.body && `body ${b.fonts.body}`].filter(Boolean).join("; ")}.`,
    );
  }
  const logo = b.logo?.light || b.logo?.dark || b.logo?.mark;
  if (logo) lines.push(`- Place the brand logo on the cover/closing slides (asset: ${logo}).`);
  if (b.voice?.tone) lines.push(`- Voice: write all copy in a ${b.voice.tone} tone.`);
  if (b.voice?.doList?.length) lines.push(`- Do: ${b.voice.doList.join("; ")}.`);
  if (b.voice?.dontList?.length) lines.push(`- Don't: ${b.voice.dontList.join("; ")}.`);
  if (b.voice?.boilerplate) lines.push(`- Boilerplate to weave in where fitting: "${b.voice.boilerplate}".`);
  return lines.join("\n");
}

function docTypeContract(d: DocTypeSpec): string {
  return `DOCUMENT — write a "${d.name}" (${d.description}) with these sections, in order: ${d.outline.join(" → ")}.`;
}

function dataFormatContract(f: DataFormatSpec): string {
  return `OUTPUT — produce a ${f.label}: ${f.description}`;
}

function styleContract(s: StyleSpec): string {
  return `STYLE — apply the "${s.label}" style: ${s.promptFragment}${
    s.model ? ` (prefer model: ${s.model})` : ""
  }.`;
}

function referenceContract(r: CreateReference): string {
  const source =
    r.kind === "url"
      ? `the reference at this URL: ${r.ref}`
      : `the attached reference: ${r.ref}`;
  return `REFERENCE — match the look of ${source} (borrow its palette, composition, and mood for THIS generation only; it does not change the saved brand).`;
}

/**
 * Compile a `CreateIntent` (+ the active brand) into the design-contract
 * preamble to prepend to the user's prompt. Returns "" when nothing is
 * selected, so an un-decorated prompt passes through untouched.
 */
export function compileCreateIntent(
  intent: CreateIntent | null | undefined,
  brand?: BrandProfileLike | null,
): string {
  if (!intent) return "";
  const blocks: string[] = [];

  const template = intent.templateId
    ? getTemplateSpec(intent.templateId)
    : undefined;
  if (template) blocks.push(templateContract(template));

  // Docs mode parks a DocTypeSpec id in `templateId` (per studio-specs). When
  // the slide-template lookup misses, resolve it as a doc type so the chosen
  // document shape + outline actually reach the seeded prompt.
  if (!template && intent.templateId) {
    const docType = getDocTypeSpec(intent.templateId);
    if (docType) blocks.push(docTypeContract(docType));
  }

  const style = intent.styleId ? getStyleSpec(intent.styleId) : undefined;
  if (style) blocks.push(styleContract(style));

  // Data mode — the picked output format rides ahead of the chart list.
  const format = intent.formatId
    ? getDataFormatSpec(intent.formatId)
    : undefined;
  if (format) blocks.push(dataFormatContract(format));

  if (intent.chartTypes?.length) {
    blocks.push(`CHARTS — include these chart types: ${intent.chartTypes.join(", ")}.`);
  }

  if (intent.reference?.ref) blocks.push(referenceContract(intent.reference));

  if (intent.brandKitId && brand) blocks.push(brandContract(brand));

  return blocks.join("\n\n");
}

/**
 * Prepend the compiled contract to a user prompt. The contract goes first so
 * the skill reads the constraints before the ask; the user's words remain the
 * primary instruction.
 */
export function applyCreateIntent(
  prompt: string,
  intent: CreateIntent | null | undefined,
  brand?: BrandProfileLike | null,
): string {
  const contract = compileCreateIntent(intent, brand);
  if (!contract) return prompt;
  return `${contract}\n\n---\n\n${prompt}`;
}
