/**
 * Mv3NewProjectSheet — the mobile v3 structured new-project sheet (spec frame
 * 42): name + emoji picker row + color dots + category chips, submitting via
 * the real POST /projects (`useCreateProject`).
 *
 * HONESTY NOTE — the frame's button reads "Create — Cue drafts the brief",
 * but the daemon's create route takes a literal optional `context` string and
 * has NO drafting path (no LLM hop anywhere in project create). So the button
 * is the honest "Create project", the brief starts empty, and the sub-note
 * points at the brief card on the project page (which Cue really does read
 * before every run). Options mirror desktop's new-project-modal exactly:
 * PROJECT_EMOJI / PROJECT_COLORS / the category taxonomy incl. free-text
 * custom; desktop's modal has no mission link, so none is invented here.
 * "Just tell Cue instead ›" keeps the conversational path (+ Create surface).
 */
import { useState } from "react";
import { useNavigate } from "react-router";

import { SheetShell, rise } from "@/mobile-v3";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  PROJECT_COLORS,
  PROJECT_EMOJI,
} from "./project-kit";
import { useCreateProject } from "./use-projects";

export function Mv3NewProjectSheet({
  assistantId,
  open,
  onClose,
  onCreated,
}: {
  assistantId: string;
  open: boolean;
  onClose: () => void;
  /**
   * When set, the sheet hands the created project back to the caller instead
   * of navigating into it (the batch add-tasks flow returns to its own sheet
   * with the new project selected).
   */
  onCreated?: (project: { id: string; title: string }) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateProject(assistantId);
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState<string>(PROJECT_EMOJI[0]);
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const [category, setCategory] = useState<string>("personal");
  const [customCategory, setCustomCategory] = useState("");

  const effectiveCategory =
    category === "__custom" ? customCategory.trim() : category;
  const canSubmit = title.trim().length > 0 && !create.isPending;

  const submit = () => {
    if (!canSubmit) return;
    haptic.medium();
    create.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          title: title.trim(),
          emoji,
          color,
          ...(effectiveCategory ? { category: effectiveCategory } : {}),
        },
      },
      {
        onSuccess: (res) => {
          haptic.success();
          onClose();
          const project = res?.project;
          if (!project) return;
          if (onCreated) onCreated({ id: project.id, title: project.title });
          else navigate(routes.project(project.id));
        },
      },
    );
  };

  return (
    <SheetShell open={open} onClose={onClose} label="New project">
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: "var(--mv3-text)",
          ...rise(0.02),
        }}
      >
        New project
      </div>

      {/* Selected emoji tile + name (frame 42's top row). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginTop: 11,
          ...rise(0.08),
        }}
      >
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "color-mix(in srgb, var(--mv3-accent) 18%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {emoji}
        </span>
        <input
          autoFocus
          aria-label="Project name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="e.g. Q3 launch, Home renovation…"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            fontSize: 16,
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1.5px solid var(--mv3-accent)",
            borderRadius: 12,
            padding: "10px 13px",
            outline: "none",
            fontFamily: "inherit",
          }}
        />
      </div>

      {/* Emoji picker row — desktop's PROJECT_EMOJI, horizontally scrollable. */}
      <div
        role="radiogroup"
        aria-label="Project icon"
        style={{
          display: "flex",
          gap: 6,
          marginTop: 10,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          paddingBottom: 2,
          ...rise(0.14),
        }}
      >
        {PROJECT_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={emoji === e}
            aria-label={`Icon ${e}`}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setEmoji(e);
            }}
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 12,
              fontSize: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background:
                emoji === e
                  ? "color-mix(in srgb, var(--mv3-accent) 18%, transparent)"
                  : "var(--mv3-btn2-bg)",
              border:
                emoji === e
                  ? "1.5px solid var(--mv3-accent)"
                  : "1px solid var(--mv3-btn2-border)",
            }}
          >
            {e}
          </button>
        ))}
      </div>

      {/* Color dots — desktop's PROJECT_COLORS as frame-42 26px dots. */}
      <div
        role="radiogroup"
        aria-label="Project color"
        style={{
          display: "flex",
          gap: 6,
          marginTop: 10,
          flexWrap: "wrap",
          ...rise(0.2),
        }}
      >
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={`Color ${c}`}
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              setColor(c);
            }}
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: c,
              border: "none",
              cursor: "pointer",
              padding: 0,
              opacity: color === c ? 1 : 0.55,
              boxShadow:
                color === c
                  ? "0 0 0 2px color-mix(in srgb, var(--mv3-text) 25%, transparent)"
                  : "none",
            }}
          />
        ))}
      </div>

      {/* Category chips — desktop's taxonomy verbatim, incl. free-text custom. */}
      <div
        role="radiogroup"
        aria-label="Category"
        style={{ display: "flex", gap: 7, marginTop: 12, flexWrap: "wrap", ...rise(0.26) }}
      >
        {[
          ...CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
          { key: "__custom", label: "Custom…" },
        ].map((c) => {
          const selected = category === c.key;
          return (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={selected}
              className="cue-pressable"
              onClick={() => {
                haptic.light();
                setCategory(c.key);
              }}
              style={{
                fontSize: 12.5,
                fontWeight: selected ? 600 : 400,
                color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
                background: selected ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
                border: selected
                  ? "1px solid transparent"
                  : "1px solid var(--mv3-btn2-border)",
                borderRadius: 99,
                padding: "7px 15px",
                minHeight: 34,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      {category === "__custom" ? (
        <input
          aria-label="Custom category name"
          value={customCategory}
          onChange={(e) => setCustomCategory(e.target.value)}
          placeholder="Category name"
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 44,
            fontSize: 16,
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 12,
            padding: "8px 13px",
            outline: "none",
            fontFamily: "inherit",
            marginTop: 8,
          }}
        />
      ) : null}

      {create.isError ? (
        <div style={{ fontSize: 11.5, color: "var(--mv3-amber-text)", marginTop: 10 }}>
          Couldn’t create the project — try again in a moment.
        </div>
      ) : null}

      <button
        type="button"
        className="cue-pressable"
        disabled={!canSubmit}
        onClick={submit}
        style={{
          width: "100%",
          background: "var(--mv3-text)",
          color: "var(--mv3-bg)",
          border: "none",
          borderRadius: 12,
          padding: 12,
          minHeight: 44,
          fontSize: 13.5,
          fontWeight: 600,
          fontFamily: "inherit",
          marginTop: 12,
          cursor: canSubmit ? "pointer" : "default",
          opacity: canSubmit ? 1 : 0.55,
          ...rise(0.32),
        }}
      >
        {create.isPending ? "Creating…" : "Create project"}
      </button>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--mv3-muted)",
          marginTop: 8,
          textAlign: "center",
        }}
      >
        The brief starts empty — add it on the project page and Cue reads it
        before every run.
      </div>

      {/* The conversational escape — the + Create surface that exists today. */}
      <button
        type="button"
        className="cue-pressable"
        onClick={() => {
          haptic.light();
          onClose();
          navigate(routes.create);
        }}
        style={{
          display: "block",
          width: "100%",
          background: "transparent",
          border: "none",
          color: "var(--mv3-micro)",
          fontSize: 12.5,
          fontFamily: "inherit",
          padding: 10,
          minHeight: 44,
          marginTop: 4,
          cursor: "pointer",
          textAlign: "center",
        }}
      >
        Just tell Cue instead ›
      </button>
    </SheetShell>
  );
}
