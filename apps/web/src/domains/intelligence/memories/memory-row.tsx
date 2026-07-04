import type { MemoryType } from "@vellumai/design-library";

import { sourceTypeLabel, type MemoryItem } from "./types";

/**
 * Per-memory-type color tokens, taken verbatim from surfaces/Memory.dc.html.
 * `dot` is the chip/card dot, `text` the (sometimes darkened) DM Mono label
 * color, and `wash` the soft background used by the "N sources" chip.
 */
export const TYPE_COLORS: Record<
  MemoryType,
  { dot: string; text: string; wash: string }
> = {
  semantic: { dot: "#3D6EE8", text: "#2B53C4", wash: "#DBE4FB" },
  prospective: { dot: "#7F77DD", text: "#534AB7", wash: "#EEEDFB" },
  procedural: { dot: "#0E8C8C", text: "#0E8C8C", wash: "#E0F0EF" },
  episodic: { dot: "#C98A1B", text: "#9A6A14", wash: "#FBF0DA" },
  emotional: { dot: "#E24B4A", text: "#E24B4A", wash: "#FBE3E3" },
  behavioral: { dot: "#5A57C4", text: "#5A57C4", wash: "#E7E7F7" },
  narrative: { dot: "#B5683A", text: "#B5683A", wash: "#F3E4DB" },
  shared: { dot: "#B0479B", text: "#B0479B", wash: "#F5E2F0" },
};

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
                color: "#DA491A",
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
