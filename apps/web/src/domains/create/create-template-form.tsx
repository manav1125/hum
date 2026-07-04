/**
 * Template-detail view: renders a {@link TemplateDefinition}'s typed input
 * fields as a form, validates the required ones on submit, then composes the
 * values into a skill-targeted prompt via `template.composePrompt(values)` and
 * hands it back to the Create page, which seeds a fresh chat thread through the
 * standard `?prompt=` auto-send path.
 *
 * Styling mirrors create-view.tsx — raw Tailwind over design-library CSS
 * variables so dark mode is automatic.
 */

import { ArrowLeft, Sparkles, X } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import {
  type InputField,
  type TemplateDefinition,
  type TemplateValues,
  missingRequired,
} from "@/domains/create/create-form-templates";

const SERIF = "'Instrument Serif', Georgia, serif";
const MONO = "'DM Mono', ui-monospace, monospace";

const fieldLabel =
  "mb-1.5 block text-[12px] font-medium text-[var(--text-muted)]";
const controlBase =
  "w-full rounded-lg border bg-[var(--surface-base)] px-3 py-2 text-[14px] text-[var(--text-base)] placeholder:text-[var(--text-dim)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent-cue)] focus:border-[var(--accent-cue)]";

export interface CreateTemplateFormProps {
  template: TemplateDefinition;
  /** Back to the mode's template grid. */
  onBack: () => void;
  /** Receives the composed prompt; seeds a thread and runs the skill. */
  onSubmit: (prompt: string) => void;
}

export function CreateTemplateForm({
  template,
  onBack,
  onSubmit,
}: CreateTemplateFormProps) {
  const [values, setValues] = useState<TemplateValues>(() =>
    initialValues(template),
  );
  const [showErrors, setShowErrors] = useState(false);

  const missing = useMemo(
    () => missingRequired(template, values),
    [template, values],
  );

  const setValue = (key: string, value: string | string[]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = () => {
    if (missing.size > 0) {
      setShowErrors(true);
      return;
    }
    onSubmit(template.composePrompt(values));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <header className="mb-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-base)]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to templates
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              className="text-[var(--text-base)]"
              style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1.1 }}
            >
              {template.title}
            </h1>
            <p className="mt-1.5 text-sm text-[var(--text-muted)]">
              {template.description}
            </p>
          </div>
          <span
            className="shrink-0 rounded-full border border-[var(--border-base)] px-2 py-0.5 text-[var(--text-dim)]"
            style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".06em" }}
          >
            {template.skill}
          </span>
        </div>
      </header>

      {/* Form */}
      <section className="min-h-0 flex-1 overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          className="mx-auto flex max-w-2xl flex-col gap-4 pb-6"
        >
          {template.inputs.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={values[field.key]}
              invalid={showErrors && missing.has(field.key)}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}

          <div className="mt-2 flex items-center justify-between gap-3 border-t border-[var(--border-base)] pt-4">
            {showErrors && missing.size > 0 ? (
              <p className="text-[12px] text-[var(--accent-danger,#e5484d)]">
                Fill the required fields to continue.
              </p>
            ) : (
              <p className="text-[12px] text-[var(--text-dim)]">
                Your inputs become a detailed prompt that runs the skill.
              </p>
            )}
            <button
              type="submit"
              className="inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-[var(--text-on-accent,#fff)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-cue)]"
              style={{ backgroundColor: "var(--accent-cue)" }}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              Generate
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Seeds empty defaults so every field is a controlled component from mount. */
function initialValues(template: TemplateDefinition): TemplateValues {
  const out: TemplateValues = {};
  for (const field of template.inputs) {
    out[field.key] = field.type === "tags" ? [] : "";
  }
  return out;
}

function FieldControl({
  field,
  value,
  invalid,
  onChange,
}: {
  field: InputField;
  value: string | string[] | undefined;
  invalid: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const borderColor = invalid
    ? "var(--accent-danger, #e5484d)"
    : "var(--border-base)";

  return (
    <div>
      <label className={fieldLabel} htmlFor={`field-${field.key}`}>
        {field.label}
        {field.required ? (
          <span className="ml-1 text-[var(--accent-cue)]">*</span>
        ) : null}
      </label>

      {field.type === "textarea" ? (
        <textarea
          id={`field-${field.key}`}
          className={controlBase}
          style={{ borderColor, minHeight: 84, resize: "vertical" }}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "select" ? (
        <select
          id={`field-${field.key}`}
          className={controlBase}
          style={{ borderColor }}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select…</option>
          {field.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === "tags" ? (
        <TagsInput
          id={`field-${field.key}`}
          placeholder={field.placeholder}
          borderColor={borderColor}
          values={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      ) : (
        <input
          id={`field-${field.key}`}
          type={
            field.type === "number"
              ? "number"
              : field.type === "url"
                ? "url"
                : "text"
          }
          className={controlBase}
          style={{ borderColor }}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help ? (
        <p className="mt-1 text-[11px] text-[var(--text-dim)]">{field.help}</p>
      ) : null}
    </div>
  );
}

/** Chip-style multi-value input: Enter or comma commits a tag. */
function TagsInput({
  id,
  placeholder,
  borderColor,
  values,
  onChange,
}: {
  id: string;
  placeholder?: string;
  borderColor: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "").trim();
    if (!tag || values.includes(tag)) {
      setDraft("");
      return;
    }
    onChange([...values, tag]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-[var(--surface-base)] px-2 py-1.5"
      style={{ borderColor }}
    >
      {values.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] px-2 py-0.5 text-[12px] text-[var(--text-base)]"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(values.filter((t) => t !== tag))}
            className="text-[var(--text-dim)] transition-colors hover:text-[var(--text-base)]"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-[14px] text-[var(--text-base)] placeholder:text-[var(--text-dim)] focus:outline-none"
        placeholder={values.length === 0 ? placeholder : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
