/**
 * SheetShell — the mv3 iOS sheet grammar (built now as a primitive; the
 * Create-sheet and consent-sheet conversions are later phases).
 *
 * Spec values (frames 3/7/18): sheet material rgba(22,26,36,.85) dark /
 * light per token, top radius 28, hairline top border, blur(24px), and the
 * 40×5 grabber pill (rgba(255,255,255,.22) dark). Entrance is transform-only
 * (translateY) with an opacity fade on the scrim; reduced-motion collapses
 * to fades via the shared `[data-mv3]` freeze + the pre-positioned resting
 * state.
 *
 * Portals into `#viewport-overlays` (the root layout's fixed-overlay slot).
 */
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { haptic } from "@/utils/haptics";

import { useMv3EntranceGuard } from "./entrance-guard";

/* --------------------------- open-sheet registry --------------------------- */

/**
 * Tiny module-level registry of mounted-open SheetShells, so overlays that
 * must OUTLIVE a sheet (gap frame 47: the undo pill promotes to a top capsule
 * whenever any scrim is up) can subscribe without prop-drilling. Counts, not
 * booleans — stacked sheets (task sheet → refile sheet) keep it truthy.
 */
let openSheetCount = 0;
const sheetListeners = new Set<() => void>();

function notifySheetListeners() {
  for (const l of sheetListeners) l();
}

function subscribeSheets(listener: () => void): () => void {
  sheetListeners.add(listener);
  return () => sheetListeners.delete(listener);
}

const getSheetCount = () => openSheetCount;

/** True while any SheetShell scrim is open (frame 47's stacking rule). */
export function useAnySheetOpen(): boolean {
  return useSyncExternalStore(subscribeSheets, getSheetCount) > 0;
}

export function SheetShell({
  open,
  onClose,
  children,
  label,
  maxHeight = "86%",
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Accessible name for the dialog. */
  label: string;
  maxHeight?: string | number;
}) {
  // Sheets portal outside the screen container, so they carry their own
  // entrance guard (the sheet-in/fade keyframes share the stuck-pending risk).
  useMv3EntranceGuard();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Register with the open-sheet registry while the scrim is up (frame 47).
  useEffect(() => {
    if (!open) return;
    openSheetCount += 1;
    notifySheetListeners();
    return () => {
      openSheetCount -= 1;
      notifySheetListeners();
    };
  }, [open]);

  if (!open) return null;

  const host =
    document.getElementById("viewport-overlays") ?? document.body;

  return createPortal(
    <div
      data-mv3
      role="dialog"
      aria-modal="true"
      aria-label={label}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        fontFamily: "var(--mv3-font)",
        color: "var(--mv3-text)",
      }}
    >
      {/* Scrim — tap to dismiss. */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          haptic.light();
          onClose();
        }}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,.5)",
          border: "none",
          padding: 0,
          cursor: "pointer",
          animation: "mv3Fade .25s ease both",
        }}
      />
      <div
        style={{
          position: "relative",
          maxHeight,
          display: "flex",
          flexDirection: "column",
          background: "var(--mv3-sheet)",
          borderRadius: "28px 28px 0 0",
          borderTop: "1px solid var(--mv3-sheet-border)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          padding: "10px 18px calc(14px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
          animation: "mv3SheetIn .34s cubic-bezier(.2,.8,.2,1) both",
        }}
      >
        {/* Grabber. */}
        <span
          aria-hidden
          style={{
            width: 40,
            height: 5,
            borderRadius: 99,
            background: "var(--mv3-grabber)",
            margin: "0 auto 14px",
            flexShrink: 0,
          }}
        />
        <div style={{ minHeight: 0, overflowY: "auto" }}>{children}</div>
      </div>
    </div>,
    host,
  );
}
