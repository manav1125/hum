/**
 * UndoToast + useDismissTask — the shared task-hygiene primitives for the mv3
 * work surfaces (Today's review cards, All-work rows, project-detail rows,
 * came-in triage).
 *
 * · `UndoToast` — the v3 glass pill that floats above the tab bar for 5s
 *   ("Archived … · Undo · 5s"). One component, portaled into
 *   `#viewport-overlays` (a SIBLING of the tab bar in the root overlay stack,
 *   frame 65: row-removal animations can never occlude it), so every surface
 *   shows the identical pill. The Undo chip carries a visible countdown in
 *   both resting and promoted states.
 * · `useDismissTask` — the one-tap ✕ flow: haptic.light → 150ms collapse
 *   (transform/opacity only; reduced-motion = instant) → the daemon's REAL
 *   full-record PATCH (`status: "archived"`, the same write the task sheet's
 *   Archive and came-in's swipe-dismiss use) → undo restores the previous
 *   status via the same PATCH. Errors restore the row and surface a quiet
 *   amber line in the same pill.
 * · `DismissX` — the quiet ✕ affordance (44pt hit target, subtle until
 *   pressed) task rows share.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useDismissEngine } from "@/pages/projects/dismiss-core";
import type { HqWorkItem } from "@/pages/hq/use-missions";
import { haptic } from "@/utils/haptics";

import { useAnySheetOpen } from "./sheet-shell";

const SAFE_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";
const SAFE_TOP = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

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
/** Promoted (a sheet scrim is up) — frame 47: the timer extends to 8s. */
const TOAST_PROMOTED_MS = 8_000;

export function UndoToast({
  toast,
  onClear,
}: {
  toast: Mv3Toast | null;
  onClear: () => void;
}) {
  // Frame 47's stacking RULE: while any SheetShell scrim is open the pill
  // PROMOTES to a top-anchored capsule below the Dynamic Island area, rides
  // above every scrim/sheet layer, and its timer extends to 8s. Never
  // suppressed — undo must survive the interruption.
  const promoted = useAnySheetOpen();

  // Auto-dismiss, re-armed per toast.key AND on promotion (the extend).
  const clearRef = useRef(onClear);
  useEffect(() => {
    clearRef.current = onClear;
  }, [onClear]);
  const duration = promoted ? TOAST_PROMOTED_MS : TOAST_MS;
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => clearRef.current(), duration);
    return () => window.clearTimeout(t);
  }, [toast, duration]);

  // Visible countdown on the Undo chip in BOTH states (frame 65: "Undo · 5s"
  // resting; frame 47: "Undo · 8s" promoted). Deadline-anchored so the label
  // stays honest through re-arms (new toast.key) and promotion extends.
  const [secondsLeft, setSecondsLeft] = useState(TOAST_MS / 1000);
  useEffect(() => {
    if (!toast) return;
    const deadline = Date.now() + duration;
    setSecondsLeft(Math.ceil(duration / 1000));
    const iv = window.setInterval(
      () =>
        setSecondsLeft(
          Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
        ),
      250,
    );
    return () => window.clearInterval(iv);
  }, [toast, duration]);

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
        ...(promoted
          ? // Top-anchored, below the Island (safe-area-top anchored).
            { top: `calc(${SAFE_TOP} + 14px)` }
          : // Floats above the in-flow glass tab bar (~82px incl. padding).
            { bottom: `calc(${SAFE_BOTTOM} + 92px)` }),
        display: "flex",
        justifyContent: "center",
        // Sheets portal at zIndex 60 — the promoted capsule rides above ALL
        // scrims/sheets (frame 47: never buried).
        zIndex: promoted ? 80 : 55,
        pointerEvents: "none",
        fontFamily: "var(--mv3-font)",
      }}
    >
      <div
        // Re-keyed per toast.key: a coalesced dismissal RE-ANCHORS the pill
        // (frame 65) — the entrance animation re-runs on the updated label.
        key={toast.key}
        style={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          maxWidth: "calc(100vw - 30px)",
          // Promoted = near-opaque (frame 47's capsule) so sheet content
          // never bleeds through; resting keeps frame 45's glass pill.
          background: promoted ? "var(--mv3-chip-bg)" : "var(--mv3-sheet)",
          border: "1px solid var(--mv3-sheet-border)",
          borderRadius: 99,
          // Frame 45's glass pill: 9px 10px 9px 15px with the Undo chip.
          padding: toast.actionLabel
            ? promoted
              ? "8px 9px 8px 15px"
              : "9px 10px 9px 15px"
            : "10px 16px",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          // Themed deep drop (light .3 / dark .8) — reads over any scrim.
          boxShadow: "var(--mv3-glass-shadow)",
          animation: "mv3Fade .2s ease both",
        }}
      >
        <span
          style={{
            fontSize: promoted ? 12 : 11.5,
            color:
              toast.tone === "error"
                ? "var(--mv3-amber)"
                : promoted
                  ? "var(--mv3-text)"
                  : "var(--mv3-muted)",
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
              fontSize: promoted ? 12 : 11.5,
              fontWeight: 600,
              fontFamily: "inherit",
              padding: "5px 12px",
              minHeight: 30,
              cursor: "pointer",
              flexShrink: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {`${toast.actionLabel} · ${secondsLeft}s`}
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
  // Frame 65 COALESCING: one pill max. Rapid dismissals inside the undo
  // window fold into the live pill ("2 archived — Undo" restores both): the
  // batch re-anchors the pill (new key re-arms the timer) and Undo replays
  // every archived item's restore. The batch dies with the pill (timeout,
  // Undo, or an error line replacing it).
  const undoBatchRef = useRef<Array<() => void>>([]);
  // Monotonic toast keys — Date.now() can collide on rapid dismissals and a
  // colliding key would fail to re-arm the 5s timer.
  const toastKeyRef = useRef(0);

  const nextKey = () => {
    toastKeyRef.current += 1;
    return toastKeyRef.current;
  };
  const clearToast = useCallback(() => {
    undoBatchRef.current = [];
    setToast(null);
  }, []);
  const errorToast = (message: string) => {
    undoBatchRef.current = [];
    setToast({ key: nextKey(), tone: "error", message });
  };

  // The shared archive/undo engine (dismiss-core) — same PATCHes as desktop's
  // hover ✕; this hook adds the v3 glass pill + haptics on top.
  const engine = useDismissEngine(assistantId, {
    onArchived: (_item, undo) => {
      const undos = [...undoBatchRef.current, undo];
      undoBatchRef.current = undos;
      setToast({
        key: nextKey(),
        // Frame 45's honest line — archiving feeds relevance learning;
        // coalesced batches state the count (frame 65).
        message:
          undos.length > 1
            ? `${undos.length} archived`
            : "Archived — Cue learns from what you skip",
        actionLabel: "Undo",
        onAction: () => {
          haptic.light();
          for (const u of undos) u();
        },
      });
    },
    onArchiveError: () => errorToast("Couldn’t dismiss that — try again."),
    onRestoreError: () =>
      errorToast("Couldn’t bring it back — it stays archived."),
  });

  const dismiss = (item: HqWorkItem, opts?: { immediate?: boolean }) => {
    if (engine.gone.has(item.id) || engine.leavingId === item.id) return;
    haptic.light();
    engine.dismiss(item, opts);
  };
  const { gone, leavingId } = engine;

  const toastNode = useMemo(
    () => <UndoToast toast={toast} onClear={clearToast} />,
    [toast, clearToast],
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
        color: "var(--mv3-muted)",
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
