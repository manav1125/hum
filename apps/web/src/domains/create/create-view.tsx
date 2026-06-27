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
 */

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

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

// Editorial tokens — mirrors the Library surface (design/HANDOFF.md):
// Instrument Serif headline + DM Mono section labels over design-library
// CSS variables so dark mode is automatic.
const SERIF = "'Instrument Serif', Georgia, serif";
const MONO = "'DM Mono', ui-monospace, monospace";

const sectionLabel = {
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: ".1em",
  textTransform: "uppercase" as const,
  color: "var(--text-dim)",
};

export interface CreateViewProps {
  /** Seeds a new chat thread with a prompt and runs it. */
  onRunPrompt: (prompt: string) => void;
}

export function CreateView({ onRunPrompt }: CreateViewProps) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Headline */}
      <header className="mb-6">
        <h1
          className="text-[var(--text-base)]"
          style={{ fontFamily: SERIF, fontSize: 34, lineHeight: 1.1 }}
        >
          What do you want to get done?
        </h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Fill a template with your own inputs, or grab a quick start. Each one
          kicks off a thread and builds the asset for real.
        </p>
      </header>

      {/* Mode picker */}
      <div
        role="tablist"
        aria-label="Create mode"
        className="mb-7 flex flex-wrap gap-2"
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
              className="group flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors"
              style={{
                borderColor: active
                  ? "var(--accent-cue)"
                  : "var(--border-base)",
                backgroundColor: active
                  ? "var(--accent-cue-subtle, var(--surface-lift))"
                  : "transparent",
                color: active ? "var(--text-base)" : "var(--text-muted)",
              }}
            >
              <Icon
                className="size-4"
                strokeWidth={2}
                aria-hidden="true"
                style={{ color: active ? "var(--accent-cue)" : undefined }}
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
            <div className="mb-4 flex items-baseline justify-between">
              <h2 style={sectionLabel}>Templates · fill &amp; generate</h2>
              <span
                className="rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[var(--text-dim)]"
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: ".06em",
                }}
              >
                {activeMode.skillLabel}
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc((100%-3rem)/3)),1fr))] gap-4">
              {formTemplates.map((template) => (
                <FormTemplateCard
                  key={template.id}
                  template={template}
                  modeId={activeMode.id}
                  onOpen={() => setActiveTemplateId(template.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* Quick-start prompts */}
        <div className="pb-6">
          <h2 className="mb-4" style={sectionLabel}>
            Quick start · {activeMode.tagline}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc((100%-3rem)/3)),1fr))] gap-4">
            {activeMode.templates.map((template) => (
              <QuickTemplateCard
                key={template.id}
                template={template}
                modeId={activeMode.id}
                onSelect={() => onRunPrompt(template.prompt)}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Structured-template card — opens the input form. */
function FormTemplateCard({
  template,
  modeId,
  onOpen,
}: {
  template: TemplateDefinition;
  modeId: string;
  onOpen: () => void;
}) {
  const { kind, variant } = previewForTemplate(modeId, template.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col items-start overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] text-left transition-all hover:border-[var(--accent-cue)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cue)]"
    >
      {/* Visual preview of the artifact this template produces. */}
      <div className="w-full p-3 pb-0 transition-transform duration-200 group-hover:scale-[1.015]">
        <CreatePreview kind={kind} variant={variant} />
      </div>
      <div className="flex w-full flex-col p-4 pt-3">
        <div className="flex w-full items-start justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-[var(--text-base)]">
            {template.title}
          </h3>
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: "var(--accent-cue-subtle, var(--surface-lift))",
              color: "var(--accent-cue)",
            }}
          >
            {template.inputs.length} fields
          </span>
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-[var(--text-muted)]">
          {template.description}
        </p>
      </div>
    </button>
  );
}

/** Quick-start card — seeds the thread directly with a prefilled prompt. */
function QuickTemplateCard({
  template,
  modeId,
  onSelect,
}: {
  template: CreateTemplate;
  modeId: string;
  onSelect: () => void;
}) {
  const { kind, variant } = previewForTemplate(modeId, template.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex h-full flex-col items-start overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] text-left transition-all hover:border-[var(--accent-cue)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cue)]"
    >
      {/* Visual preview of the artifact this prompt produces. */}
      <div className="w-full p-3 pb-0 transition-transform duration-200 group-hover:scale-[1.015]">
        <CreatePreview kind={kind} variant={variant} />
      </div>
      <div className="flex w-full flex-col p-4 pt-3">
        <div className="flex w-full items-start justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-[var(--text-base)]">
            {template.title}
          </h3>
          <ArrowUpRight
            className="size-4 shrink-0 text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-[var(--text-muted)]">
          {template.description}
        </p>
      </div>
    </button>
  );
}
