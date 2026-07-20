/**
 * UndoToast + useDismissTask — the shared task-hygiene primitives for the mv3
 * work surfaces (Today's review cards, All-work rows, project-detail rows,
 * came-in triage).
 *
 * · `UndoToast` — the v3 glass pill that floats above the tab bar for 5s
 *   ("Task dismissed · Undo"). One component, portaled into
 *   `#viewport-overlays`, so every surface shows the identical pill.
 * · `useDismissTask` — the one-tap ✕ flow: haptic.light → 150ms collapse
 *   (transform/opacity only; reduced-motion = instant) → the daemon's REAL
 *   full-record PATCH (`status: "archived"`, the same write the task sheet's
 *   Archive and came-in's swipe-dismiss use) → undo restores the previous
 *   status via the same PATCH. Errors restore the row and surface a quiet
 *   amber line in the same pill.
 * · `DismissX` — the quiet ✕ affordance (44pt hit target, subtle until
 *   pressed) task rows share.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useDismissEngine } from "@/pages/projects/dismiss-core";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";

const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";

/* ------------------------------- toast pill ------------------------------- */

export interface Mv3Toast {
  /** Re-arms the 5s timer when it changes. */
  key: number;
  message: string;
  /** Amber message text for quiet failure lines. */
  tone?: "default" | "error";
  actionLabel?: string;
  onAction?: () => void;
}

const TOAST_MS = 5_000;

export function UndoToast({
  toast,
  onClear,
}: {
  toast: Mv3Toast | null;
  onClear: () => void;
}) {
  // Auto-dismiss, re-armed per toast.key.
  const clearRef = useRef(onClear);
  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearRef.current(), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  const host = document.getElementById("viewport-overlays") ?? document.body;

  return createPortal(
    <div
      data-mv3
      role="status"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        // Floats above the in-flow glass tab bar (~82px incl. its padding).
        bottom: `calc(${SAFE_BOTTOM} + 92px)`,
        display: "flex",
        justifyContent: "center",
        zIndex: 55,
        pointerEvents: "none",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          maxWidth: "calc(100vw - 30px)",
          background: "var(--mv3-sheet)",
          border: "1px solid var(--mv3-sheet-border)",
          borderRadius: 99,
          // Frame 45's glass pill: 9px 10px 9px 15px with the Undo chip.
          padding: toast.actionLabel ? "9px 10px 9px 15px" : "10px 16px",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          boxShadow: "var(--mv3-glass-shadow)",
          animation: "mv3Fade .2s ease both",
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            color:
              toast.tone === "error" ? "var(--mv3-amber)" : "var(--mv3-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {toast.message}
        </span>
        {toast.actionLabel && toast.onAction ? (
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              const act = toast.onAction;
              onClear();
              act?.();
            }}
            style={{
              background:
                "color-mix(in srgb, var(--mv3-accent) 15%, transparent)",
              border: "none",
              borderRadius: 99,
              color: "var(--mv3-micro)",
              fontSize: 11.5,
              fontWeight: 600,
              fontFamily: "inherit",
              padding: "5px 12px",
              minHeight: 30,
              cursor: "pointer",
              flexShrink: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    </div>,
    host,
  );
}

/* ------------------------------ dismiss flow ------------------------------ */

/**
 * Collapse style for a row mid-dismiss. Spread AFTER the row's other styles;
 * `animation: none` cancels the entrance rise (whose fill would otherwise pin
 * opacity at the keyframe value and eat the transition).
 */
export function dismissLeave(leaving: boolean): React.CSSProperties {
  if (!leaving) return {};
  return {
    animation: "none",
    opacity: 0,
    transform: "translateX(-14px) scale(.97)",
    transition: "opacity .15s ease, transform .15s ease",
    pointerEvents: "none",
  };
}

export function useDismissTask(assistantId: string): {
  /** One-tap dismiss. `immediate` skips the collapse (the caller animated). */
  dismiss: (item: HqWorkItem, opts?: { immediate?: boolean }) => void;
  /** Optimistically-hidden ids — filter these out of the rendered list. */
  gone: Set<string>;
  /** The row currently playing its 150ms collapse. */
  leavingId: string | null;
  /** Render once at the surface root. */
  toastNode: React.ReactNode;
} {
  const [toast, setToast] = useState<Mv3Toast | null>(null);

  // The shared archive/undo engine (dismiss-core) — same PATCHes as desktop's
  // hover ✕; this hook adds the v3 glass pill + haptics on top.
  const engine = useDismissEngine(assistantId, {
    onArchived: (_item, undo) =>
      setToast({
        key: Date.now(),
        // Frame 45's honest line — archiving feeds relevance learning.
        message: "Archived — Cue learns from what you skip",
        actionLabel: "Undo",
        onAction: () => {
          haptic.light();
          undo();
        },
      }),
    onArchiveError: () =>
      setToast({
        key: Date.now(),
        tone: "error",
        message: "Couldn’t dismiss that — try again.",
      }),
    onRestoreError: () =>
      setToast({
        key: Date.now(),
        tone: "error",
        message: "Couldn’t bring it back — it stays archived.",
      }),
  });

  const dismiss = (item: HqWorkItem, opts?: { immediate?: boolean }) => {
    if (engine.gone.has(item.id) || engine.leavingId === item.id) return;
    haptic.light();
    engine.dismiss(item, opts);
  };
  const { gone, leavingId } = engine;

  const toastNode = useMemo(
    () => <UndoToast toast={toast} onClear={() => setToast(null)} />,
    [toast],
  );

  return { dismiss, gone, leavingId, toastNode };
}

/* ------------------------------- ✕ affordance ------------------------------ */

/**
 * The quiet ✕ — faint glyph, 44pt hit target, `.cue-pressable` press feedback.
 * Callers stopPropagation-wrap it when the row itself is tappable (handled
 * here so every surface behaves identically).
 */
export function DismissX({
  title,
  onDismiss,
  style,
}: {
  /** Task title, for the accessible label. */
  title: string;
  onDismiss: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={`Dismiss task: ${title}`}
      className="cue-pressable"
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        width: 44,
        height: 44,
        margin: "-10px -12px -10px -6px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: "var(--mv3-faint)",
        fontSize: 13,
        lineHeight: 1,
        cursor: "pointer",
        flexShrink: 0,
        fontFamily: "inherit",
        WebkitTapHighlightColor: "transparent",
        ...style,
      }}
    >
      ✕
    </button>
  );
}
