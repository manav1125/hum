/**
 * SwipeArchiveRow — gap frame 48's row-density mechanics, shared by the
 * All-work list and project-detail task rows.
 *
 * The RULE at 390px: rows keep only the chevron — the inline ✕ is gone.
 * · Dismiss = swipe-LEFT revealing an 88pt Archive action; releasing past the
 *   threshold (a full swipe) commits. Mechanics reuse the came-in triage
 *   card's pointer-driven drag (translateX + spring-back, .light tick at the
 *   threshold, .medium on commit) — one direction only.
 * · Long-press (~480ms, cancelled by movement) opens the task context menu —
 *   callers wire it to the existing task sheet (▶ Have Cue handle it ·
 *   📁 File · ✓ Done elsewhere · ✕ Archive). Desktop right-click maps to the
 *   same handler.
 * · Plain tap still opens the row's natural surface (`onOpen`).
 */
import type React from "react";
import { useRef, useState } from "react";

import { haptic } from "@/utils/haptics";

const ARCHIVE_W = 88;
const SWIPE_MAX = 120;
const LONG_PRESS_MS = 480;

export function SwipeArchiveRow({
  title,
  onArchive,
  onLongPress,
  onOpen,
  radius = 16,
  rowStyle,
  containerStyle,
  children,
}: {
  /** Task title, for the accessible labels. */
  title: string;
  /** Commit archive (the caller animates removal via its dismiss flow). */
  onArchive: () => void;
  /** Long-press / right-click → the task context menu. */
  onLongPress: () => void;
  /** Plain tap → the row's natural surface. */
  onOpen: () => void;
  radius?: number;
  /** Styles for the draggable row surface (bg, border, padding…). */
  rowStyle?: React.CSSProperties;
  /** Styles for the clipping container (rise/leave animations live here). */
  containerStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dx = useRef(0);
  const crossed = useRef(false);
  const dragging = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const [reveal, setReveal] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const setX = (x: number, animate: boolean) => {
    const el = cardRef.current;
    if (!el) return;
    el.style.transition = animate
      ? "transform .28s cubic-bezier(.2,.8,.2,1)"
      : "none";
    el.style.transform = `translateX(${x}px)`;
  };

  const clearLongPress = () => {
    if (longPressTimer.current != null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (leaving) return;
    start.current = { x: e.clientX, y: e.clientY };
    dx.current = 0;
    crossed.current = false;
    dragging.current = false;
    suppressClick.current = false;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      // Movement cancels the press (checked continuously in onPointerMove).
      suppressClick.current = true;
      haptic.medium();
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current || leaving) return;
    const rawDx = e.clientX - start.current.x;
    const rawDy = e.clientY - start.current.y;
    // Any real movement cancels the long-press.
    if (Math.abs(rawDx) > 8 || Math.abs(rawDy) > 8) clearLongPress();
    if (Math.abs(rawDx) < 6 || Math.abs(rawDy) > Math.abs(rawDx)) return;
    // Horizontal intent — capture so vertical scroll doesn't fight the swipe.
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* inactive pointer (synthetic/stale) — drag still tracks fine */
    }
    dragging.current = true;
    // Left-only (frame 48): rightward drags rubber-band at 0.
    const clamped = Math.max(-SWIPE_MAX, Math.min(0, rawDx));
    dx.current = clamped;
    setX(clamped, false);
    setReveal(clamped < -8);
    const isPast = clamped <= -ARCHIVE_W;
    if (isPast !== crossed.current) {
      crossed.current = isPast;
      haptic.light();
    }
  };

  const commit = () => {
    haptic.medium();
    setLeaving(true);
    setReveal(true);
    setX(-(cardRef.current?.offsetWidth ?? 360) * 1.1, true);
    window.setTimeout(() => onArchive(), 200);
  };

  const onPointerEnd = () => {
    clearLongPress();
    if (!start.current || leaving) return;
    start.current = null;
    if (dragging.current) suppressClick.current = true;
    if (dx.current <= -ARCHIVE_W) commit();
    else {
      setX(0, true);
      setReveal(false);
    }
    dx.current = 0;
  };

  return (
    <div
      style={{
        position: "relative",
        borderRadius: radius,
        overflow: "hidden",
        ...containerStyle,
      }}
    >
      {/* Archive reveal — the 88pt action layer (frame 48). */}
      {reveal ? (
        <button
          type="button"
          aria-label={`Archive: ${title}`}
          onClick={commit}
          style={{
            position: "absolute",
            inset: 0,
            background:
              "color-mix(in srgb, var(--mv3-text) 14%, var(--mv3-bg))",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingRight: (ARCHIVE_W - 52) / 2,
            border: "none",
            cursor: "pointer",
            borderRadius: radius,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--mv3-muted)",
              fontFamily: "var(--mv3-font)",
            }}
          >
            Archive
          </span>
        </button>
      ) : null}

      {/* The row itself — dragged. */}
      <div
        ref={cardRef}
        role="button"
        tabIndex={0}
        className="cue-pressable"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          onOpen();
        }}
        onContextMenu={(e) => {
          // Desktop right-click = the same context menu as long-press.
          e.preventDefault();
          suppressClick.current = true;
          onLongPress();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        style={{
          position: "relative",
          touchAction: "pan-y",
          cursor: "pointer",
          borderRadius: radius,
          ...rowStyle,
          // Solid-enough canvas while the reveal is exposed so the Archive
          // layer never bleeds through translucent card tints (came-in trick;
          // AFTER rowStyle so it wins over the caller's translucent bg).
          ...(reveal
            ? {
                background:
                  "linear-gradient(var(--mv3-card), var(--mv3-card)), var(--mv3-bg)",
              }
            : {}),
        }}
      >
        {children}
      </div>
    </div>
  );
}
