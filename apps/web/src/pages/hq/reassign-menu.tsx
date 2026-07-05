/**
 * §4 · Correction — the reusable reassign menu + its teaching confirmation.
 *
 * Every auto-filed item wears a destination tag; tapping it opens this menu.
 * The current target is highlighted (✓), sibling targets are one tap away, and
 * two escape hatches close the set: "＋ New mission…" and "✕ Not a task —
 * dismiss". A correction is a lesson — {@link ReassignTeachToast} confirms it
 * out loud ("Got it — I'll file similar … next time"), the §4·B frame.
 *
 * Low-confidence items don't guess: {@link LowConfidenceFilePrompt} renders the
 * §4·C "◔ Not sure where this belongs — you tell me" ask with the same target
 * chips instead of a silent auto-file.
 *
 * All three are presentational — they call back with the chosen targetId (or
 * null for dismiss / new). The task drawer wires them to the work-item PATCH;
 * HQ's came-in rows wire them to the inbound re-file. Neither owns the mutation.
 */

import { useEffect } from "react";

import { C, mono } from "./hq-kit";

export interface ReassignTarget {
  id: string;
  title: string;
  emoji: string | null;
}

/**
 * The reassign menu. `currentId` is the highlighted destination (null when the
 * item is unfiled). `onPick` fires with a target id; `onDismiss` is the
 * "Not a task" path; `onNew` (optional) mounts the new-mission affordance.
 */
export function ReassignMenu({
  targets,
  currentId,
  busy = false,
  label = "Move to",
  onPick,
  onDismiss,
  onNew,
}: {
  targets: ReassignTarget[];
  currentId?: string | null;
  busy?: boolean;
  label?: string;
  onPick: (targetId: string) => void;
  onDismiss?: () => void;
  onNew?: () => void;
}) {
  const current = targets.find((t) => t.id === currentId) ?? null;
  const others = targets.filter((t) => t.id !== currentId);
  return (
    <div
      role="menu"
      aria-label="Reassign this item"
      style={{
        border: `1px solid ${C.line2}`,
        borderRadius: 12,
        overflow: "hidden",
        background: C.surface,
        boxShadow: "0 18px 40px -24px rgba(0,0,0,0.4)",
        opacity: busy ? 0.6 : 1,
        pointerEvents: busy ? "none" : "auto",
        minWidth: 220,
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 9.5,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.t3,
          padding: "9px 12px 6px",
        }}
      >
        {label}
      </div>
      {current ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "9px 12px",
            background: `color-mix(in srgb, ${C.blue} 13%, transparent)`,
          }}
        >
          <span aria-hidden style={{ fontSize: 14 }}>
            {current.emoji ?? "📁"}
          </span>
          <span
            style={{ fontSize: 12.5, fontWeight: 600, color: C.t1, flex: 1 }}
          >
            {current.title}
          </span>
          <span aria-hidden style={{ fontSize: 11, color: C.blueS }}>
            ✓
          </span>
        </div>
      ) : null}
      {others.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => onPick(t.id)}
          style={rowStyle}
        >
          <span aria-hidden style={{ fontSize: 14 }}>
            {t.emoji ?? "📁"}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.title}
          </span>
        </button>
      ))}
      {onNew ? (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={onNew}
          style={{
            ...rowStyle,
            color: C.blueS,
            borderTop: `1px solid ${C.line}`,
          }}
        >
          <span aria-hidden style={{ fontSize: 13 }}>
            ＋
          </span>
          <span>New mission…</span>
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={onDismiss}
          style={{
            ...rowStyle,
            color: C.t3,
            borderTop: `1px solid ${C.line}`,
            background: C.sunken,
          }}
        >
          <span aria-hidden style={{ fontSize: 12 }}>
            ✕
          </span>
          <span>Not a task — dismiss</span>
        </button>
      ) : null}
    </div>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  padding: "9px 12px",
  border: "none",
  borderTop: `1px solid ${C.line}`,
  background: "transparent",
  color: C.t2,
  fontSize: 12.5,
  cursor: "pointer",
  textAlign: "left" as const,
};

/**
 * §4·C · low confidence → asks, doesn't guess. For inbound items with no
 * projectId, this replaces a silent auto-file with an honest ask, offering the
 * same targets plus "Something else…" (→ full menu / new) and "Just a note".
 */
export function LowConfidenceFilePrompt({
  sourceLabel,
  targets,
  busy = false,
  onPick,
  onSomethingElse,
  onJustANote,
}: {
  sourceLabel?: string | null;
  targets: ReassignTarget[];
  busy?: boolean;
  onPick: (targetId: string) => void;
  onSomethingElse?: () => void;
  onJustANote?: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid color-mix(in srgb, ${C.amber} 40%, ${C.line})`,
        borderRadius: 12,
        padding: 12,
        background: `color-mix(in srgb, ${C.amber} 6%, ${C.surface})`,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12.5,
          color: C.t1,
          fontWeight: 500,
        }}
      >
        <span aria-hidden style={{ color: C.amber }}>
          ◔
        </span>
        Not sure where this belongs — you tell me.
      </div>
      {sourceLabel ? (
        <div
          style={{
            fontFamily: mono,
            fontSize: 10.5,
            color: C.t3,
            marginTop: 3,
          }}
        >
          {sourceLabel}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 7,
          marginTop: 11,
        }}
      >
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(t.id)}
            style={chipStyle}
          >
            <span aria-hidden>{t.emoji ?? "📁"}</span>
            {t.title}
          </button>
        ))}
        {onSomethingElse ? (
          <button
            type="button"
            disabled={busy}
            onClick={onSomethingElse}
            style={{ ...chipStyle, color: C.blueS }}
          >
            Something else…
          </button>
        ) : null}
        {onJustANote ? (
          <button
            type="button"
            disabled={busy}
            onClick={onJustANote}
            style={{ ...chipStyle, color: C.t3 }}
          >
            Just a note
          </button>
        ) : null}
      </div>
    </div>
  );
}

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 12,
  color: C.t1,
  background: C.surface,
  border: `1px solid ${C.line2}`,
  borderRadius: 999,
  padding: "5px 11px",
  cursor: "pointer",
};

/**
 * §4·B · the correction teaches. A dismissible confirmation that a re-file was
 * recorded as a lesson: "Got it — I'll file similar … to {destination} next
 * time." Carries an Undo affordance and (optionally) the "Why did I guess …? ›"
 * explainer. Auto-dismisses after `timeoutMs` unless the caller controls it.
 */
export function ReassignTeachToast({
  destinationTitle,
  fromTitle,
  timeoutMs = 6000,
  onUndo,
  onWhy,
  onDismiss,
}: {
  destinationTitle: string;
  fromTitle?: string | null;
  timeoutMs?: number;
  onUndo?: () => void;
  onWhy?: () => void;
  onDismiss?: () => void;
}) {
  useEffect(() => {
    if (!onDismiss || timeoutMs <= 0) return;
    const t = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(t);
  }, [onDismiss, timeoutMs]);

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        border: `1px solid color-mix(in srgb, ${C.green} 42%, ${C.line})`,
        borderRadius: 12,
        padding: "11px 13px",
        background: `color-mix(in srgb, ${C.green} 8%, ${C.surface})`,
      }}
    >
      <span
        aria-hidden
        style={{ color: C.green, fontSize: 14, lineHeight: "18px" }}
      >
        ✓
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.t1, lineHeight: 1.45 }}>
          Got it — I&rsquo;ll file similar
          {fromTitle ? ` ${fromTitle}` : ""} to{" "}
          <b style={{ color: C.t1 }}>{destinationTitle}</b> next time.
        </div>
        <div
          style={{
            display: "flex",
            gap: 14,
            marginTop: 6,
            fontFamily: mono,
            fontSize: 11,
          }}
        >
          {onUndo ? (
            <button type="button" onClick={onUndo} style={linkBtn(C.blueS)}>
              Undo
            </button>
          ) : null}
          {onWhy ? (
            <button type="button" onClick={onWhy} style={linkBtn(C.t3)}>
              Why did I guess? ›
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function linkBtn(color: string) {
  return {
    background: "none",
    border: "none",
    padding: 0,
    color,
    cursor: "pointer",
    fontFamily: mono,
    fontSize: 11,
  };
}
