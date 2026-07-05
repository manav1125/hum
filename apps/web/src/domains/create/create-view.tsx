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

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  CREATE_MODES,
  type CreateMode,
  type CreateTemplate,
} from "@/domains/create/create-templates";
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
  /** Seeds a new chat thread with a prompt and runs it. */
  onRunPrompt: (prompt: string) => void;
}

export function CreateView({ onRunPrompt }: CreateViewProps) {
  const isMobile = useIsMobile();
  const [activeModeId, setActiveModeId] = useState<string>(CREATE_MODES[0].id);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);

  const activeMode: CreateMode =
    CREATE_MODES.find((mode) => mode.id === activeModeId) ?? CREATE_MODES[0];
  const formTemplates = templatesForMode(activeMode.id);
  const activeTemplate = activeTemplateId
    ? findTemplate(activeTemplateId)
    : undefined;

  // Detail (form) view takes over the whole surface when a template is open.
  if (activeTemplate) {
    return (
      <CreateTemplateForm
        template={activeTemplate}
        onBack={() => setActiveTemplateId(null)}
        onSubmit={onRunPrompt}
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

      {/* Mode picker — pill tab row. On mobile this is a single
          horizontal-SCROLL row (no wrap) per the mobile S1 design; on desktop
          it wraps as before. */}
      <div
        role="tablist"
        aria-label="Create mode"
        className={
          isMobile
            ? "mb-7 -mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4"
            : "mb-7 flex flex-wrap gap-2"
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
              onClick={() => {
                setActiveModeId(mode.id);
                setActiveTemplateId(null);
              }}
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
                onSelect={() => onRunPrompt(template.prompt)}
              />
            ))}
          </div>
        </div>
      </section>
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
