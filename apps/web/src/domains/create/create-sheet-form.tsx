/**
 * CreateSheetForm — the mobile v3 "Fill & build" fielded template sheet
 * (spec frame 33). Tapping a form template in the Create sheet pushes this
 * view INSIDE the same SheetShell: a ‹ back header ("Just describe it"
 * escapes to the free prompt), the template's typed fields rendered in the
 * v3 field grammar, and a pinned-to-flow "Build it" CTA.
 *
 * Field kinds (frame 33 + the two desktop-only kinds the frame omits,
 * approved extrapolation):
 *   - select   → chip-select row (single pick; the frame's Period/Tone chips)
 *   - text     → single-line field (accent focus ring)
 *   - textarea → multi-line field
 *   - number   → metric/number card (label-in-card, bold value input). The
 *                frame's "PRE-FILLED FROM MEMORY" badge is NOT rendered:
 *                desktop forms seed every field empty (`initialValues` in
 *                create-template-form.tsx) — there is no real prefill source,
 *                so the provenance label would be fake.
 *   - url      → text field with the URL keyboard
 *   - tags     → removable chips + inline add field (Enter/comma commits)
 *
 * Validation mirrors the desktop form (missingRequired): missing required
 * fields get an amber "needs you" border — red stays reserved for true
 * failure per the v3 state taxonomy.
 *
 * Prompt composition is EXACTLY desktop's: `template.composePrompt(values)`.
 * The parent applies the brand/intent contract and seeds the run.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  contactsGetOptions,
  memoryitemsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import { haptic } from "@/utils/haptics";

import {
  missingRequired,
  type InputField,
  type TemplateDefinition,
  type TemplateValues,
} from "./create-form-templates";

/** Uppercase micro field label (frame 33: 11.5px / .05em / muted / 600). */
const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11.5,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--mv3-muted)",
  fontWeight: 600,
  marginBottom: 6,
};

/** Shared field chrome (frame 33 text field, resting state). */
function fieldChrome(state: "rest" | "focus" | "invalid"): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--mv3-btn2-bg)",
    border:
      state === "focus"
        ? "1.5px solid var(--mv3-accent)"
        : state === "invalid"
          ? "1.5px solid var(--mv3-amber)"
          : "1px solid var(--mv3-btn2-border)",
    borderRadius: 14,
    padding: "12px 14px",
    // ≥16px so iOS never zooms (v3 build rule; the frame's 14.5px is display
    // text — real inputs get bumped to the grammar's floor).
    fontSize: 16,
    color: "var(--mv3-text)",
    fontFamily: "inherit",
    outline: "none",
    boxShadow:
      state === "focus"
        ? "0 0 0 3px color-mix(in srgb, var(--mv3-accent) 12%, transparent)"
        : "none",
  };
}

export function CreateSheetForm({
  template,
  brandActive,
  onBack,
  onSubmit,
}: {
  template: TemplateDefinition;
  /** True when a REAL active Brand Kit exists (drives the CTA label). */
  brandActive: boolean;
  /** ‹ back / "Just describe it" — return to the free-prompt sheet. */
  onBack: () => void;
  /** Receives the desktop-composed prompt; the parent seeds the run. */
  onSubmit: (composedPrompt: string) => void;
}) {
  const [values, setValues] = useState<TemplateValues>(() => {
    const out: TemplateValues = {};
    for (const field of template.inputs) {
      out[field.key] = field.type === "tags" ? [] : "";
    }
    return out;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const missing = useMemo(
    () => missingRequired(template, values),
    [template, values],
  );

  const setValue = (key: string, value: string | string[]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    if (missing.size > 0) {
      haptic.light();
      setShowErrors(true);
      return;
    }
    onSubmit(template.composePrompt(values));
  };

  return (
    <div style={{ padding: "0 2px 4px", animation: "mv3Fade .22s ease both" }}>
      {/* Header — ‹ back · title/subtitle · "Just describe it" escape. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onBack();
          }}
          aria-label="Back to Create"
          style={{
            flexShrink: 0,
            minWidth: 44,
            minHeight: 44,
            margin: "-10px 0 -10px -12px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 17,
            color: "var(--mv3-micro)",
            fontFamily: "inherit",
          }}
        >
          ‹
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "-0.4px",
              color: "var(--mv3-text)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {template.title}
          </div>
          <div
            style={{ fontSize: 11.5, color: "var(--mv3-muted)", marginTop: 1 }}
          >
            Fill what you know — Cue writes the rest
          </div>
        </div>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            onBack();
          }}
          style={{
            flexShrink: 0,
            minHeight: 44,
            padding: "0 2px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: "var(--mv3-micro)",
            fontFamily: "inherit",
          }}
        >
          Just describe it
        </button>
      </div>

      {/* Fields — frame 33's 11px vertical rhythm. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 11,
          marginTop: 14,
        }}
      >
        {template.inputs.map((field) => (
          <SheetFieldControl
            key={field.key}
            field={field}
            value={values[field.key]}
            invalid={showErrors && missing.has(field.key)}
            focused={focusedKey === field.key}
            onFocusChange={(f) => setFocusedKey(f ? field.key : null)}
            onChange={(v) => setValue(field.key, v)}
          />
        ))}

        {showErrors && missing.size > 0 ? (
          <div style={{ fontSize: 12, color: "var(--mv3-amber)" }}>
            Fill the required fields to continue.
          </div>
        ) : null}

        {/* CTA — "in your brand ✓" ONLY over a real active Brand Kit. */}
        <button
          type="submit"
          className="cue-pressable"
          style={{
            width: "100%",
            background: "linear-gradient(160deg, #4E7CEC, #3560CC)",
            color: "#ffffff",
            border: "none",
            borderRadius: 15,
            padding: 15,
            minHeight: 48,
            fontSize: 15,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            marginTop: 3,
            boxShadow: "var(--mv3-primary-btn-shadow)",
          }}
        >
          {brandActive ? "Build it — in your brand ✓" : "Build it →"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Field controls                                                            */
/* ------------------------------------------------------------------------- */

function SheetFieldControl({
  field,
  value,
  invalid,
  focused,
  onFocusChange,
  onChange,
}: {
  field: InputField;
  value: string | string[] | undefined;
  invalid: boolean;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
  onChange: (value: string | string[]) => void;
}) {
  const state: "rest" | "focus" | "invalid" = focused
    ? "focus"
    : invalid
      ? "invalid"
      : "rest";

  return (
    <div>
      <div style={FIELD_LABEL}>
        {field.label}
        {field.required ? (
          <span aria-hidden style={{ color: "var(--mv3-micro)", marginLeft: 3 }}>
            *
          </span>
        ) : null}
      </div>

      {field.type === "select" ? (
        <ChipSelect
          label={field.label}
          options={field.options ?? []}
          value={(value as string) ?? ""}
          invalid={invalid}
          onChange={onChange}
        />
      ) : field.type === "textarea" ? (
        <textarea
          aria-label={field.label}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          rows={3}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...fieldChrome(state), minHeight: 84, resize: "vertical" }}
        />
      ) : field.type === "tags" ? (
        <SheetTagsInput
          label={field.label}
          placeholder={field.placeholder}
          invalid={invalid}
          values={Array.isArray(value) ? value : []}
          onFocusChange={onFocusChange}
          focused={focused}
          onChange={onChange}
        />
      ) : field.type === "url" ? (
        <SheetUrlInput
          label={field.label}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          invalid={invalid}
          focused={focused}
          onFocusChange={onFocusChange}
          onChange={onChange}
        />
      ) : field.type === "number" ? (
        /* Metric/number card (frame 33): label-in-card + bold value. */
        <div
          style={{
            width: "55%",
            minWidth: 150,
            boxSizing: "border-box",
            background: "var(--mv3-btn2-bg)",
            border: invalid
              ? "1.5px solid var(--mv3-amber)"
              : focused
                ? "1.5px solid var(--mv3-accent)"
                : "1px solid var(--mv3-btn2-border)",
            borderRadius: 14,
            padding: "10px 12px",
            boxShadow: focused
              ? "0 0 0 3px color-mix(in srgb, var(--mv3-accent) 12%, transparent)"
              : "none",
          }}
        >
          <div style={{ fontSize: 10, color: "var(--mv3-muted)" }}>
            {field.placeholder ? `e.g. ${field.placeholder}` : field.label}
          </div>
          <input
            aria-label={field.label}
            type="number"
            inputMode="decimal"
            value={(value as string) ?? ""}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            onChange={(e) => onChange(e.target.value)}
            style={{
              width: "100%",
              marginTop: 2,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 16,
              fontWeight: 700,
              color: "var(--mv3-text)",
              fontFamily: "inherit",
              padding: 0,
            }}
          />
        </div>
      ) : (
        <input
          aria-label={field.label}
          type="text"
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onChange={(e) => onChange(e.target.value)}
          style={fieldChrome(state)}
        />
      )}

      {field.help ? (
        <div style={{ fontSize: 11, color: "var(--mv3-muted)", marginTop: 4 }}>
          {field.help}
        </div>
      ) : null}
    </div>
  );
}

/** Single-pick chip row (frame 33 Period/Tone chips). Tap again to clear. */
function ChipSelect({
  label,
  options,
  value,
  invalid,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 7,
        ...(invalid
          ? {
              border: "1.5px solid var(--mv3-amber)",
              borderRadius: 14,
              padding: 6,
            }
          : {}),
      }}
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              onChange(active ? "" : opt);
            }}
            style={{
              flexShrink: 0,
              minHeight: 40,
              padding: "8px 14px",
              borderRadius: 99,
              fontSize: 12.5,
              fontFamily: "inherit",
              cursor: "pointer",
              whiteSpace: "nowrap",
              // Frame 33 selected chip: inverted (text-on-bg swap).
              background: active ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
              border: active
                ? "1px solid var(--mv3-text)"
                : "1px solid var(--mv3-btn2-border)",
              color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
              fontWeight: active ? 600 : 400,
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ url control ------------------------------ */

/**
 * Frame 49's url kind: a mono `https://` affix, paste normalization (strips
 * `utm_*` params, adds https), and a live reachability dot — a no-cors HEAD
 * probe with a short timeout that is NEUTRAL on failure and never blocks.
 *
 * Stored value = the full normalized URL (`https://…`) so composePrompt gets
 * something runnable; the visible field holds the bare host/path.
 */
function normalizeUrlPaste(raw: string): string {
  let bare = raw.trim().replace(/^https?:\/\//i, "");
  if (!bare) return "";
  try {
    const u = new URL(`https://${bare}`);
    for (const k of [...u.searchParams.keys()]) {
      if (k.toLowerCase().startsWith("utm_")) u.searchParams.delete(k);
    }
    bare = u.toString().replace(/^https:\/\//, "").replace(/\/$/, "");
  } catch {
    /* not URL-shaped yet — keep the typed text as-is */
  }
  return bare;
}

function SheetUrlInput({
  label,
  placeholder,
  value,
  invalid,
  focused,
  onFocusChange,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  invalid: boolean;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
  onChange: (value: string) => void;
}) {
  const bare = value.replace(/^https?:\/\//i, "");
  const [reachable, setReachable] = useState(false);
  const probeSeq = useRef(0);

  // Debounced reachability probe — feature-light, neutral on any failure.
  useEffect(() => {
    setReachable(false);
    const host = bare.split(/[/?#]/)[0] ?? "";
    if (!/^[^\s]+\.[a-z]{2,}$/i.test(host)) return;
    const seq = ++probeSeq.current;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      const kill = window.setTimeout(() => ctrl.abort(), 2_500);
      fetch(`https://${bare}`, {
        method: "HEAD",
        mode: "no-cors",
        signal: ctrl.signal,
      })
        .then(() => {
          if (probeSeq.current === seq) setReachable(true);
        })
        .catch(() => {
          /* unreachable / CORS-opaque failure → stay neutral, never block */
        })
        .finally(() => window.clearTimeout(kill));
    }, 600);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [bare]);

  const commit = (nextBare: string) =>
    onChange(nextBare ? `https://${nextBare}` : "");

  return (
    <div
      style={{
        ...fieldChrome(focused ? "focus" : invalid ? "invalid" : "rest"),
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 14px",
      }}
    >
      {/* The https:// affix (frame 49) — mono, quiet, not editable. */}
      <span
        aria-hidden
        style={{
          fontFamily: mv3Mono,
          fontSize: 12.5,
          color: "var(--mv3-micro)",
          flexShrink: 0,
        }}
      >
        https://
      </span>
      <input
        aria-label={label}
        type="text"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder?.replace(/^https?:\/\//i, "") ?? "yoursite.com"}
        value={bare}
        onFocus={() => onFocusChange(true)}
        onBlur={() => {
          onFocusChange(false);
          commit(normalizeUrlPaste(bare));
        }}
        onChange={(e) => commit(e.target.value.replace(/^https?:\/\//i, ""))}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (!text) return;
          e.preventDefault();
          commit(normalizeUrlPaste(text));
        }}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          fontSize: 16,
          padding: "12px 0",
          color: "var(--mv3-text)",
          fontFamily: "inherit",
        }}
      />
      {reachable ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10,
            color: "var(--mv3-green)",
            flexShrink: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--mv3-green)",
            }}
          />
          reachable
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------ tags control ----------------------------- */

/**
 * Frame 49's memory-suggested chips, from REAL stores only (feature-detected;
 * any error or an empty store renders nothing):
 *   · contacts (`/contacts` — the Memory page's People segment) → short
 *     `displayName`s, and
 *   · memory items (`/memory-items`) whose `subject` is chip-short.
 * Filtered by the in-field draft when the user is typing.
 */
function useMemoryTagSuggestions(
  existing: string[],
  draft: string,
): string[] {
  const assistantId = useActiveAssistantId();
  const memories = useQuery({
    ...memoryitemsGetOptions({
      path: { assistant_id: assistantId },
      query: { limit: 100 },
    }),
    staleTime: 60_000,
    retry: false,
  });
  const contacts = useQuery({
    ...contactsGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 60_000,
    retry: false,
  });
  const contactItems = (
    contacts.data as { contacts?: unknown[] } | undefined
  )?.contacts;
  return useMemo(() => {
    const candidates: string[] = [];
    for (const raw of contactItems ?? []) {
      const name = (raw as { displayName?: unknown }).displayName;
      if (typeof name === "string") candidates.push(name);
    }
    for (const raw of memories.data?.items ?? []) {
      const subject = (raw as { subject?: unknown }).subject;
      if (typeof subject === "string") candidates.push(subject);
    }
    const taken = new Set(existing.map((t) => t.toLowerCase()));
    const needle = draft.trim().toLowerCase();
    const out: string[] = [];
    for (const c of candidates) {
      const s = c.trim();
      if (s.length < 2 || s.length > 24 || s.includes("\n")) continue;
      const key = s.toLowerCase();
      if (taken.has(key) || out.some((o) => o.toLowerCase() === key)) continue;
      if (needle && !key.includes(needle)) continue;
      out.push(s);
      if (out.length >= 2) break;
    }
    return out;
  }, [contactItems, memories.data?.items, existing, draft]);
}

/** Removable chips + inline add field (desktop TagsInput, v3-skinned). */
function SheetTagsInput({
  label,
  placeholder,
  invalid,
  values,
  focused,
  onFocusChange,
  onChange,
}: {
  label: string;
  placeholder?: string;
  invalid: boolean;
  values: string[];
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  // Frame 49: memory-suggested chips under the field (real store, or nothing).
  const suggestions = useMemoryTagSuggestions(values, draft);

  const commit = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "").trim();
    if (!tag || values.includes(tag)) {
      setDraft("");
      return;
    }
    haptic.light();
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
    <>
    <div
      style={{
        ...fieldChrome(focused ? "focus" : invalid ? "invalid" : "rest"),
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        padding: "8px 12px",
      }}
    >
      {values.map((tag) => (
        <span
          key={tag}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--mv3-micro)",
            background:
              "color-mix(in srgb, var(--mv3-accent) 14%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--mv3-accent) 30%, transparent)",
            borderRadius: 99,
            padding: "5px 6px 5px 11px",
          }}
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => {
              haptic.light();
              onChange(values.filter((t) => t !== tag));
            }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 20,
              height: 20,
              borderRadius: 99,
              border: "none",
              background: "transparent",
              color: "var(--mv3-muted)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "inherit",
              padding: 0,
            }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        placeholder={values.length === 0 ? placeholder : undefined}
        value={draft}
        onFocus={() => onFocusChange(true)}
        onBlur={() => {
          onFocusChange(false);
          commit(draft);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1,
          minWidth: "9ch",
          background: "transparent",
          border: "none",
          outline: "none",
          fontSize: 16,
          padding: "4px 0",
          color: "var(--mv3-text)",
          fontFamily: "inherit",
        }}
      />
    </div>
    {/* Memory-suggested dashed chips (frame 49). */}
    {suggestions.length > 0 ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          marginTop: 7,
        }}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="cue-pressable"
            aria-label={`Add suggested tag ${s}`}
            onClick={() => {
              haptic.light();
              onChange([...values, s]);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11.5,
              color: "var(--mv3-muted)",
              background: "transparent",
              border:
                "1px dashed color-mix(in srgb, var(--mv3-micro) 40%, transparent)",
              borderRadius: 99,
              padding: "4px 11px",
              minHeight: 26,
              cursor: "pointer",
              fontFamily: "inherit",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            ＋ {s}
          </button>
        ))}
        <span style={{ fontSize: 9.5, color: "var(--mv3-faint)" }}>
          suggested from memory
        </span>
      </div>
    ) : null}
    </>
  );
}
