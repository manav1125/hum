import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../utils/cn";
import { usePortalContainer } from "../utils/portal-container";
import { Button } from "./button";
import { Typography } from "./typography";

/**
 * `Coachmark` — a single guided first-step tip ("coach mark") anchored to an
 * existing element on the page.
 *
 * It spotlights a target (a soft ring + a dimmed surround drawn with the
 * classic huge-spread box-shadow, so nothing else needs a full-screen
 * backdrop), then floats a titled tip card beside it with "Got it" / "Next" /
 * "Skip tour" affordances.
 *
 * Design intent — calm, not nagware:
 *   - The dim is purely visual (`pointer-events: none`); the highlighted
 *     target stays clickable, and clicking it counts as acknowledging the tip.
 *   - Keyboard focus is trapped inside the card while open, Escape dismisses,
 *     and focus is restored to wherever it was on close.
 *   - Entrance motion is gated behind `motion-safe:` so
 *     `prefers-reduced-motion` users get an instant, static card.
 *
 * Positioning is self-contained (no Radix Popper) because targets are found at
 * runtime by attribute rather than wrapped as React children: the card is
 * placed on the preferred `side`, flips when it would overflow, and is clamped
 * into the viewport with a safe margin. Everything is theme-token-driven so it
 * tracks `data-theme` (light / dark / velvet).
 *
 * The gating (show-once, tour sequencing) lives in the consuming app's
 * `useFeatureTour` hook — this component is a pure, controlled presenter.
 */

export type CoachmarkSide = "top" | "bottom" | "left" | "right";
export type CoachmarkAlign = "start" | "center" | "end";

export interface CoachmarkProps {
  /** Whether the tip is shown. When false (or `target` is null) renders null. */
  open: boolean;
  /** The element the tip points at. Null until the target mounts. */
  target: HTMLElement | null;
  title: ReactNode;
  /** Tip body — keep it to one calm sentence. */
  children: ReactNode;
  /** Preferred placement; flips automatically when it would overflow. */
  side?: CoachmarkSide;
  align?: CoachmarkAlign;
  /** 0-based position within a multi-step tour (drives the "N of M" dots). */
  stepIndex?: number;
  /** Total steps in the tour. Omit or `1` for a standalone tip. */
  stepCount?: number;
  /**
   * When provided, the primary button reads "Next" and advances the tour.
   * Omit on the final (or only) step so the primary finishes via `onDismiss`.
   */
  onNext?: () => void;
  /** When provided, a "Skip tour" affordance ends the whole tour. */
  onSkip?: () => void;
  /** Fires on the finishing primary, the close "×", Escape, or target click. */
  onDismiss: () => void;
  /** Override the primary label. Defaults to "Next" (multi) or "Got it". */
  primaryLabel?: string;
  /** Extra padding around the spotlight ring, in px. Default 6. */
  spotlightPadding?: number;
  /** Corner radius of the spotlight ring, in px. Default 12. */
  spotlightRadius?: number;
  className?: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const VIEWPORT_MARGIN = 12;
const TARGET_OFFSET = 12;
const CARD_WIDTH = 300;

function readRect(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Resolve the card's top-left given the target rect, the measured card size,
 * and the preferred side/align. Flips to the opposite side when the preferred
 * one would overflow, then clamps into the viewport.
 */
function placeCard(
  target: Rect,
  card: { width: number; height: number },
  side: CoachmarkSide,
  align: CoachmarkAlign,
): { top: number; left: number; side: CoachmarkSide } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const fits = (s: CoachmarkSide): boolean => {
    if (s === "bottom")
      return target.top + target.height + TARGET_OFFSET + card.height <= vh - VIEWPORT_MARGIN;
    if (s === "top") return target.top - TARGET_OFFSET - card.height >= VIEWPORT_MARGIN;
    if (s === "right")
      return target.left + target.width + TARGET_OFFSET + card.width <= vw - VIEWPORT_MARGIN;
    return target.left - TARGET_OFFSET - card.width >= VIEWPORT_MARGIN;
  };

  const opposite: Record<CoachmarkSide, CoachmarkSide> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };
  const resolved = fits(side) ? side : fits(opposite[side]) ? opposite[side] : side;

  let top = 0;
  let left = 0;
  if (resolved === "bottom" || resolved === "top") {
    top =
      resolved === "bottom"
        ? target.top + target.height + TARGET_OFFSET
        : target.top - TARGET_OFFSET - card.height;
    const anchorLeft =
      align === "start"
        ? target.left
        : align === "end"
          ? target.left + target.width - card.width
          : target.left + target.width / 2 - card.width / 2;
    left = anchorLeft;
  } else {
    left =
      resolved === "right"
        ? target.left + target.width + TARGET_OFFSET
        : target.left - TARGET_OFFSET - card.width;
    const anchorTop =
      align === "start"
        ? target.top
        : align === "end"
          ? target.top + target.height - card.height
          : target.top + target.height / 2 - card.height / 2;
    top = anchorTop;
  }

  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - card.width - VIEWPORT_MARGIN));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - card.height - VIEWPORT_MARGIN));
  return { top, left, side: resolved };
}

export function Coachmark({
  open,
  target,
  title,
  children,
  side = "bottom",
  align = "center",
  stepIndex = 0,
  stepCount = 1,
  onNext,
  onSkip,
  onDismiss,
  primaryLabel,
  spotlightPadding = 6,
  spotlightRadius = 12,
  className,
}: CoachmarkProps) {
  const portalContainer = usePortalContainer();
  const cardRef = useRef<HTMLDivElement>(null);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    side: CoachmarkSide;
  } | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const active = open && target != null;

  // Track the target's on-screen rect, following scroll / resize / layout
  // shifts so the spotlight and card stay glued to it.
  useLayoutEffect(() => {
    if (!active || !target) {
      setTargetRect(null);
      return;
    }
    const update = () => setTargetRect(readRect(target));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(target);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [active, target]);

  // Position the card once its size is known (and whenever the target moves).
  useLayoutEffect(() => {
    if (!active || !targetRect || !cardRef.current) {
      setPlacement(null);
      return;
    }
    const rect = cardRef.current.getBoundingClientRect();
    setPlacement(
      placeCard(
        targetRect,
        { width: rect.width || CARD_WIDTH, height: rect.height },
        side,
        align,
      ),
    );
  }, [active, targetRect, side, align, title, children]);

  // Focus management: trap Tab within the card, Escape dismisses, restore
  // focus on close.
  useEffect(() => {
    if (!active) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      restoreFocusRef.current?.focus?.();
    };
  }, [active]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables || focusables.length === 0) return;
      const list = Array.from(focusables);
      const first = list[0];
      const last = list[list.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onDismiss],
  );

  // Clicking the spotlighted target itself acknowledges the tip.
  useEffect(() => {
    if (!active || !target) return;
    const onClick = () => onDismiss();
    target.addEventListener("click", onClick);
    return () => target.removeEventListener("click", onClick);
  }, [active, target, onDismiss]);

  if (!active || !targetRect) return null;

  const isLast = stepIndex >= stepCount - 1;
  const advances = onNext != null && !isLast;
  const resolvedPrimaryLabel = primaryLabel ?? (advances ? "Next" : "Got it");
  const primaryAction = advances ? onNext : onDismiss;

  const content = (
    <div
      className="fixed inset-0 z-[70]"
      style={{ pointerEvents: "none" }}
      data-slot="coachmark-layer"
    >
      {/* Spotlight ring + dimmed surround (drawn as a single box-shadow so no
          full-screen element intercepts pointer events). */}
      <div
        aria-hidden
        className="absolute motion-safe:transition-all motion-safe:duration-200"
        style={{
          top: targetRect.top - spotlightPadding,
          left: targetRect.left - spotlightPadding,
          width: targetRect.width + spotlightPadding * 2,
          height: targetRect.height + spotlightPadding * 2,
          borderRadius: spotlightRadius,
          boxShadow:
            "0 0 0 9999px color-mix(in srgb, var(--primary-base) 42%, transparent), 0 0 0 2px var(--accent-cue) inset",
          pointerEvents: "none",
        }}
      />

      {/* Tip card */}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="coachmark-title"
        onKeyDown={handleKeyDown}
        className={cn(
          "absolute w-[300px] max-w-[calc(100vw-24px)] rounded-xl border p-4",
          "border-[var(--border-base)] bg-[var(--surface-lift)] shadow-[var(--shadow-popover)]",
          "motion-safe:animate-[popoverIn_140ms_ease-out]",
          className,
        )}
        style={{
          top: placement?.top ?? -9999,
          left: placement?.left ?? -9999,
          visibility: placement ? "visible" : "hidden",
          pointerEvents: "auto",
        }}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss tip"
          className={cn(
            "absolute right-2.5 top-2.5 cursor-pointer rounded bg-transparent p-0.5",
            "text-[color:var(--content-secondary)] opacity-70 transition-opacity",
            "hover:opacity-100 keyboard-focus:outline-none keyboard-focus:ring-2",
            "keyboard-focus:ring-[var(--ring)]",
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>

        <Typography
          id="coachmark-title"
          variant="body-medium-default"
          as="p"
          className="pr-5 text-[color:var(--content-emphasised)]"
        >
          {title}
        </Typography>
        <Typography
          variant="body-small-default"
          as="p"
          className="mt-1 text-[color:var(--content-secondary)]"
        >
          {children}
        </Typography>

        <div className="mt-3.5 flex items-center justify-between gap-3">
          {stepCount > 1 ? (
            <div
              className="flex items-center gap-1.5"
              role="group"
              aria-label={`Step ${stepIndex + 1} of ${stepCount}`}
            >
              {Array.from({ length: stepCount }).map((_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="h-1.5 rounded-full transition-all"
                  style={{
                    width: i === stepIndex ? 14 : 6,
                    background:
                      i === stepIndex
                        ? "var(--accent-cue)"
                        : "var(--border-element)",
                  }}
                />
              ))}
            </div>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {onSkip ? (
              <Button variant="ghost" size="compact" onClick={onSkip}>
                Skip tour
              </Button>
            ) : null}
            <Button variant="primary" size="compact" onClick={primaryAction}>
              {resolvedPrimaryLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, portalContainer ?? document.body);
}
