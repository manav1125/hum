import type { MemoryType } from "@vellumai/design-library";

import { sourceTypeLabel, type MemoryItem } from "./types";

/**
 * Per-memory-type color tokens. Light values are taken verbatim from
 * surfaces/Memory.dc.html (the faithful mock port); under the dark/velvet
 * themes each triplet swaps to a dark-book leg (lightened `text`, translucent
 * `wash`) via the scoped CSS below — the failure-card pattern. `dot` is the
 * chip/card dot, `text` the DM Mono label color, and `wash` the soft
 * background used by the "N sources" chip.
 *
 * Consumers must render inside `.cue-memory-kinds` (MemoryRow scopes itself;
 * the memories page scopes its root for the filter chips + provenance rail)
 * and mount `<MemoryKindStyles />` once (duplicate <style> tags are inert).
 */
const kindVars = (kind: string) => ({
  dot: `var(--memk-${kind}-dot)`,
  text: `var(--memk-${kind}-text)`,
  wash: `var(--memk-${kind}-wash)`,
});

export const TYPE_COLORS: Record<
  MemoryType,
  { dot: string; text: string; wash: string }
> = {
  semantic: kindVars("semantic"),
  prospective: kindVars("prospective"),
  procedural: kindVars("procedural"),
  episodic: kindVars("episodic"),
  emotional: kindVars("emotional"),
  behavioral: kindVars("behavioral"),
  narrative: kindVars("narrative"),
  shared: kindVars("shared"),
};

/** Scope class the kind vars resolve under. */
export const MEMORY_KIND_SCOPE = "cue-memory-kinds";

/**
 * Scoped theme legs for the kind triplets. Light = the Memory.dc.html mock
 * literals unchanged; dark/velvet follow the `--mv1-*` dark-book convention
 * (accent text lightens for contrast on ink, washes become translucent
 * accent tints).
 */
const MEMORY_KIND_CSS = `
.cue-memory-kinds {
  --memk-semantic-dot: #3d6ee8; --memk-semantic-text: #2b53c4; --memk-semantic-wash: #dbe4fb;
  --memk-prospective-dot: #7f77dd; --memk-prospective-text: #534ab7; --memk-prospective-wash: #eeedfb;
  --memk-procedural-dot: #0e8c8c; --memk-procedural-text: #0e8c8c; --memk-procedural-wash: #e0f0ef;
  --memk-episodic-dot: #c98a1b; --memk-episodic-text: #9a6a14; --memk-episodic-wash: #fbf0da;
  --memk-emotional-dot: #e24b4a; --memk-emotional-text: #e24b4a; --memk-emotional-wash: #fbe3e3;
  --memk-behavioral-dot: #5a57c4; --memk-behavioral-text: #5a57c4; --memk-behavioral-wash: #e7e7f7;
  --memk-narrative-dot: #b5683a; --memk-narrative-text: #b5683a; --memk-narrative-wash: #f3e4db;
  --memk-shared-dot: #b0479b; --memk-shared-text: #b0479b; --memk-shared-wash: #f5e2f0;
}
[data-theme="dark"] .cue-memory-kinds,
[data-theme="velvet"] .cue-memory-kinds {
  --memk-semantic-text: #86a9f2; --memk-semantic-wash: rgba(61, 110, 232, 0.18);
  --memk-prospective-text: #a9a2f0; --memk-prospective-wash: rgba(127, 119, 221, 0.18);
  --memk-procedural-text: #4fc7c7; --memk-procedural-wash: rgba(14, 140, 140, 0.2);
  --memk-episodic-text: #d9a84e; --memk-episodic-wash: rgba(201, 138, 27, 0.18);
  --memk-emotional-text: #eb7a79; --memk-emotional-wash: rgba(226, 75, 74, 0.16);
  --memk-behavioral-text: #9b99e5; --memk-behavioral-wash: rgba(90, 87, 196, 0.2);
  --memk-narrative-text: #d89a6e; --memk-narrative-wash: rgba(181, 104, 58, 0.18);
  --memk-shared-text: #d97fc6; --memk-shared-wash: rgba(176, 71, 155, 0.18);
}
`;

/** Injects the kind-triplet theme legs. Duplicate mounts are inert. */
export function MemoryKindStyles() {
  return <style>{MEMORY_KIND_CSS}</style>;
}

const KIND_LABELS: Record<MemoryType, string> = {
  semantic: "Semantic",
  prospective: "Prospective",
  procedural: "Procedural",
  episodic: "Episodic",
  emotional: "Emotional",
  behavioral: "Behavioral",
  narrative: "Narrative",
  shared: "Shared",
};

const MONO = "'DM Mono', monospace";

export function kindColors(kind: string): {
  dot: string;
  text: string;
  wash: string;
} {
  return TYPE_COLORS[kind as MemoryType] ?? TYPE_COLORS.semantic;
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as MemoryType] ?? kind;
}

function confLabel(confidence?: number | null): string | null {
  return typeof confidence === "number" ? confidence.toFixed(2) : null;
}

interface MemoryRowProps {
  item: MemoryItem;
  /** True when this card is the one driving the provenance rail. */
  selected: boolean;
  /** Select this memory (drives the right rail). */
  onSelect: (item: MemoryItem) => void;
  /** Open the inline editor for this memory. */
  onEdit: (item: MemoryItem) => void;
  /** Forget (delete) this memory — opens the confirm dialog upstream. */
  onForget: (item: MemoryItem) => void;
  /** True while editing this row inline. */
  editing: boolean;
  /** Current draft text while editing. */
  draft: string;
  onDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  /** True while this row's save/delete request is in flight. */
  isSaving: boolean;
}

/**
 * A single memory card — a faithful translation of the "Ready"-state cards in
 * surfaces/Memory.dc.html. Top row: colored dot + DM Mono type label + right
 * "conf {confidence}". Statement at 14px/500. Bottom row: provenance chips
 * (a type-washed "{reinforcementCount} sources" chip + a sunken source-type
 * chip) and right-aligned Edit / Forget actions. The selected card takes the
 * #3D6EE8 border + #FAFBFF fill that drives the provenance rail.
 */
export function MemoryRow({
  item,
  selected,
  onSelect,
  onEdit,
  onForget,
  editing,
  draft,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  isSaving,
}: MemoryRowProps) {
  const c = kindColors(item.kind);
  const conf = confLabel(item.confidence);
  const source = sourceTypeLabel(item.sourceType);
  const reinforcement = item.reinforcementCount ?? 0;

  return (
    <div
      className={MEMORY_KIND_SCOPE}
      onClick={() => onSelect(item)}
      style={{
        border: `1px solid ${selected ? "var(--accent-cue)" : "var(--border-base)"}`,
        borderRadius: 13,
        padding: "13px 15px",
        background: selected
          ? "color-mix(in srgb, var(--accent-cue) 5%, var(--surface-lift))"
          : "var(--surface-lift)",
        cursor: "pointer",
      }}
    >
      <MemoryKindStyles />
      {/* Top row: dot + TYPE + confidence */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 3,
            background: c.dot,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: ".06em",
            color: c.text,
            textTransform: "uppercase",
          }}
        >
          {kindLabel(item.kind)}
        </span>
        {conf !== null ? (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: MONO,
              fontSize: 10,
              color: "var(--content-tertiary)",
            }}
          >
            conf {conf}
          </span>
        ) : null}
      </div>

      {/* Statement (or inline editor) */}
      {editing ? (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveEdit();
              if (e.key === "Escape") onCancelEdit();
            }}
            disabled={isSaving}
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "var(--content-default)",
              background: "var(--field-bg)",
              border: "1px solid var(--accent-cue)",
              borderRadius: 8,
              padding: "7px 10px",
              outline: "none",
              fontFamily: "'DM Sans', system-ui, sans-serif",
            }}
          />
          <div style={{ display: "flex", gap: 7 }}>
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={isSaving || draft.trim().length === 0}
              style={{
                fontSize: 11.5,
                background: "var(--primary-base)",
                color: "var(--content-inset)",
                border: "none",
                borderRadius: 8,
                padding: "6px 12px",
                cursor: "pointer",
                opacity: isSaving || draft.trim().length === 0 ? 0.5 : 1,
              }}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={isSaving}
              style={{
                fontSize: 11.5,
                background: "transparent",
                color: "var(--content-secondary)",
                border: "1px solid var(--border-base)",
                borderRadius: 8,
                padding: "6px 12px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: "var(--content-default)",
          }}
        >
          {item.statement}
        </div>
      )}

      {/* Bottom row: provenance chips + actions */}
      {!editing ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 9,
            flexWrap: "wrap",
          }}
        >
          {reinforcement > 0 ? (
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 5,
                background: c.wash,
                color: c.text,
              }}
            >
              {reinforcement} sources
            </span>
          ) : null}
          {source ? (
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 5,
                background: "var(--surface-base)",
                color: "var(--content-secondary)",
              }}
            >
              {source}
            </span>
          ) : null}
          <span style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(item);
              }}
              style={{
                fontSize: 11.5,
                color: "var(--content-secondary)",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onForget(item);
              }}
              style={{
                fontSize: 11.5,
                color: "var(--mv1-danger)",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              Forget
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
