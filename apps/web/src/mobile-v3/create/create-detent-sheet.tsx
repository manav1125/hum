/**
 * Mobile v3 Create — the two-detent sheet.
 *
 * Design §3: *"Create uses two detents — 42% peek (fires the common case in two
 * taps) and 94% full (all ten types, reference drop, template rows)."*
 *
 * The shared `SheetShell` is a single-height primitive — one `maxHeight` prop, no
 * drag handling, dismissal by scrim or Escape. Its own header anticipates this
 * ("the Create-sheet conversion is a later phase"), so rather than change a
 * primitive four other surfaces depend on, Create ships its own detent-capable
 * sheet here and leaves SheetShell alone.
 *
 * What it adds over SheetShell: two snap heights, a draggable grab strip that
 * moves between them, and dismissal by dragging past the peek. What it keeps
 * identical: the scrim, Escape-to-close, the grabber's look, the safe-area
 * padding, and the entrance curve.
 *
 * Gesture handling follows `swipe-archive-row.tsx`'s hard-won rule — decide ONCE
 * per gesture what the finger means and hold that decision, rather than
 * re-testing every move, because a noisy diagonal sample mid-drag otherwise
 * freezes the element.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { haptic } from "@/utils/haptics";

import "./mv3-create.css";

/** The two snap points, as a fraction of viewport height. */
export const PEEK_DETENT = 0.42;
export const FULL_DETENT = 0.94;

/** Drag past this fraction below peek and the sheet dismisses. */
const DISMISS_SLOP = 0.7;
/** Movement under this is a tap, not a drag. */
const DRAG_LOCK_PX = 6;

export type Detent = "peek" | "full";

export interface CreateDetentSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the dialog. */
  label: string;
  detent: Detent;
  onDetentChange: (detent: Detent) => void;
  /**
   * When true the grab strip is inert and the sheet holds `full`. A pushed stage
   * owns the whole surface, and letting the user drag it down to peek would clip
   * the screen they navigated to.
   */
  lockFull?: boolean;
  children: React.ReactNode;
}

export function CreateDetentSheet({
  open,
  onClose,
  label,
  detent,
  onDetentChange,
  lockFull = false,
  children,
}: CreateDetentSheetProps) {
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number; locked: boolean } | null>(
    null,
  );

  /**
   * The height of the sheet's containing block, in px.
   *
   * Detent heights are interpolated in pixels rather than percentages. Both
   * render identically once settled, but px keeps one source of truth: the drag
   * already works in px (`dragHeight`), and mixing the two means the snap
   * comparison and the rendered height are computed from different units, which
   * is how a snap ends up one frame off from where the finger left it.
   *
   * The scrim is the probe: it is `position: fixed; inset: 0`, so its box IS the
   * containing block — the viewport in the app, the frame inside a transformed
   * phone wrapper — without this component needing to know which it is in.
   */
  const scrimRef = useRef<HTMLButtonElement>(null);
  const [containerH, setContainerH] = useState(0);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const h =
        scrimRef.current?.getBoundingClientRect().height ??
        (typeof window === "undefined" ? 0 : window.innerHeight);
      if (h > 0) setContainerH(h);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [open]);

  const targetFraction = lockFull || detent === "full" ? FULL_DETENT : PEEK_DETENT;

  // Escape closes, matching SheetShell.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // A detent change while the sheet is settled must not fight a stale drag.
  useEffect(() => {
    if (!open) setDragHeight(null);
  }, [open]);

  /** The measured containing block, with a sane fallback before first paint. */
  const viewportH = useCallback(
    () => containerH || (typeof window === "undefined" ? 800 : window.innerHeight),
    [containerH],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (lockFull) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startY: e.clientY,
        startH: targetFraction * viewportH(),
        locked: false,
      };
    },
    [lockFull, targetFraction, viewportH],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    // Lock once: past the threshold this gesture IS a drag for its whole life.
    if (!drag.locked) {
      if (Math.abs(dy) < DRAG_LOCK_PX) return;
      drag.locked = true;
    }
    // Dragging down (positive dy) shrinks the sheet.
    setDragHeight(Math.max(60, drag.startH - dy));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const height = dragHeight;
      setDragHeight(null);
      if (!drag?.locked || height === null) {
        // A tap on the grabber toggles — the fastest way to the full list.
        if (drag && !drag.locked) {
          haptic.light();
          onDetentChange(detent === "peek" ? "full" : "peek");
        }
        return;
      }
      const fraction = height / viewportH();
      if (fraction < PEEK_DETENT * DISMISS_SLOP) {
        haptic.light();
        onClose();
        return;
      }
      // Snap to whichever detent the release is nearer.
      const next: Detent =
        Math.abs(fraction - FULL_DETENT) < Math.abs(fraction - PEEK_DETENT)
          ? "full"
          : "peek";
      haptic.light();
      onDetentChange(next);
    },
    [dragHeight, detent, onClose, onDetentChange, viewportH],
  );

  if (!open) return null;

  // Always px — see the note on `containerH`. Before the first measurement the
  // sheet renders at its target fraction of the window, which is right in the
  // app and close enough for one frame anywhere else.
  const height = `${Math.round(dragHeight ?? targetFraction * viewportH())}px`;

  return (
    <div className="mv3c" data-mv3>
      <button
        ref={scrimRef}
        type="button"
        aria-label="Close"
        className="mv3c-scrim"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="mv3c-sheet"
        data-dragging={dragHeight !== null ? "true" : "false"}
        data-detent={lockFull ? "full" : detent}
        style={{ height }}
      >
        <button
          type="button"
          className="mv3c-grabstrip"
          // The strip is a real control: it toggles detent on tap and drags
          // between them, so it carries a label rather than being decoration.
          aria-label={
            detent === "peek" ? "Expand Create" : "Collapse Create"
          }
          disabled={lockFull}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="mv3c-grabber" />
        </button>
        {children}
      </div>
    </div>
  );
}
