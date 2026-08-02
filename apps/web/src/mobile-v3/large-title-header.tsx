/**
 * LargeTitleHeader — iOS large-title physics for mv3 screens.
 *
 * A large left-aligned title (spec: 29px/700, −0.8px tracking) that condenses
 * into a compact centered title as the associated scroll container scrolls.
 * Implementation notes:
 *   · transform/opacity ONLY — the compact title fades/slides in and the
 *     large title fades/slides out; nothing re-layouts per frame.
 *   · scroll handling writes to element styles directly through rAF (no
 *     React re-render per scroll tick).
 *   · reduced-motion: handled naturally — values are driven by scroll
 *     position (direct manipulation), not by autonomous animation, which
 *     iOS itself keeps under reduced motion. No timed animation is used.
 *
 * Usage: pass the scrollable element via `scrollRef` (the mv3 screen's
 * card-stack scroller). The header itself stays outside the scroller
 * (spec's Today keeps header + hero fixed above the stack).
 */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import {
  CORNER_CHROME_BAND,
  CORNER_CHROME_INSET,
  overflowVisible,
} from "./corner-chrome";

/** Scroll distance (px) over which the large title hands off to the compact one. */
const CONDENSE_RANGE = 44;

export function LargeTitleHeader({
  eyebrow,
  title,
  trailing,
  scrollRef,
}: {
  /** Mono microlabel row above the title (e.g. "SATURDAY · JUL 19"). */
  eyebrow?: React.ReactNode;
  title: string;
  /** Right-aligned ornament on the eyebrow row (e.g. the avatar chip). */
  trailing?: React.ReactNode;
  /** The scroll container whose offset drives the condense. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const largeRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLDivElement>(null);
  const eyebrowRef = useRef<HTMLDivElement>(null);
  // Whether the fixed ☰ / avatar buttons are painted over this header. Read
  // from the route rather than taken as a prop — see `corner-chrome.ts`: a
  // prop is a thing each new screen can forget, and two screens forgot.
  const underCornerChrome = overflowVisible(useLocation().pathname);

  useEffect(() => {
    const scroller = scrollRef?.current;
    if (!scroller) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const y = scroller.scrollTop;
      const t = Math.min(1, Math.max(0, y / CONDENSE_RANGE));
      const large = largeRef.current;
      const compact = compactRef.current;
      if (large) {
        large.style.opacity = String(1 - t);
        large.style.transform = `translateY(${-6 * t}px)`;
      }
      if (compact) {
        compact.style.opacity = String(t);
        compact.style.transform = `translateY(${(1 - t) * 6}px)`;
      }
      // The eyebrow yields to the compact centered title (it would overlap).
      const eyebrow = eyebrowRef.current;
      if (eyebrow) eyebrow.style.opacity = String(1 - t);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    apply();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  return (
    <div
      data-mv3
      style={{
        // Top inset: with the legacy mobile header hidden, v3 screens own the
        // area under the status bar / Dynamic Island. The bridge-provided
        // var wins on device; env() covers plain browsers.
        padding:
          "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 6px) 22px 0",
        flexShrink: 0,
        position: "relative",
        zIndex: 2,
        fontFamily: "var(--mv3-font)",
        color: "var(--mv3-text)",
      }}
    >
      {/* Compact centered title — hidden until the scroller condenses. */}
      <div
        ref={compactRef}
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          // Mirrors the padded top inset — absolute position is measured from
          // the border box, so the inset must be re-added here. Under the
          // corner chrome the condensed title centres INSIDE the button band
          // (iOS nav-bar grammar) instead of above it.
          top: `calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + ${
            underCornerChrome ? 14 : 4
          }px)`,
          // ...and keeps clear of both buttons, so a long title truncates
          // rather than sliding under them.
          paddingLeft: underCornerChrome ? CORNER_CHROME_INSET : 0,
          paddingRight: underCornerChrome ? CORNER_CHROME_INSET : 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textAlign: "center",
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: "-0.3px",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        {title}
      </div>

      {/* The eyebrow row doubles as the nav band. With the corner chrome above,
          it holds the buttons' height open (even with no eyebrow to show) so
          the large title below starts clear of them — the Work screen used to
          render its title as "☰ork" — and insets its own content so an eyebrow
          does not slide under them either. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: underCornerChrome ? CORNER_CHROME_BAND : undefined,
          paddingLeft: underCornerChrome ? CORNER_CHROME_INSET : 0,
          paddingRight: underCornerChrome ? CORNER_CHROME_INSET : 0,
        }}
      >
        {eyebrow ? (
          <div
            ref={eyebrowRef}
            style={{
              fontFamily: "var(--mv3-mono)",
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--mv3-micro)",
            }}
          >
            {eyebrow}
          </div>
        ) : (
          <span />
        )}
        {trailing ?? null}
      </div>

      <div
        ref={largeRef}
        style={{
          fontSize: 29,
          fontWeight: 700,
          letterSpacing: "-0.8px",
          marginTop: 4,
          lineHeight: 1.08,
        }}
      >
        {title}
      </div>
    </div>
  );
}
