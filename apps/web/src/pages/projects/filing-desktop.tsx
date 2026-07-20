/**
 * Desktop filing + dismiss kit — frames D2/D3 of docs/design/hq-filing
 * (the serif ink-on-#F4F3EF product system; deliberately NOT the v3 glass).
 *
 * · `AutoFiledPill`     — "✨ auto-filed → Seed raise · Move ›" inline on
 *                         auto-filed rows; Move › reveals on row hover
 *                         (always visible on touch).
 * · `RefilePopover`     — the anchored "Where does this belong?" picker with
 *                         the current pick marked and the 🧠 teaching close.
 * · `HoverX`            — the hover-revealed circular ✕ on task rows.
 * · `useDesktopDismiss` — dismiss-core wired to the ink-dark centered undo
 *                         pill ("Archived — Cue learns from what you skip ·
 *                         Undo ⌘Z"); ⌘Z restores while the pill shows.
 * · `FilingKitStyle`    — the hover-reveal CSS + rise keyframes; mount once
 *                         per surface that uses the pieces above.
 *
 * All writes ride the SAME daemon endpoints as mobile: the full-record
 * work-item PATCH via dismiss-core (archive/undo) and `usePatchWorkItem`
 * (re-file). The daemon clears ✨ provenance on a user move by itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { C, mono } from "@/domains/activity/theme";
import type { HqWorkItem } from "@/pages/hq/use-missions";

import { useDismissEngine } from "./dismiss-core";

const wash = (accent: string, pct: number) =>
  `color-mix(in srgb, ${accent} ${pct}%, transparent)`;

/* ------------------------------- hover style ------------------------------ */

/**
 * Hover-reveal grammar (frame D2/D3): `.cue-filing-reveal` children of a
 * `[data-filing-row]` fade in on row hover/focus; on touch devices they stay
 * visible. Mount once per surface.
 */
export function FilingKitStyle() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: [
          "[data-filing-row] .cue-filing-reveal{opacity:0;transition:opacity .15s ease}",
          "[data-filing-row]:hover .cue-filing-reveal,[data-filing-row]:focus-within .cue-filing-reveal{opacity:1}",
          "@media (hover:none){[data-filing-row] .cue-filing-reveal{opacity:1}}",
          "@keyframes cueFilingRise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
          "@media (prefers-reduced-motion:reduce){.cue-filing-rise{animation:none !important}}",
        ].join("\n"),
      }}
    />
  );
}

/* ----------------------------- ✨ provenance pill --------------------------- */

/**
 * Frame D2's inline provenance pill. Render inside an element carrying
 * `data-filing-row` so "Move ›" hover-reveals.
 */
export function AutoFiledPill({
  projectTitle,
  onMove,
}: {
  projectTitle: string;
  onMove?: () => void;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: C.blueS,
        background: wash(C.blue, 8),
        border: `1px solid ${wash(C.blue, 22)}`,
        borderRadius: 99,
        padding: "5px 12px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span aria-hidden>✨</span>
      auto-filed → <b style={{ color: C.t1 }}>{projectTitle}</b>
      {onMove ? (
        <button
          type="button"
          className="cue-filing-reveal"
          aria-label={`Move out of ${projectTitle}`}
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
          style={{
            border: "none",
            background: "none",
            color: C.blue,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            padding: "2px 0 2px 2px",
            marginLeft: 2,
            fontFamily: "inherit",
          }}
        >
          Move ›
        </button>
      ) : null}
    </span>
  );
}

/* ------------------------------ refile popover ---------------------------- */

export interface RefileTarget {
  id: string;
  title: string;
  emoji: string | null;
}

/**
 * Frame D2's anchored "Where does this belong?" popover. The caller positions
 * it (usually `position:absolute; top:calc(100% + 8px); right:12px` inside a
 * `position:relative` row) and owns dismissal (outside-click / Escape).
 */
export function RefilePopover({
  targets,
  currentId,
  busy = false,
  onPick,
  onNew,
  onClose,
  style,
}: {
  targets: RefileTarget[];
  currentId?: string | null;
  busy?: boolean;
  onPick: (projectId: string) => void;
  onNew?: () => void;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Where does this belong?"
      className="cue-filing-rise"
      style={{
        width: 280,
        background: C.surface,
        border: `1px solid ${C.line2}`,
        borderRadius: 16,
        boxShadow: "0 30px 60px -20px rgba(11,23,54,0.35)",
        padding: 12,
        zIndex: 30,
        animation: "cueFilingRise .25s ease both",
        opacity: busy ? 0.6 : 1,
        pointerEvents: busy ? "none" : "auto",
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: C.t1,
          padding: "2px 4px 8px",
        }}
      >
        Where does this belong?
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {targets.map((t) => {
          const current = t.id === currentId;
          return (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              disabled={current || busy}
              onClick={() => onPick(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 10px",
                borderRadius: 10,
                textAlign: "left",
                fontFamily: "inherit",
                cursor: current ? "default" : "pointer",
                background: current ? wash(C.blue, 9) : "transparent",
                border: current
                  ? `1.5px solid ${C.blue}`
                  : "1.5px solid transparent",
                color: C.t1,
              }}
            >
              <span aria-hidden style={{ fontSize: 13 }}>
                {t.emoji ?? "📁"}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: current ? 600 : 400,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.title}
              </span>
              {current ? (
                <span style={{ fontSize: 10, color: C.blue }}>current</span>
              ) : null}
            </button>
          );
        })}
        {onNew ? (
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={onNew}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 10px",
              border: `1px dashed ${wash(C.ink, 18)}`,
              borderRadius: 10,
              background: "transparent",
              color: C.t2,
              textAlign: "left",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            <span aria-hidden style={{ fontSize: 13, color: C.blue }}>
              ＋
            </span>
            <span style={{ fontSize: 13 }}>New project</span>
          </button>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          justifyContent: "center",
          paddingTop: 9,
        }}
      >
        <span aria-hidden style={{ fontSize: 11 }}>
          🧠
        </span>
        <span style={{ fontSize: 11, color: C.blue }}>
          Moving teaches Cue — next one files itself
        </span>
      </div>
    </div>
  );
}

/* ------------------------------- hover ✕ ---------------------------------- */

/**
 * Frame D3's hover-revealed dismiss ✕ — a quiet 24px circle at a row's right
 * edge. Render inside a `data-filing-row` element.
 */
export function HoverX({
  title,
  onDismiss,
}: {
  title: string;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      className="cue-filing-reveal"
      aria-label={`Dismiss task: ${title}`}
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        width: 24,
        height: 24,
        borderRadius: "50%",
        background: C.bg,
        color: C.t2,
        border: `1px solid ${C.line2}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        lineHeight: 1,
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
        fontFamily: "inherit",
      }}
    >
      ✕
    </button>
  );
}

/* --------------------------- ink undo pill + hook -------------------------- */

interface InkPill {
  key: number;
  message: string;
  tone: "default" | "error";
  onUndo?: () => void;
}

const PILL_MS = 5_000;

/** The ink-dark centered undo pill (frame D3). Deliberately constant-dark. */
function InkUndoPill({
  pill,
  onClear,
}: {
  pill: InkPill | null;
  onClear: () => void;
}) {
  const clearRef = useRef(onClear);
  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);
  useEffect(() => {
    if (!pill) return;
    const t = window.setTimeout(() => clearRef.current(), PILL_MS);
    return () => window.clearTimeout(t);
  }, [pill]);

  // ⌘Z / Ctrl+Z restores while (and only while) the pill is visible.
  useEffect(() => {
    if (!pill?.onUndo) return;
    const undo = pill.onUndo;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        clearRef.current();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pill]);

  if (!pill) return null;

  return createPortal(
    <div
      role="status"
      style={{
        position: "fixed",
        bottom: 22,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: "#1A2230",
        borderRadius: 99,
        padding: pill.onUndo ? "10px 12px 10px 18px" : "10px 18px",
        boxShadow: "0 20px 44px -14px rgba(11,23,54,0.5)",
        zIndex: 80,
        animation: "cueFilingRise .2s ease both",
      }}
    >
      <span
        style={{
          fontSize: 12.5,
          color: pill.tone === "error" ? "#E0A64B" : "#E4E7EE",
          whiteSpace: "nowrap",
        }}
      >
        {pill.message}
      </span>
      {pill.onUndo ? (
        <button
          type="button"
          onClick={() => {
            const undo = pill.onUndo;
            onClear();
            undo?.();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 12.5,
            color: "#7FA3F2",
            fontWeight: 600,
            background: "rgba(61,110,232,0.25)",
            border: "none",
            borderRadius: 99,
            padding: "6px 14px",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Undo{" "}
          <span
            style={{ fontFamily: mono, fontSize: 9.5, opacity: 0.7 }}
            aria-hidden
          >
            ⌘Z
          </span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * Desktop dismiss flow (frame D3): the shared dismiss-core engine + the
 * ink-dark undo pill with ⌘Z. Render `pillNode` once at the surface root and
 * mount `<FilingKitStyle/>` for the rise keyframes.
 */
export function useDesktopDismiss(assistantId: string): {
  dismiss: (item: HqWorkItem, opts?: { immediate?: boolean }) => void;
  gone: Set<string>;
  leavingId: string | null;
  pillNode: React.ReactNode;
} {
  const [pill, setPill] = useState<InkPill | null>(null);

  const engine = useDismissEngine(assistantId, {
    onArchived: (_item, undo) =>
      setPill({
        key: Date.now(),
        tone: "default",
        message: "Archived — Cue learns from what you skip",
        onUndo: undo,
      }),
    onArchiveError: () =>
      setPill({
        key: Date.now(),
        tone: "error",
        message: "Couldn’t archive that — try again.",
      }),
    onRestoreError: () =>
      setPill({
        key: Date.now(),
        tone: "error",
        message: "Couldn’t bring it back — it stays archived.",
      }),
  });

  const pillNode = useMemo(
    () => <InkUndoPill pill={pill} onClear={() => setPill(null)} />,
    [pill],
  );

  return { ...engine, pillNode };
}
