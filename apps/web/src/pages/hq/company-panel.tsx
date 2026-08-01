/**
 * Company & never-lines panel — who we are (identity), where we're going
 * (direction), the hard boundaries the AI may never cross (never-lines), and
 * the workspace-level autonomy dial ("set once, override per mission").
 *
 * A modal reached from the HQ header. Saves through PUT /company-profile.
 */

import { useState } from "react";

import { C, MODE_META, mono, serif } from "./hq-kit";
import {
  useCompanyProfile,
  usePutCompanyProfile,
  type WorkspaceMode,
} from "./use-missions";

export function CompanyPanel({
  assistantId,
  onClose,
}: {
  assistantId: string;
  onClose: () => void;
}) {
  const { profile, isLoading } = useCompanyProfile(assistantId);

  return (
    <ModalShell onClose={onClose} label="Company and never-lines">
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.blueS,
        }}
      >
        Company
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
        What Cue knows before it acts.
      </div>
      {isLoading && !profile ? (
        <div style={{ fontSize: 13, color: C.t2 }}>Loading…</div>
      ) : (
        <CompanyEditor
          assistantId={assistantId}
          initial={profile}
          onClose={onClose}
        />
      )}
    </ModalShell>
  );
}

function ModalShell({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
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
          width: "min(560px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: C.surface,
          border: `1px solid ${C.line2}`,
          borderRadius: 16,
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.5)",
          padding: "22px 22px 20px",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function CompanyEditor({
  assistantId,
  initial,
  onClose,
}: {
  assistantId: string;
  initial: {
    identity: string | null;
    direction: string | null;
    neverLines: string[];
    workspaceMode: WorkspaceMode;
  } | null;
  onClose: () => void;
}) {
  const put = usePutCompanyProfile(assistantId);
  const [identity, setIdentity] = useState(initial?.identity ?? "");
  const [direction, setDirection] = useState(initial?.direction ?? "");
  const [neverLines, setNeverLines] = useState<string[]>(
    initial?.neverLines ?? [],
  );
  const [newLine, setNewLine] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>(
    initial?.workspaceMode ?? "assist",
  );

  const addLine = () => {
    const line = newLine.trim();
    if (!line) return;
    setNeverLines((prev) => [...prev, line]);
    setNewLine("");
  };

  const save = () => {
    put.mutate(
      {
        path: { assistant_id: assistantId },
        body: {
          identity: identity.trim() || null,
          direction: direction.trim() || null,
          neverLines,
          workspaceMode: mode,
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <>
      <FieldLabel>Identity — who we are</FieldLabel>
      <textarea
        value={identity}
        onChange={(e) => setIdentity(e.target.value)}
        placeholder="The company in a few lines: what you make, for whom, stage, tone…"
        rows={3}
        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
      />

      <div style={{ marginTop: 16 }}>
        <FieldLabel>Direction — where we&rsquo;re going</FieldLabel>
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="The current push: priorities, strategy, what matters this quarter…"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>

      {/* Never-lines: the hard boundaries. */}
      <div style={{ marginTop: 16 }}>
        <FieldLabel>Never-lines — Cue may never cross these</FieldLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {neverLines.map((line, i) => (
            <div
              key={`${line}-${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                border: `1px solid color-mix(in srgb, ${C.danger} 30%, ${C.line})`,
                background: `color-mix(in srgb, ${C.danger} 5%, ${C.surface})`,
                borderRadius: 10,
                padding: "8px 11px",
                fontSize: 13,
                color: C.ink,
              }}
            >
              <span aria-hidden style={{ color: C.danger, fontSize: 11 }}>
                ✕
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>{line}</span>
              <button
                type="button"
                aria-label={`Remove never-line: ${line}`}
                onClick={() =>
                  setNeverLines((prev) => prev.filter((_, idx) => idx !== i))
                }
                style={{
                  border: "none",
                  background: "none",
                  color: C.t3,
                  cursor: "pointer",
                  fontSize: 13,
                  padding: 2,
                }}
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={newLine}
              onChange={(e) => setNewLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addLine();
              }}
              placeholder="e.g. Never send money · never sign contracts · never email press"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={addLine}
              disabled={newLine.trim().length === 0}
              style={{
                ...ghostBtn,
                opacity: newLine.trim() ? 1 : 0.5,
                whiteSpace: "nowrap",
              }}
            >
              + Add
            </button>
          </div>
        </div>
        <Hint>
          Hard boundaries, enforced everywhere — no mission or agent can
          override a never-line.
        </Hint>
      </div>

      {/* Workspace mode dial. */}
      <div style={{ marginTop: 18 }}>
        <FieldLabel>Default autonomy — how much leash</FieldLabel>
        <div
          style={{
            display: "flex",
            gap: 4,
            background: C.sunken,
            borderRadius: 13,
            padding: 5,
          }}
        >
          {(["observe", "assist", "autonomous"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(m)}
                style={{
                  flex: 1,
                  textAlign: "center",
                  padding: "12px 8px",
                  borderRadius: 10,
                  border: "none",
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  background: active ? C.surface : "transparent",
                  color: active ? C.blueS : C.t2,
                  boxShadow: active
                    ? "0 6px 16px -8px rgba(20,28,44,.3)"
                    : "none",
                  cursor: "pointer",
                }}
              >
                <div aria-hidden style={{ fontSize: 16, marginBottom: 3 }}>
                  {MODE_META[m].glyph}
                </div>
                {MODE_META[m].label}
              </button>
            );
          })}
        </div>
        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "flex-start",
            marginTop: 12,
            background: C.blueW,
            borderRadius: 12,
            padding: "12px 14px",
          }}
        >
          <span aria-hidden style={{ fontSize: 16 }}>
            {MODE_META[mode].glyph}
          </span>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.blueS }}>
              {MODE_META[mode].label}
              {mode === "assist" ? " — the safe default" : ""}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: C.t2,
                marginTop: 3,
                lineHeight: 1.45,
              }}
            >
              {MODE_META[mode].blurb} Any single mission can override this.
            </div>
          </div>
        </div>
      </div>

      {put.isError ? (
        <div style={{ marginTop: 12, fontSize: 12.5, color: C.dangerText }}>
          Couldn&rsquo;t save — try again in a moment.
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
          onClick={save}
          disabled={put.isPending}
          style={{
            ...primaryBtn,
            opacity: put.isPending ? 0.6 : 1,
            cursor: put.isPending ? "default" : "pointer",
          }}
        >
          {put.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
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

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ marginTop: 6, fontSize: 11.5, color: C.t3, lineHeight: 1.45 }}
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
  background: C.blue,
  color: "#fff",
};
