/**
 * Create view — the "What do you want to get done?" entry point.
 *
 * A mode picker (Slides / Dashboards / Docs / Research / Images / Canvas /
 * Video). Each mode surfaces TWO sections:
 *
 *   1. **Templates** — structured-input forms (create-form-templates.ts). Pick
 *      one to open its detail form, fill typed fields, and on submit the values
 *      compose into a skill-targeted prompt.
 *   2. **Quick start** — one-tap prefilled prompts (create-templates.ts) that
 *      seed a thread directly.
 *
 * Both paths route through `onRunPrompt`, which seeds a brand-new chat thread
 * via the standard `?prompt=` auto-send path so the backing skill actually runs
 * and produces the asset.
 *
 * Restyled to the shipped HQ design language (Cue-Surfaces S1): serif hero,
 * DM Mono microlabels, one-card anatomy with a field-count chip, a
 * source-hint ⟡ tag naming the backing skill, and the theme-aware `C.*` tokens
 * so light + dark both render from the shared `--mv1-*` system.
 */

import { ArrowUpRight, ImagePlus, LayoutGrid, Link2, Send, X } from "lucide-react";
import { useRef, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  CREATE_MODES,
  type CreateMode,
  type CreateTemplate,
} from "@/domains/create/create-templates";
import { templateNeedsElicitation } from "@/domains/create/create-elicit";
import { TemplateElicitForm } from "@/domains/create/create-elicit-form";
import {
  type TemplateDefinition,
  findTemplate,
  templatesForMode,
} from "@/domains/create/create-form-templates";
import { CreateTemplateForm } from "@/domains/create/create-template-form";
import {
  CreatePreview,
  previewForTemplate,
} from "@/domains/create/create-previews";
import {
  CreateGalleryOverlay,
  type GallerySelection,
} from "@/domains/create/create-gallery-overlay";
import {
  applyCreateIntent,
  type CreateIntent,
  type CreateReference,
} from "@/domains/create/create-intent";
import { getCanvasActionSpec } from "@/domains/create/studio-specs";
import { useActiveBrand } from "@/domains/create/use-active-brand";

/** Modes that have a gallery variant (drives the "Browse …" affordance). */
const GALLERY_MODES = new Set([
  "slides",
  "images",
  "video",
  "data",
  "docs",
  "canvas",
]);

/** Per-mode label for the "Browse …" entry-point button. */
function browseLabel(modeId: string): string {
  switch (modeId) {
    case "images":
    case "video":
      return "Browse styles";
    case "data":
      return "Output & charts";
    case "docs":
      return "Browse documents";
    case "canvas":
      return "Choose an action";
    default:
      return "Browse templates";
  }
}

/** The short chip label + icon glyph for a confirmed gallery selection. */
function selectionChipText(sel: GallerySelection): string {
  if (sel.styleId) return `Style: ${sel.label.replace(/"/g, "")}`;
  if (sel.formatId) return sel.label; // "Dashboard · 2 charts"
  if (sel.actionId) return `Canvas: ${sel.label.replace(/"/g, "")}`;
  return `Template: ${sel.label.replace(/"/g, "")}`;
}

/** Compile a confirmed gallery selection into a CreateIntent. */
function selectionToIntent(
  sel: GallerySelection,
  brandKitId: string | null,
  reference: CreateReference | null,
): CreateIntent {
  return {
    mode: sel.mode,
    templateId: sel.templateId,
    styleId: sel.styleId,
    formatId: sel.formatId,
    chartTypes: sel.chartTypes,
    brandKitId: sel.inBrand ? brandKitId : null,
    reference: reference ?? undefined,
  };
}

// Theme-aware tokens for the HQ design language. These point at the shipped
// `--mv1-*` CSS-variable system (src/index.css) — the same tokens the HQ /
// Projects surfaces ride — so light + dark both resolve correctly. Defined
// locally (rather than imported from domains/activity) to respect the
// cross-domain-import boundary; the CSS-var contract is the shared surface.
const C = {
  ink: "var(--mv1-t1)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blue: "var(--mv1-blue)",
  blueS: "var(--mv1-blue-strong)",
  line: "var(--mv1-line)",
  surface: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
} as const;
const mono = "'DM Mono', ui-monospace, monospace";
const serif = "'Instrument Serif', Georgia, serif";

const microLabel = {
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase" as const,
  color: C.t3,
};

/** ⟡ source-hint tag — mirrors the HQ MissionTag anatomy (blue wash). */
function SourceTag({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: C.blueS,
        background: `color-mix(in srgb, ${C.blue} 13%, transparent)`,
        borderRadius: 7,
        padding: "4px 9px",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>⟡</span>
      {label}
    </span>
  );
}

/**
 * The card's provenance chip (S1). A `{ files }` hint files onto a project
 * (blue ⟡ tag); a `{ source }` hint names a connected source (neutral, no ⟡).
 * Falls back to "files onto {skillLabel}" when a template declares neither.
 */
function ProvenanceTag({
  template,
  skillLabel,
}: {
  template: TemplateDefinition;
  skillLabel: string;
}) {
  const prov = template.provenance;
  if (prov && "source" in prov) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: 11,
          color: C.t3,
          background: C.sunken,
          borderRadius: 7,
          padding: "4px 9px",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {prov.source}
      </span>
    );
  }
  const label =
    prov && "files" in prov ? `files onto ${prov.files}` : `files onto ${skillLabel}`;
  return <SourceTag label={label} />;
}

/** The tinted preview band's top row: serif sample-context + mono field chip. */
function PreviewBandHeader({
  template,
}: {
  template: TemplateDefinition;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "11px 13px 8px",
      }}
    >
      <span
        style={{
          fontFamily: serif,
          fontSize: 16,
          lineHeight: 1.05,
          color: C.t1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {template.sampleContext ?? template.title}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontFamily: mono,
          fontSize: 10,
          letterSpacing: "0.02em",
          color: C.blueS,
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 999,
          padding: "3px 9px",
          whiteSpace: "nowrap",
        }}
      >
        {template.inputs.length} fields
      </span>
    </div>
  );
}

/** Primary "Fill & build ›" + secondary "Preview" action row (S1 card). */
function CardActions({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
      <span
        style={{
          flex: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          background: C.ink,
          color: C.surface,
          borderRadius: 10,
          padding: "9px 14px",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Fill &amp; build ›
      </span>
      <span
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: C.sunken,
          color: C.t2,
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          padding: "9px 16px",
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        Preview
      </span>
    </div>
  );
}

export interface CreateViewProps {
  /**
   * Seeds a new chat thread with a prompt and runs it. When the run carries a
   * gallery/composer selection, its compiled `CreateIntent` is passed as the
   * second arg so the host can stamp it as the resulting asset's remix
   * provenance (see create-provenance-store). Plain quick-start / form runs
   * omit it.
   *
   * Canvas edits (Inpaint / Outpaint / Restyle / Remove BG / Upscale) attach a
   * SOURCE image: when the user picks one it rides as the optional `file`, which
   * the host stages into the chat composer (attachments only ride a message
   * through the composer, never the `?prompt=` auto-send path). Desktop parity
   * with the mobile Create sheet's CanvasComposer.
   */
  onRunPrompt: (
    prompt: string,
    intent?: CreateIntent | null,
    file?: File,
  ) => void;
}

/** A picked canvas source image, ready to ride the chat composer as a File. */
interface CanvasImagePick {
  file: File;
  name: string;
  /** Object URL for the preview card — revoked on clear/replace/unmount. */
  previewUrl: string;
}

export function CreateView({ onRunPrompt }: CreateViewProps) {
  const isMobile = useIsMobile();
  const [activeModeId, setActiveModeId] = useState<string>(CREATE_MODES[0].id);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  // A quick-start template with `elicit` fields parks here so the client asks
  // its questions BEFORE any model turn (see create-elicit-form.tsx).
  const [elicitTemplate, setElicitTemplate] = useState<CreateTemplate | null>(
    null,
  );

  // Create Studio — gallery overlay + composer selection.
  const { brand } = useActiveBrand();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [selection, setSelection] = useState<GallerySelection | null>(null);
  const [reference, setReference] = useState<CreateReference | null>(null);
  const [prompt, setPrompt] = useState("");
  // Canvas mode's source image (the picture to edit/restyle/upscale). Rides
  // exactly one run as a real File attachment, then clears.
  const [canvasImage, setCanvasImage] = useState<CanvasImagePick | null>(null);

  // Swap the canvas source image, revoking the previous preview URL.
  const setCanvasImagePick = (pick: CanvasImagePick | null) => {
    setCanvasImage((prev) => {
      if (prev && prev.previewUrl !== pick?.previewUrl) {
        URL.revokeObjectURL(prev.previewUrl);
      }
      return pick;
    });
  };
  const clearCanvasImage = () => setCanvasImagePick(null);

  const activeMode: CreateMode =
    CREATE_MODES.find((mode) => mode.id === activeModeId) ?? CREATE_MODES[0];
  const formTemplates = templatesForMode(activeMode.id);
  const activeTemplate = activeTemplateId
    ? findTemplate(activeTemplateId)
    : undefined;

  const hasGallery = GALLERY_MODES.has(activeMode.id);

  // Selecting a new mode clears a stale selection (it was mode-scoped). The
  // reference chip is generation-scoped, not mode-scoped, so it persists.
  const switchMode = (id: string) => {
    setActiveModeId(id);
    setActiveTemplateId(null);
    setElicitTemplate(null);
    setSelection((prev) => (prev && prev.mode === id ? prev : null));
    // The source image is canvas-scoped — leaving canvas drops it.
    if (id !== "canvas") clearCanvasImage();
  };

  // The single funnel EVERY content path routes through — typed prompt, a
  // filled form template, or a one-tap quick-start. It compiles the active
  // gallery selection (style / template / reference / brand) into a design
  // contract and prepends it, so the picked "look" always composes with the
  // "content" instead of one silently dropping the other. Previously only the
  // composer applied the selection; the form and quick-start paths ignored it,
  // which is exactly why a chosen style didn't carry through to a template.
  const runContent = (rawText: string) => {
    const text = rawText.trim();
    if (!text) return;
    // A canvas source image rides this run as a real File attachment.
    const canvasFile =
      activeMode.id === "canvas" ? canvasImage?.file : undefined;
    if (selection || reference) {
      const intent = selection
        ? selectionToIntent(selection, brand?.id ?? null, reference)
        : { mode: activeMode.id, reference: reference ?? undefined };
      const applyBrand = selection?.inBrand ? brand : null;
      // Stamp the intent as the asset's origin provenance (the reference is
      // per-generation, not part of the reusable remix origin, so drop it).
      const provenance: CreateIntent = { ...intent, reference: undefined };
      onRunPrompt(
        applyCreateIntent(text, intent, applyBrand),
        provenance,
        canvasFile,
      );
    } else {
      onRunPrompt(text, null, canvasFile);
    }
    if (canvasFile) clearCanvasImage();
  };

  const submitComposer = () => runContent(prompt);

  // Canvas actions seed a thread directly (they carry their own prompt).
  const runCanvasAction = (sel: GallerySelection) => {
    const action = sel.actionId ? getCanvasActionSpec(sel.actionId) : undefined;
    if (!action) return;
    const intent = selectionToIntent(sel, brand?.id ?? null, reference);
    onRunPrompt(
      applyCreateIntent(action.promptSeed, intent, sel.inBrand ? brand : null),
      { ...intent, reference: undefined },
      // The action's promptSeed ("I'll attach an image I want to edit…") only
      // makes sense with the source image actually attached — stage it.
      canvasImage?.file,
    );
    clearCanvasImage();
  };

  const handleGalleryConfirm = (sel: GallerySelection) => {
    setGalleryOpen(false);
    // Canvas actions are self-seeding; everything else parks as a composer chip.
    if (sel.mode === "canvas") {
      runCanvasAction(sel);
      return;
    }
    setSelection(sel);
  };

  // Elicitation form takes over the surface when a quick-start template needs
  // inputs first — the client collects answers, composes them into the prompt,
  // and only THEN sends (routed through runContent so a gallery selection still
  // rides along).
  if (elicitTemplate) {
    return (
      <TemplateElicitForm
        key={elicitTemplate.id}
        template={elicitTemplate}
        onCancel={() => setElicitTemplate(null)}
        onSubmit={(composed) => {
          setElicitTemplate(null);
          runContent(composed);
        }}
      />
    );
  }

  // Detail (form) view takes over the whole surface when a template is open.
  if (activeTemplate) {
    return (
      <CreateTemplateForm
        template={activeTemplate}
        onBack={() => setActiveTemplateId(null)}
        onSubmit={runContent}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ color: C.ink, fontFamily: "'DM Sans', system-ui, sans-serif" }}
    >
      {/* Editorial hero — "What do you want to get done?" (S1 frame). */}
      <header className="mb-6">
        <div style={microLabel}>Create · templates &amp; quick start</div>
        <h1
          style={{
            fontFamily: serif,
            fontSize: 34,
            lineHeight: 1.08,
            color: C.ink,
            marginTop: 6,
          }}
        >
          What do you want to get done?
        </h1>
        <p style={{ marginTop: 6, fontSize: 13.5, color: C.t2, maxWidth: 640 }}>
          Fill a template with your own inputs, or grab a quick start. Each one
          kicks off a thread and{" "}
          <span style={{ fontStyle: "italic", color: C.blueS }}>
            builds the asset — for real
          </span>
          , then files it onto a project.
        </p>
      </header>

      {/* Mode picker — pill tab row + a "Browse …" gallery affordance. On mobile
          this is a single horizontal-SCROLL row (no wrap) per the mobile S1
          design; on desktop it wraps as before. */}
      <div
        className={
          isMobile ? "mb-4 flex flex-col gap-3" : "mb-4 flex items-center gap-3"
        }
      >
        <div
          role="tablist"
          aria-label="Create mode"
          className={
            isMobile
              ? "-mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4"
              : "flex flex-1 flex-wrap gap-2"
          }
          style={
            isMobile
              ? {
                  scrollbarWidth: "none",
                  msOverflowStyle: "none",
                  WebkitOverflowScrolling: "touch",
                }
              : undefined
          }
        >
          {CREATE_MODES.map((mode) => {
            const Icon = mode.icon;
            const active = mode.id === activeMode.id;
            return (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchMode(mode.id)}
                className="group flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors"
                style={{
                  borderColor: active ? C.blue : C.line,
                  background: active
                    ? `color-mix(in srgb, ${C.blue} 12%, transparent)`
                    : "transparent",
                  color: active ? C.blueS : C.t2,
                }}
              >
                <Icon
                  className="size-4"
                  strokeWidth={2}
                  aria-hidden="true"
                  style={{ color: active ? C.blueS : C.t3 }}
                />
                {mode.label}
              </button>
            );
          })}
        </div>

        {/* Gallery entry point — opens the overlay for the active mode. */}
        {hasGallery ? (
          <button
            type="button"
            onClick={() => setGalleryOpen(true)}
            className={
              isMobile
                ? "flex shrink-0 items-center justify-center gap-2 self-start rounded-full border px-3.5 py-2 text-sm font-medium"
                : "flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium"
            }
            style={{ borderColor: C.line, color: C.t2, background: C.surface }}
          >
            <LayoutGrid className="size-4" style={{ color: C.blueS }} />
            {browseLabel(activeMode.id)} →
          </button>
        ) : null}
      </div>

      {/* Composer — the typed prompt + a dismissible selection chip and the
          "In your brand" toggle. Submitting compiles the selection into a
          design contract (applyCreateIntent) and seeds a thread. */}
      {hasGallery ? (
        <StudioComposer
          isMobile={isMobile}
          prompt={prompt}
          onPrompt={setPrompt}
          isCanvas={activeMode.id === "canvas"}
          canvasImage={canvasImage}
          onCanvasImage={setCanvasImagePick}
          onClearCanvasImage={clearCanvasImage}
          selection={selection}
          onClearSelection={() => setSelection(null)}
          onToggleBrand={
            selection && brand
              ? () =>
                  setSelection((prev) =>
                    prev ? { ...prev, inBrand: !prev.inBrand } : prev,
                  )
              : undefined
          }
          reference={reference}
          onReference={setReference}
          onClearReference={() => setReference(null)}
          brandName={brand?.name ?? null}
          onSubmit={submitComposer}
        />
      ) : (
        <div className="mb-3" />
      )}

      {/* Gallery overlay */}
      {galleryOpen ? (
        <CreateGalleryOverlay
          mode={activeMode.id}
          hasBrand={Boolean(brand)}
          brandName={brand?.name ?? null}
          initialInBrand={selection?.inBrand ?? true}
          onConfirm={handleGalleryConfirm}
          onTakeAiDirection={() => {
            setGalleryOpen(false);
            setSelection(null);
          }}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null}

      {/* Sections */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        {/* Structured templates (forms) */}
        {formTemplates.length > 0 ? (
          <div className="mb-8">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h2 style={microLabel}>Templates · fill &amp; generate</h2>
              <span
                style={{
                  ...microLabel,
                  color: C.t3,
                  border: `1px solid ${C.line}`,
                  borderRadius: 999,
                  padding: "2px 9px",
                }}
              >
                {activeMode.skillLabel}
              </span>
            </div>
            {isMobile ? (
              <div className="flex flex-col gap-3">
                {formTemplates.map((template, index) =>
                  index === 0 ? (
                    <FeaturedTemplateCard
                      key={template.id}
                      template={template}
                      modeId={activeMode.id}
                      skillLabel={activeMode.skillLabel}
                      onOpen={() => setActiveTemplateId(template.id)}
                    />
                  ) : (
                    <CompactTemplateRow
                      key={template.id}
                      template={template}
                      skillLabel={activeMode.skillLabel}
                      onOpen={() => setActiveTemplateId(template.id)}
                    />
                  ),
                )}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc((100%-3rem)/3)),1fr))] gap-4">
                {formTemplates.map((template, index) => (
                  <FormTemplateCard
                    key={template.id}
                    template={template}
                    modeId={activeMode.id}
                    skillLabel={activeMode.skillLabel}
                    active={index === 0}
                    onOpen={() => setActiveTemplateId(template.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* Quick-start prompts — the richer preview cards (kept as the current
            setup per product direction; the design's compact icon rows were
            reverted). Same treatment on desktop and mobile: a thumbnail-led
            preview card with title, description, and provenance chip. */}
        <div className="pb-6">
          <h2 className="mb-4" style={microLabel}>
            Quick start · {activeMode.tagline}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc((100%-3rem)/3)),1fr))] gap-4">
            {activeMode.templates.map((template) => (
              <QuickTemplateCard
                key={template.id}
                template={template}
                modeId={activeMode.id}
                skillLabel={activeMode.skillLabel}
                onSelect={() =>
                  templateNeedsElicitation(template)
                    ? setElicitTemplate(template)
                    : runContent(template.prompt)
                }
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Studio composer — a lightweight prompt box under the mode chips. When the
 * user has confirmed a gallery selection it shows a dismissible chip (▣
 * Template: Startup ✕) plus an "In your brand ✓/Off" toggle; on submit the
 * parent compiles the selection into a design contract and seeds a thread.
 */
function StudioComposer({
  isMobile,
  prompt,
  onPrompt,
  isCanvas,
  canvasImage,
  onCanvasImage,
  onClearCanvasImage,
  selection,
  onClearSelection,
  onToggleBrand,
  reference,
  onReference,
  onClearReference,
  brandName,
  onSubmit,
}: {
  isMobile: boolean;
  prompt: string;
  onPrompt: (v: string) => void;
  isCanvas: boolean;
  canvasImage: CanvasImagePick | null;
  onCanvasImage: (pick: CanvasImagePick) => void;
  onClearCanvasImage: () => void;
  selection: GallerySelection | null;
  onClearSelection: () => void;
  onToggleBrand?: () => void;
  reference: CreateReference | null;
  onReference: (r: CreateReference) => void;
  onClearReference: () => void;
  brandName: string | null;
  onSubmit: () => void;
}) {
  const canSend = prompt.trim().length > 0;
  return (
    <div
      className="mb-7"
      style={{
        ...cardChrome,
        borderRadius: 16,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Selection + reference + brand chips */}
      {selection || reference ? (
        <div className="flex flex-wrap items-center gap-2">
          {selection ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12.5,
                fontWeight: 600,
                color: C.blueS,
                background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${C.blue} 30%, transparent)`,
                borderRadius: 999,
                padding: "5px 6px 5px 11px",
              }}
            >
              <span aria-hidden>▣</span>
              {selectionChipText(selection)}
              <button
                type="button"
                onClick={onClearSelection}
                aria-label="Clear selection"
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: "none",
                  background: "transparent",
                  color: C.blueS,
                  cursor: "pointer",
                }}
              >
                <X size={13} />
              </button>
            </span>
          ) : null}

          {reference ? (
            <ReferenceChip reference={reference} onClear={onClearReference} />
          ) : null}

          {onToggleBrand && selection ? (
            <button
              type="button"
              onClick={onToggleBrand}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                fontWeight: 500,
                color: selection.inBrand ? C.t1 : C.t3,
                background: "transparent",
                border: `1px solid ${C.line}`,
                borderRadius: 999,
                padding: "5px 11px",
                cursor: "pointer",
              }}
            >
              {selection.inBrand
                ? `In ${brandName ?? "your brand"} ✓`
                : "Brand: Off"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Canvas mode swaps the style-reference drop for a SOURCE-image drop:
          the picture to edit/restyle/upscale, which rides the run as a real
          File attachment (desktop parity with the mobile CanvasComposer). Its
          own image source owns that affordance, so the "make it look like this"
          reference drop is hidden here — exactly as the mobile sheet does. */}
      {isCanvas ? (
        <CanvasSourceDrop
          image={canvasImage}
          onImage={onCanvasImage}
          onClear={onClearCanvasImage}
        />
      ) : reference ? null : (
        <ReferenceDrop onReference={onReference} />
      )}

      {/* Prompt row */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <textarea
          data-coach="create-prompt"
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={isMobile ? 2 : 1}
          placeholder={
            selection || reference
              ? "Describe what you want — your picks ride along…"
              : "Describe what you want to create…"
          }
          style={{
            flex: 1,
            resize: "none",
            background: "transparent",
            border: "none",
            outline: "none",
            color: C.t1,
            fontSize: 14,
            lineHeight: 1.45,
            fontFamily: "'DM Sans', system-ui, sans-serif",
            maxHeight: 140,
            padding: "6px 4px",
          }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Create"
          style={{
            flexShrink: 0,
            width: 38,
            height: 38,
            borderRadius: 11,
            display: "grid",
            placeItems: "center",
            border: "none",
            background: canSend ? C.blue : C.line,
            color: "#fff",
            cursor: canSend ? "pointer" : "not-allowed",
            opacity: canSend ? 1 : 0.7,
          }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * Reference chip (4c) — the confirmed per-generation reference, shown alongside
 * the Template/Style chip. Carries a tiny thumbnail (image refs) or a link
 * glyph (URL refs) + a dismiss ✕. Distinct wash from the blue selection chip so
 * "borrowed look" reads apart from "picked template".
 */
function ReferenceChip({
  reference,
  onClear,
}: {
  reference: CreateReference;
  onClear: () => void;
}) {
  const name =
    reference.kind === "image"
      ? referenceImageName(reference.ref)
      : referenceUrlHost(reference.ref);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        fontWeight: 600,
        color: C.t1,
        background: C.sunken,
        border: `1px solid ${C.line}`,
        borderRadius: 999,
        padding: "4px 6px 4px 5px",
        maxWidth: 240,
      }}
    >
      {reference.kind === "image" ? (
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            flexShrink: 0,
            background: `center / cover no-repeat url("${reference.ref}"), ${C.line}`,
          }}
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            background: C.surface,
            color: C.t2,
          }}
        >
          <Link2 size={12} />
        </span>
      )}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Reference: {name}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove reference"
        style={{
          display: "grid",
          placeItems: "center",
          width: 18,
          height: 18,
          borderRadius: 999,
          border: "none",
          background: "transparent",
          color: C.t2,
          cursor: "pointer",
        }}
      >
        <X size={13} />
      </button>
    </span>
  );
}

/** Short display name for an image reference (strip object-URL / path noise). */
function referenceImageName(ref: string): string {
  if (ref.startsWith("blob:") || ref.startsWith("data:")) return "uploaded image";
  const tail = ref.split("/").pop() ?? ref;
  return tail.length > 28 ? `${tail.slice(0, 25)}…` : tail;
}

/** Short display name for a URL reference (host, sans scheme/www). */
function referenceUrlHost(ref: string): string {
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return ref.length > 28 ? `${ref.slice(0, 25)}…` : ref;
  }
}

/** True for strings that look like an http(s) URL a user might paste. */
function looksLikeUrl(v: string): boolean {
  return /^https?:\/\/\S+$/i.test(v.trim());
}

/**
 * Reference drop target (4c) — "make it look like this". Drag an image or
 * paste a URL to borrow its look for ONE generation (distinct from the saved
 * Brand Kit). On drop/paste it runs a brief "extracting the look…" state, then
 * confirms the reference (which parks as a chip in the composer). The
 * extraction is cosmetic — we don't run real vision here; the ref rides into
 * the CreateIntent and the skill does the extraction at generation time.
 */
function ReferenceDrop({
  onReference,
}: {
  onReference: (r: CreateReference) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [extracting, setExtracting] = useState<CreateReference | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginExtract = (ref: CreateReference) => {
    setExtracting(ref);
    if (timer.current) clearTimeout(timer.current);
    // Brief "extracting the look…" beat, then hand the ref to the composer.
    timer.current = setTimeout(() => {
      setExtracting(null);
      onReference(ref);
    }, 900);
  };

  const takeFile = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    beginExtract({ kind: "image", ref: URL.createObjectURL(file) });
  };

  if (extracting) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRadius: 12,
          border: `1px dashed ${C.blue}`,
          background: `color-mix(in srgb, ${C.blue} 7%, transparent)`,
          padding: "12px 14px",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 999,
            border: `2px solid color-mix(in srgb, ${C.blue} 30%, transparent)`,
            borderTopColor: C.blueS,
            animation: "spin 0.7s linear infinite",
          }}
        />
        <span style={{ fontSize: 13, color: C.t2 }}>
          Extracting the look…{" "}
          <span style={{ color: C.t3 }}>
            palette · composition · mood
          </span>
        </span>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) {
          takeFile(file);
          return;
        }
        const text = e.dataTransfer.getData("text/uri-list") ||
          e.dataTransfer.getData("text/plain");
        if (looksLikeUrl(text)) beginExtract({ kind: "url", ref: text.trim() });
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text/plain");
        if (looksLikeUrl(text)) {
          e.preventDefault();
          beginExtract({ kind: "url", ref: text.trim() });
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        borderRadius: 12,
        border: `1px dashed ${dragOver ? C.blue : C.line}`,
        background: dragOver
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : C.sunken,
        padding: "10px 12px",
        cursor: "pointer",
        transition: "border-color 120ms, background 120ms",
      }}
      onClick={() => fileInput.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Add a style reference — drop an image or paste a URL"
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          takeFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          color: C.blueS,
          background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
        }}
      >
        <ImagePlus size={17} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: C.t1,
          }}
        >
          Drop an image or paste a URL to borrow its look
        </span>
        <span
          style={{
            display: "block",
            marginTop: 1,
            fontSize: 11,
            color: C.t3,
          }}
        >
          palette · composition · mood — for this one generation only
        </span>
      </span>
    </div>
  );
}

/**
 * Canvas source-image drop — the picture the user wants to edit (inpaint,
 * outpaint, restyle), upscale, or cut out. Drag-drop, paste, or click to pick;
 * the picked File rides the run through the chat composer (attachments can't
 * ride the `?prompt=` auto-send path). Distinct from ReferenceDrop, which
 * borrows a *look*: this IS the subject image the canvas action operates on.
 * Desktop parity with the mobile Create sheet's CanvasComposer image source.
 */
function CanvasSourceDrop({
  image,
  onImage,
  onClear,
}: {
  image: CanvasImagePick | null;
  onImage: (pick: CanvasImagePick) => void;
  onClear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const takeFile = (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    onImage({
      file,
      name: file.name || "image",
      previewUrl: URL.createObjectURL(file),
    });
  };

  // Selected source — preview strip with filename + a clear button.
  if (image) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          borderRadius: 12,
          border: `1px solid ${C.line}`,
          background: C.sunken,
          padding: "10px 12px",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            flexShrink: 0,
            background: `center / cover no-repeat url("${image.previewUrl}"), ${C.surface}`,
          }}
        />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 12.5,
              fontWeight: 600,
              color: C.t1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {image.name}
          </span>
          <span
            style={{ display: "block", marginTop: 1, fontSize: 11, color: C.t3 }}
          >
            Source image — rides your next canvas action
          </span>
        </span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Remove source image"
          style={{
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            width: 26,
            height: 26,
            borderRadius: 999,
            border: `1px solid ${C.line}`,
            background: "transparent",
            color: C.t2,
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        takeFile(e.dataTransfer.files?.[0]);
      }}
      onPaste={(e) => {
        const file = e.clipboardData.files?.[0];
        if (file) {
          e.preventDefault();
          takeFile(file);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        borderRadius: 12,
        border: `1px dashed ${dragOver ? C.blue : C.line}`,
        background: dragOver
          ? `color-mix(in srgb, ${C.blue} 8%, transparent)`
          : C.sunken,
        padding: "10px 12px",
        cursor: "pointer",
        transition: "border-color 120ms, background 120ms",
      }}
      onClick={() => fileInput.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Add the image to edit — drop, paste, or choose a photo"
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          takeFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          borderRadius: 9,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          color: C.blueS,
          background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
        }}
      >
        <ImagePlus size={17} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: C.t1,
          }}
        >
          Drop, paste, or choose the image to edit
        </span>
        <span
          style={{ display: "block", marginTop: 1, fontSize: 11, color: C.t3 }}
        >
          the picture your canvas action restyles, extends, upscales, or cuts out
        </span>
      </span>
    </div>
  );
}

/** Shared card chrome — the one-card anatomy from the HQ deck. */
const cardChrome: React.CSSProperties = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: 15,
  color: C.ink,
};

/**
 * Structured-template card (desktop S1) — the full one-card anatomy: a tinted
 * preview band carrying a serif sample-context + mono field-count chip over the
 * artifact thumbnail, then the serif title, description, ⟡ provenance chip, and
 * an explicit "Fill & build ›" / "Preview" action row. The first card in the
 * row renders `active` (blue border + fill), mirroring the design's featured
 * template. The whole card is clickable; the action row makes the primary path
 * explicit and scannable. Opening either lands on the fill-fields form.
 */
function FormTemplateCard({
  template,
  modeId,
  skillLabel,
  active = false,
  onOpen,
}: {
  template: TemplateDefinition;
  modeId: string;
  skillLabel: string;
  active?: boolean;
  onOpen: () => void;
}) {
  const { kind, variant } = previewForTemplate(modeId, template.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col items-start overflow-hidden text-left transition-all hover:-translate-y-0.5 focus-visible:outline-none"
      style={
        active
          ? {
              ...cardChrome,
              borderColor: C.blue,
              borderWidth: 1.5,
              background: `color-mix(in srgb, ${C.blue} 5%, ${C.surface})`,
              boxShadow: `0 20px 44px -28px color-mix(in srgb, ${C.blue} 50%, transparent)`,
            }
          : cardChrome
      }
    >
      {/* Tinted preview band: serif sample-context + field chip over the thumb. */}
      <div
        className="w-full overflow-hidden"
        style={{
          borderBottom: `1px solid ${C.line}`,
          background: `color-mix(in srgb, ${C.blue} 6%, ${C.sunken})`,
        }}
      >
        <PreviewBandHeader template={template} />
        <div className="px-3 pb-3 transition-transform duration-200 group-hover:scale-[1.015]">
          <CreatePreview kind={kind} variant={variant} />
        </div>
      </div>
      <div className="flex w-full flex-1 flex-col p-4 pt-3.5">
        <h3
          style={{
            fontFamily: serif,
            fontSize: 18,
            fontWeight: 400,
            color: C.t1,
            lineHeight: 1.12,
          }}
        >
          {template.title}
        </h3>
        <p
          style={{
            marginTop: 5,
            fontSize: 13,
            lineHeight: 1.4,
            color: C.t2,
          }}
        >
          {template.description}
        </p>
        <div style={{ marginTop: "auto", paddingTop: 12 }}>
          <ProvenanceTag template={template} skillLabel={skillLabel} />
          <CardActions onOpen={onOpen} />
        </div>
      </div>
    </button>
  );
}

/**
 * Featured template card (mobile S1) — the top structured template rendered
 * large: preview band, title + field-count chip, description, the ⟡ provenance
 * chip, and an explicit primary "Fill & build ›" + secondary "Preview" row.
 * Both buttons open the fill-fields form (which then generates the asset and
 * files it onto its project); the row simply makes that action explicit and
 * scannable on the phone, where the whole-card tap alone is ambiguous.
 */
function FeaturedTemplateCard({
  template,
  modeId,
  skillLabel,
  onOpen,
}: {
  template: TemplateDefinition;
  modeId: string;
  skillLabel: string;
  onOpen: () => void;
}) {
  const { kind, variant } = previewForTemplate(modeId, template.id);
  return (
    <div
      className="flex w-full flex-col overflow-hidden text-left"
      style={{
        ...cardChrome,
        borderColor: C.blue,
        borderWidth: 1.5,
        boxShadow: `0 20px 44px -26px color-mix(in srgb, ${C.blue} 55%, transparent)`,
      }}
    >
      <div className="w-full p-3 pb-0">
        <CreatePreview kind={kind} variant={variant} />
      </div>
      <div className="flex w-full flex-col p-4 pt-3">
        <div className="flex w-full items-start justify-between gap-2">
          <h3
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: C.t1,
              lineHeight: 1.2,
            }}
          >
            {template.title}
          </h3>
          <span
            style={{
              flexShrink: 0,
              fontFamily: mono,
              fontSize: 9,
              letterSpacing: "0.04em",
              color: C.blueS,
              background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
              borderRadius: 6,
              padding: "3px 7px",
              whiteSpace: "nowrap",
            }}
          >
            {template.inputs.length} FIELDS
          </span>
        </div>
        <p style={{ marginTop: 6, fontSize: 13, lineHeight: 1.4, color: C.t2 }}>
          {template.description}
        </p>
        <div style={{ marginTop: 11 }}>
          <SourceTag label={`files onto ${skillLabel}`} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 13 }}>
          <button
            type="button"
            onClick={onOpen}
            style={{
              flex: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: C.ink,
              color: C.surface,
              border: "none",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Fill &amp; build ›
          </button>
          <button
            type="button"
            onClick={onOpen}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: C.sunken,
              color: C.t2,
              border: `1px solid ${C.line}`,
              borderRadius: 10,
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Preview
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact structured-template row (mobile S1) — icon tile · title · fields. */
function CompactTemplateRow({
  template,
  skillLabel,
  onOpen,
}: {
  template: TemplateDefinition;
  skillLabel: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 text-left transition-colors"
      style={{ ...cardChrome, padding: "12px 13px" }}
    >
      <span
        aria-hidden
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          display: "grid",
          placeItems: "center",
          fontSize: 16,
          color: C.blueS,
          background: `color-mix(in srgb, ${C.blue} 12%, transparent)`,
          flexShrink: 0,
        }}
      >
        ▤
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            fontWeight: 600,
            color: C.t1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {template.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: C.t2,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {skillLabel} · {template.inputs.length} fields
        </span>
      </span>
      <ArrowUpRight
        className="size-4 shrink-0"
        aria-hidden="true"
        style={{ color: C.t3 }}
      />
    </button>
  );
}

/** Quick-start card — seeds the thread directly with a prefilled prompt. */
function QuickTemplateCard({
  template,
  modeId,
  skillLabel,
  onSelect,
}: {
  template: CreateTemplate;
  modeId: string;
  skillLabel: string;
  onSelect: () => void;
}) {
  const { kind, variant } = previewForTemplate(modeId, template.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex h-full flex-col items-start overflow-hidden text-left transition-all hover:-translate-y-0.5 focus-visible:outline-none"
      style={cardChrome}
    >
      {/* Visual preview of the artifact this prompt produces. */}
      <div className="w-full p-3 pb-0 transition-transform duration-200 group-hover:scale-[1.015]">
        <CreatePreview kind={kind} variant={variant} />
      </div>
      <div className="flex w-full flex-col p-4 pt-3">
        <div className="flex w-full items-start justify-between gap-2">
          <h3
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: C.t1,
              lineHeight: 1.2,
            }}
          >
            {template.title}
          </h3>
          <ArrowUpRight
            className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
            style={{ color: C.t3 }}
          />
        </div>
        <p
          style={{
            marginTop: 6,
            fontSize: 13,
            lineHeight: 1.4,
            color: C.t2,
          }}
        >
          {template.description}
        </p>
        <div style={{ marginTop: 11 }}>
          <SourceTag label={skillLabel} />
        </div>
      </div>
    </button>
  );
}
