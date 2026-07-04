/**
 * The project's Context brief — the single most important field on the detail
 * page. It's what makes a "project" more than a folder: whatever's written here,
 * Cue reads before working every task filed under the project.
 *
 * It reads as calm prose until clicked, then becomes an editable textarea that
 * saves on blur / ⌘↵ (PATCH /projects/:id context). The affordance is loud —
 * a violet rail + an explicit "Cue reads this…" line — so its role is obvious.
 */

import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { C, mono } from "@/domains/activity/theme";

import { usePatchProject } from "./use-projects";

export function ProjectBrief({
  assistantId,
  projectId,
  initial,
  accent,
}: {
  assistantId: string;
  projectId: string;
  initial: string | null;
  accent: string;
}) {
  const patch = usePatchProject(assistantId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial ?? "");

  // Re-sync when the canonical brief changes (e.g. another client edited it),
  // but never stomp an in-progress edit.
  useEffect(() => {
    if (!editing) setValue(initial ?? "");
  }, [initial, editing]);

  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (next === (initial ?? "").trim()) return;
    patch.mutate({
      path: { assistant_id: assistantId, id: projectId },
      body: { context: next || null },
    });
  };

  const hasBrief = (initial ?? "").trim().length > 0;

  return (
    <div
      style={{
        marginTop: 18,
        borderRadius: 12,
        border: `1px solid ${C.line}`,
        borderLeft: `3px solid ${accent}`,
        background: C.surface,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: accent,
          }}
        >
          Context brief
        </span>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit brief"
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontFamily: mono,
              fontSize: 10.5,
              color: C.t3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
            }}
          >
            <Pencil size={11} /> Edit
          </button>
        ) : (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: mono,
              fontSize: 10.5,
              color: C.t3,
            }}
          >
            {patch.isPending ? "Saving…" : "⌘↵ to save"}
          </span>
        )}
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            if (e.key === "Escape") {
              setValue(initial ?? "");
              setEditing(false);
            }
          }}
          placeholder="What's this project about? Goals, constraints, who's involved, tone, links…"
          rows={4}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 13.5,
            lineHeight: 1.55,
            color: C.ink,
            background: C.bg,
            border: `1px solid ${C.line2}`,
            borderRadius: 9,
            padding: "9px 11px",
            outline: "none",
            resize: "vertical",
          }}
        />
      ) : hasBrief ? (
        <div
          onClick={() => setEditing(true)}
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: C.t2,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            cursor: "text",
          }}
        >
          {initial}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            fontSize: 13,
            color: C.t3,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "text",
            textAlign: "left",
          }}
        >
          Add a brief so Cue works every task here with the same context…
        </button>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 10,
          fontSize: 11,
          color: C.t3,
        }}
      >
        <span style={{ color: accent }}>▸</span>
        Cue reads this before working any task in this project.
      </div>
    </div>
  );
}
