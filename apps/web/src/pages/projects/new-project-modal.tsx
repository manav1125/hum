/**
 * New Project modal — emoji + title + category + color + a Context brief.
 *
 * The brief is the whole point of a project in the cowork model: whatever the
 * user writes here, Cue reads before working ANY task filed under the project.
 * We say so explicitly under the textarea so the field earns its prominence.
 */

import { useState } from "react";

import { C, mono, serif } from "@/domains/activity/theme";

import {
  CATEGORY_ORDER,
  CATEGORY_LABEL,
  PROJECT_COLORS,
  PROJECT_EMOJI,
} from "./project-kit";
import { useCreateProject } from "./use-projects";

export function NewProjectModal({
  assistantId,
  onClose,
  onCreated,
}: {
  assistantId: string;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const create = useCreateProject(assistantId);
  const [emoji, setEmoji] = useState<string>(PROJECT_EMOJI[0]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("personal");
  const [customCategory, setCustomCategory] = useState("");
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [context, setContext] = useState("");

  const effectiveCategory =
    category === "__custom" ? customCategory.trim() : category;
  const canSubmit = title.trim().length > 0 && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          title: title.trim(),
          emoji,
          color,
          ...(effectiveCategory ? { category: effectiveCategory } : {}),
          ...(context.trim() ? { context: context.trim() } : {}),
        },
      },
      {
        onSuccess: (res) => {
          const id = res?.project?.id;
          if (id) onCreated(id);
          else onClose();
        },
      },
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb, #000 42%, transparent)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: C.surface,
          border: `1px solid ${C.line2}`,
          borderRadius: 16,
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.5)",
          padding: "22px 22px 20px",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 11,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.violet,
          }}
        >
          New project
        </div>
        <div
          style={{
            fontFamily: serif,
            fontSize: 25,
            letterSpacing: "-0.4px",
            color: C.ink,
            marginTop: 2,
            marginBottom: 18,
          }}
        >
          A home for related work.
        </div>

        {/* Emoji + title on one row */}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div>
            <FieldLabel>Icon</FieldLabel>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(8, 1fr)",
                gap: 4,
                width: 232,
              }}
            >
              {PROJECT_EMOJI.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEmoji(e)}
                  aria-pressed={emoji === e}
                  style={{
                    fontSize: 16,
                    height: 26,
                    borderRadius: 7,
                    cursor: "pointer",
                    border: `1px solid ${emoji === e ? C.ink : C.line}`,
                    background: emoji === e ? C.sunken : "transparent",
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Title</FieldLabel>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="e.g. Q3 launch, Home renovation…"
            style={inputStyle}
          />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <FieldLabel>Category</FieldLabel>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
              <option value="__custom">Custom…</option>
            </select>
            {category === "__custom" ? (
              <input
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="Category name"
                style={{ ...inputStyle, marginTop: 6 }}
              />
            ) : null}
          </div>
          <div>
            <FieldLabel>Color</FieldLabel>
            <div
              style={{ display: "flex", gap: 6, flexWrap: "wrap", width: 168 }}
            >
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: c,
                    cursor: "pointer",
                    border:
                      color === c
                        ? `2px solid ${C.ink}`
                        : `2px solid transparent`,
                    outline: color === c ? `1px solid ${C.line2}` : "none",
                    outlineOffset: 1,
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <FieldLabel>Context / brief</FieldLabel>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="What's this project about? Goals, constraints, who's involved, tone, links…"
            rows={4}
            style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
          />
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              marginTop: 6,
              fontSize: 11.5,
              color: C.t3,
            }}
          >
            <span style={{ color: C.violet }}>▸</span>
            Cue reads this before working any task in this project.
          </div>
        </div>

        {create.isError ? (
          <div style={{ marginTop: 12, fontSize: 12.5, color: C.danger }}>
            Couldn’t create the project — try again in a moment.
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <button type="button" onClick={onClose} style={ghostBtn}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "default",
            }}
          >
            {create.isPending ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 10.5,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: C.t3,
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 14,
  color: C.ink,
  background: C.bg,
  border: `1px solid ${C.line2}`,
  borderRadius: 9,
  padding: "9px 11px",
  outline: "none",
};

const ghostBtn: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  padding: "8px 14px",
  borderRadius: 9,
  border: `1px solid ${C.line2}`,
  background: "transparent",
  color: C.t2,
  cursor: "pointer",
};

const primaryBtn: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  padding: "8px 16px",
  borderRadius: 9,
  border: "none",
  background: C.ink,
  color: C.bg,
};
