/**
 * Create view — the "What do you want to get done?" entry point.
 *
 * A mode picker (Slides / Dashboards / Docs / Research / Images / Canvas /
 * Video) where each mode surfaces predefined templates. Each template is a
 * concrete prefilled prompt wired to a real Cue skill (see create-templates.ts).
 *
 * Picking a template seeds a brand-new chat thread via `onSelectTemplate`,
 * which routes through the standard `?prompt=` auto-send path so the backing
 * skill actually runs and produces the asset.
 */

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";

import {
  CREATE_MODES,
  type CreateMode,
  type CreateTemplate,
} from "@/domains/create/create-templates";

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
  /** Seeds a new chat thread with the template's prompt and runs it. */
  onSelectTemplate: (prompt: string) => void;
}

export function CreateView({ onSelectTemplate }: CreateViewProps) {
  const [activeModeId, setActiveModeId] = useState<string>(CREATE_MODES[0].id);
  const activeMode: CreateMode =
    CREATE_MODES.find((mode) => mode.id === activeModeId) ?? CREATE_MODES[0];

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
          Pick a starting point. Each one kicks off a thread and builds the
          asset for real.
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
              onClick={() => setActiveModeId(mode.id)}
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

      {/* Active mode templates */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 style={sectionLabel}>{activeMode.tagline}</h2>
          <span
            className="rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[var(--text-dim)]"
            style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".06em" }}
          >
            {activeMode.skillLabel}
          </span>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc((100%-3rem)/3)),1fr))] gap-4 pb-6">
          {activeMode.templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onSelect={() => onSelectTemplate(template.prompt)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function TemplateCard({
  template,
  onSelect,
}: {
  template: CreateTemplate;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex h-full flex-col items-start rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-4 text-left transition-all hover:border-[var(--accent-cue)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cue)]"
    >
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
    </button>
  );
}
