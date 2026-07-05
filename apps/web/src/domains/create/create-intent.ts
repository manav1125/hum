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
  getStyleSpec,
  getTemplateSpec,
  type StyleSpec,
  type TemplateSpec,
} from "./studio-specs";

/** The structured selection carried with a Create generation. */
export interface CreateIntent {
  /** slides | image | video | data | docs | … */
  mode: string;
  /** Resolves a TemplateSpec (slides / dashboards / docs). */
  templateId?: string;
  /** Resolves a StyleSpec (image / video). */
  styleId?: string;
  /** Data mode — chart types to include. */
  chartTypes?: string[];
  /** Active brand kit id, or null to generate un-branded. */
  brandKitId?: string | null;
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

function styleContract(s: StyleSpec): string {
  return `STYLE — apply the "${s.label}" style: ${s.promptFragment}${
    s.model ? ` (prefer model: ${s.model})` : ""
  }.`;
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

  const style = intent.styleId ? getStyleSpec(intent.styleId) : undefined;
  if (style) blocks.push(styleContract(style));

  if (intent.chartTypes?.length) {
    blocks.push(`CHARTS — include these chart types: ${intent.chartTypes.join(", ")}.`);
  }

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
